//! Managed yt-dlp binary lifecycle.
//!
//! End users don't have yt-dlp on PATH, so the app owns its copy: the
//! official single-file release is downloaded into
//! `<app-data>/bin/yt-dlp.exe` on first run and held at `PINNED_VERSION`
//! on a 72-hour cadence (or self-updated via `yt-dlp -U` when unpinned).
//! The managed copy is canonical — PATH is only a fallback for dev
//! machines while the download hasn't happened (or failed).
//!
//! Streaming resilience depends on this: YouTube regularly breaks
//! extractors and yt-dlp ships fixes within days, so the binary must
//! update on its own schedule, not the app's release schedule. The
//! exception is a release that breaks format selection outright — see
//! `PINNED_VERSION`, which exists to stop an unattended update from
//! quietly degrading playback.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[cfg(windows)]
const BINARY_NAME: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const BINARY_NAME: &str = "yt-dlp";

/// Official single-file builds. The `latest/download/` URL redirects to
/// the newest release asset, so no GitHub API call (and no rate limit)
/// is involved.
#[cfg(windows)]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

/// Version the managed binary is held at, or `None` to track latest.
///
/// Pinned to 2026.07.04 because newer builds require a GVS PO token for
/// every `android_vr` format except itag 18. Measured on master: the
/// audio path drops from format 140 to a 360p muxed file, and
/// `vonly_format()`'s VP9/avc1 rungs disappear entirely — so an
/// unattended `-U` silently degrades playback to 360p.
///
/// Lift this once a PO token provider (e.g. bgutil-ytdlp-pot-provider)
/// is wired in; the extractor fixes past this version are worth having.
const PINNED_VERSION: Option<&str> = Some("2026.07.04");

/// How often to let the managed binary check for its own update.
const UPDATE_INTERVAL: Duration = Duration::from_secs(72 * 60 * 60);
/// Hard cap on the `-U` self-update run.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(180);
/// Hard cap on the first-run download (the exe is ~12 MB).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the managed binary lives for this install.
pub fn managed_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
        .join(BINARY_NAME)
}

/// Program to spawn: the managed copy when present, otherwise bare
/// `yt-dlp` so PATH still works on dev machines. Resolved at every
/// spawn (not cached) so a download finishing mid-session takes effect
/// on the next track without a restart.
pub fn program(managed: &Path) -> PathBuf {
    if managed.exists() {
        managed.to_path_buf()
    } else {
        PathBuf::from("yt-dlp")
    }
}

fn emit_state(app: &tauri::AppHandle, phase: &str, message: Option<String>) {
    let _ = app.emit(
        "ytdlp-state",
        serde_json::json!({ "phase": phase, "message": message }),
    );
}

/// Idempotent "make yt-dlp available" entry point. Called from the
/// frontend on every launch (so the webview's event listener is
/// guaranteed to be mounted before any state event fires) and safe to
/// re-invoke as a retry after a failed download.
///
/// Emits `ytdlp-state` events: `downloading` → `ready` | `error`.
pub async fn ensure(app: tauri::AppHandle) {
    // Serialize concurrent calls (StrictMode double-mount, retry spam).
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    let managed = managed_path(&app);

    if managed.exists() {
        // Reconcile the pin BEFORE the throttled update path. A binary
        // that is already the wrong version must not get to serve tracks
        // for up to UPDATE_INTERVAL just because its stamp is fresh —
        // and the stamp is fresh on exactly the install that just
        // downloaded `releases/latest`.
        reconcile_pin(&managed).await;
        emit_state(&app, "ready", None);
        maybe_self_update(&managed).await;
        return;
    }

    // Dev fallback: a working PATH install means we can play right now.
    // Still fetch the managed copy in the background so this install
    // stops depending on the machine's PATH from the next launch on.
    let path_works = probe_path_install().await;
    if path_works {
        emit_state(&app, "ready", None);
    } else {
        emit_state(&app, "downloading", None);
    }

    match download(&managed).await {
        Ok(()) => {
            eprintln!("[ytdlp] downloaded managed binary to {managed:?}");
            // The download URL is `releases/latest`, so a fresh install
            // lands on whatever shipped most recently — which is the one
            // thing the pin exists to prevent. Correct it before this
            // binary is ever used, not 72 hours later.
            reconcile_pin(&managed).await;
            touch_update_stamp(&managed);
            emit_state(&app, "ready", None);
        }
        Err(e) => {
            eprintln!("[ytdlp] download failed: {e}");
            if !path_works {
                emit_state(&app, "error", Some(e));
            }
        }
    }
}

/// Report the managed binary's own version string, or None if it
/// cannot be asked.
async fn managed_version(managed: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(managed);
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

/// Force the managed binary onto `PINNED_VERSION` when it is something
/// else, ignoring the update throttle entirely.
///
/// This is the half of pinning that `maybe_self_update` cannot do. The
/// first-run download fetches `releases/latest`, and the update path is
/// rate-limited by a stamp that the download itself just refreshed, so
/// without this a new install would run the newest release — precisely
/// the version the pin exists to avoid — until the throttle expired.
async fn reconcile_pin(managed: &Path) {
    let Some(want) = PINNED_VERSION else { return };
    let Some(have) = managed_version(managed).await else {
        eprintln!("[ytdlp] pin: could not read version, leaving binary alone");
        return;
    };
    if have == want {
        return;
    }
    eprintln!("[ytdlp] pin: have {have}, want {want} — correcting");

    let mut cmd = tokio::process::Command::new(managed);
    cmd.arg("--update-to");
    cmd.arg(format!("stable@{want}"));
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let run = async {
        match cmd.output().await {
            Ok(out) => {
                let s = String::from_utf8_lossy(&out.stdout);
                let line = s.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
                eprintln!("[ytdlp] pin ({}): {line}", out.status);
            }
            Err(e) => eprintln!("[ytdlp] pin spawn failed: {e}"),
        }
    };
    if tokio::time::timeout(UPDATE_TIMEOUT, run).await.is_err() {
        eprintln!("[ytdlp] pin timed out");
    }
    // Say plainly whether it worked; a silent failure here means the app
    // is running an unvetted extractor policy.
    match managed_version(managed).await {
        Some(v) if v == want => eprintln!("[ytdlp] pin: now at {v}"),
        Some(v) => eprintln!("[ytdlp] pin: STILL at {v}, wanted {want}"),
        None => eprintln!("[ytdlp] pin: version unreadable after correction"),
    }
}

/// True when a bare `yt-dlp --version` spawn succeeds (PATH install).
async fn probe_path_install() -> bool {
    let mut cmd = tokio::process::Command::new("yt-dlp");
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    match cmd.status().await {
        Ok(s) => s.success(),
        Err(_) => false,
    }
}

/// Fetch the official binary into `<managed>.part`, then rename. The
/// .part indirection means a torn download never masquerades as a
/// working binary.
async fn download(managed: &Path) -> Result<(), String> {
    if let Some(dir) = managed.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    }
    let part = managed.with_extension("part");
    let _ = tokio::fs::remove_file(&part).await;

    let fetch = async {
        let resp = reqwest::get(DOWNLOAD_URL)
            .await
            .map_err(|e| format!("request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("http: {e}"))?;
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("create {part:?}: {e}"))?;
        let mut stream = resp;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| format!("read body: {e}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write: {e}"))?;
        }
        file.flush().await.map_err(|e| format!("flush: {e}"))?;
        Ok::<(), String>(())
    };

    match tokio::time::timeout(DOWNLOAD_TIMEOUT, fetch).await {
        Err(_) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("download timed out".into());
        }
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        Ok(Ok(())) => {}
    }

    // Sanity floor: the real exe is ~12 MB; a tiny payload is an error
    // page or a truncated body, not yt-dlp.
    const MIN_BINARY_BYTES: u64 = 1024 * 1024;
    let size = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if size < MIN_BINARY_BYTES {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("downloaded file too small ({size} bytes)"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(
            &part,
            std::fs::Permissions::from_mode(0o755),
        )
        .await;
    }

    tokio::fs::rename(&part, managed)
        .await
        .map_err(|e| format!("rename: {e}"))
}

fn update_stamp_path(managed: &Path) -> PathBuf {
    managed.with_file_name("last-update-check")
}

fn touch_update_stamp(managed: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(update_stamp_path(managed), now.to_string());
}

fn update_stamp_age(managed: &Path) -> Option<Duration> {
    let raw = std::fs::read_to_string(update_stamp_path(managed)).ok()?;
    let then = raw.trim().parse::<u64>().ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(Duration::from_secs(now.saturating_sub(then)))
}

/// Run `yt-dlp -U` on the managed copy when the last check is older
/// than `UPDATE_INTERVAL`. The official release binary replaces itself
/// in place. The stamp is refreshed even on failure so a broken update
/// path can't turn into a retry storm on every launch.
async fn maybe_self_update(managed: &Path) {
    match update_stamp_age(managed) {
        Some(age) if age < UPDATE_INTERVAL => return,
        _ => {}
    }
    touch_update_stamp(managed);

    let mut cmd = tokio::process::Command::new(managed);
    match PINNED_VERSION {
        // `--update-to` holds the binary at an exact release: a no-op
        // when it already matches, a downgrade if something newer got
        // installed underneath us. That second case is the point — it
        // repairs a machine where the binary was replaced out of band.
        Some(v) => {
            cmd.arg("--update-to");
            cmd.arg(format!("stable@{v}"));
        }
        None => {
            cmd.arg("-U");
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // The timeout below drops the output() future — without this the
    // wedged child would outlive it as an orphan.
    cmd.kill_on_drop(true);

    let run = async {
        match cmd.output().await {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let line = stdout
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("");
                eprintln!("[ytdlp] self-update ({}): {line}", out.status);
            }
            Err(e) => eprintln!("[ytdlp] self-update spawn failed: {e}"),
        }
    };
    if tokio::time::timeout(UPDATE_TIMEOUT, run).await.is_err() {
        eprintln!("[ytdlp] self-update timed out");
    }
}
