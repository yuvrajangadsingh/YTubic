//! Range-proxy streaming for uncached tracks.
//!
//! The legacy path (spawn_downloader in lib.rs) blocks the HTTP response
//! until yt-dlp has downloaded the ENTIRE file, because two things made
//! progressive serving impossible at the time:
//!
//!   1. the total length was unknown mid-download, and a Range response
//!      with an unknown total (`Content-Range: bytes 0-*/*`) is
//!      grammatically invalid per RFC 7233;
//!   2. m4a tracks can carry the `moov` atom at the END of the file, so
//!      the decoder's very first read is a tail range we couldn't serve
//!      until the last byte had arrived.
//!
//! This module removes both constraints by resolving the direct
//! googlevideo URL first (`yt-dlp -j`, sub-second spawn since the onedir
//! migration) and probing it with a 1-byte range request: that yields the
//! EXACT total up front and validates that plain HTTPS byte-range access
//! works. From there:
//!
//!   - a background *filler* task downloads the file sequentially into
//!     the same `<id>.part` file the legacy path uses, renaming to the
//!     final cache name on completion (identical contract, so ServeFile,
//!     cache listing and eviction all keep working);
//!   - the HTTP handler serves bounded 206 windows immediately: from the
//!     `.part` file when the requested span is already on disk, and by
//!     fetching exactly that span from googlevideo when it isn't (which
//!     is how a tail `moov` probe gets answered seconds into a download);
//!   - requests with no Range header (WebKit fetches WebM with a single
//!     plain GET and never range-requests) get a 200 with the exact
//!     Content-Length whose body tails the `.part` file as the filler
//!     writes it.
//!
//! googlevideo URLs 403 transiently: measured Aug 11 2026, re-requesting
//! the SAME URL recovered 9/9 within three attempts, while re-resolving
//! got a fresh working URL in the remaining case. The filler and the
//! passthrough fetches therefore retry the current URL a few times with
//! backoff, and the filler re-resolves once before declaring failure.
//! Errors before a response is committed fall back to the legacy
//! blocking path in the caller. Mid-body failures on an already-started
//! response (a tailing 200, a partially-sent window) cannot fall back —
//! the transfer just breaks and the media element's own error handling
//! retries the request, which re-enters the normal decision chain.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify, OnceCell};

/// Largest span served by a single 206 response. Both AVFoundation and
/// Chromium treat a shorter-than-requested (but well-formed) 206 as an
/// invitation to issue a follow-up range request, so capping the window
/// bounds per-request memory and lets each follow-up re-decide between
/// disk and passthrough as the filler advances.
pub const WINDOW: u64 = 8 * 1024 * 1024;

/// A request whose span ends no more than this far past the filler's
/// high-water mark waits for the filler instead of double-downloading
/// the span via passthrough; a farther seek goes straight to
/// passthrough so seeking stays snappy.
const NEAR_GAP: u64 = 16 * 1024 * 1024;

/// How long a request may wait on filler progress (or a rangeless body
/// may wait for the next chunk) before giving up. The filler's own
/// per-chunk timeout is shorter, so a healthy-but-slow download keeps
/// resetting this.
const WAIT_BUDGET: Duration = Duration::from_secs(20);

/// Same floor as the legacy path: yt-dlp/YouTube can hand out a
/// storyboard-only stub; never treat something this small as a track.
const MIN_TOTAL: u64 = 32 * 1024;

/// Retry schedule for a 403/network error on the current signed URL.
const URL_RETRIES: u32 = 3;

/// Ceiling on one `yt-dlp -j` extraction. Generous against the measured
/// 5.0s median and 11.5s 90th percentile, because the alternative to
/// waiting is the legacy blocking path, which is slower still.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);

/// The timeout's error text. Compared exactly in `resolve` to tell a slow
/// extraction from a dead video, so keep the two in step.
const TIMED_OUT: &str = "yt-dlp -j timed out after 30s";

/// A prefetch that admission control deliberately declined. The handler
/// MUST tell this apart from a real failure: a real failure falls through
/// to the legacy blocking downloader, and sending a deliberate skip down
/// that path spawns the very yt-dlp the skip existed to prevent, which is
/// exactly what shipped on 2026-09-04 and defeated the cap on the one
/// path it was built for.
pub const SKIPPED: &str = "prefetch skipped: resolver busy";
/// Prefix shared by every timeout message, whatever the ceiling was.
const TIMED_OUT_PREFIX: &str = "yt-dlp -j timed out after";

/// Ceiling on the anonymous fallback that runs after a signed-in resolve
/// times out. Anonymous extraction skips the watch page and the JS
/// challenge and measured 2.0s; if it has not answered in 15s the
/// blocking path is the honest next step.
const FALLBACK_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a signed-in resolve may run before an anonymous one is
/// started alongside it (the hedge). 12s is the measured 90th percentile
/// of signed-in resolves, so about one fetched play in ten hedges; the
/// rest never notice. His call, 2026-09-04: 12 over 15.
const HEDGE_AFTER: Duration = Duration::from_secs(12);

/// Resolver admission. Plays go first; speculative work waits.
///
/// Measured 2026-09-04: a resolve that overlapped another resolve
/// exceeded 15s twice as often (9% vs 4.4%), and nothing capped how many
/// yt-dlp processes ran at once. Foreground resolves are never made to
/// wait, since a click behind a prefetch would be the worst outcome of
/// all. Background (prefetch) resolves take one slot between them and
/// hold off while any foreground resolve is running. A background wait is
/// bounded so a stuck foreground can never starve prefetch for ever.
static FOREGROUND_RESOLVES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
static BACKGROUND_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const BACKGROUND_MAX_WAIT: Duration = Duration::from_secs(45);

struct ForegroundGuard;
impl ForegroundGuard {
    fn enter() -> Self {
        FOREGROUND_RESOLVES.fetch_add(1, Ordering::SeqCst);
        ForegroundGuard
    }
}
impl Drop for ForegroundGuard {
    fn drop(&mut self) {
        FOREGROUND_RESOLVES.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Video ids a play is waiting on right now. A prefetch that is still
/// queued for admission when the user clicks the same track must not
/// keep waiting as background work: the click joined its single-flight
/// cell and inherits whatever priority the cell's initialiser has
/// (review finding, 2026-09-04). `stream_handler` marks the id before it
/// awaits the cell and clears it after; `admit_background` treats the
/// mark as its cue to stop waiting, and `prepare` then counts the resolve
/// as foreground.
static FOREGROUND_WAITING: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

pub fn foreground_waiting(video_id: &str, waiting: bool) {
    let mut set = FOREGROUND_WAITING
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if waiting {
        set.insert(video_id.to_string());
    } else {
        set.remove(video_id);
    }
}

fn foreground_wants(video_id: &str) -> bool {
    FOREGROUND_WAITING
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(video_id)
}

/// Outcome of background admission. `Skip` means the prefetch is not run
/// at all: the earlier version let a timed-out wait proceed WITHOUT a
/// permit, so every prefetch that had queued up for 45s then started
/// yt-dlp together, which is the overlap this exists to prevent.
enum Admission {
    Slot(tokio::sync::SemaphorePermit<'static>),
    /// A play for this id arrived while waiting: run it as foreground.
    Promoted,
    Skip,
}

/// Wait for the background slot, then for the foreground to go quiet.
async fn admit_background(video_id: &str) -> Admission {
    let started = std::time::Instant::now();
    let permit = loop {
        if foreground_wants(video_id) {
            return Admission::Promoted;
        }
        match tokio::time::timeout(Duration::from_millis(250), BACKGROUND_SLOT.acquire()).await {
            Ok(Ok(p)) => break p,
            Ok(Err(_)) => return Admission::Skip,
            Err(_) if started.elapsed() > BACKGROUND_MAX_WAIT => {
                eprintln!("[proxy] {video_id}: prefetch skipped, resolver busy for 45s");
                return Admission::Skip;
            }
            Err(_) => {}
        }
    };
    while FOREGROUND_RESOLVES.load(Ordering::SeqCst) > 0 {
        if foreground_wants(video_id) {
            drop(permit);
            return Admission::Promoted;
        }
        if started.elapsed() > BACKGROUND_MAX_WAIT {
            eprintln!("[proxy] {video_id}: prefetch skipped, foreground busy for 45s");
            return Admission::Skip;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let waited = started.elapsed();
    if waited > Duration::from_millis(500) {
        eprintln!(
            "[proxy] {video_id}: background resolve waited {:.1}s for the foreground",
            waited.as_secs_f32()
        );
    }
    Admission::Slot(permit)
}

/// Filler download chunk: one ranged request per chunk (see fill()).
const FILL_CHUNK: u64 = 10 * 1024 * 1024;

/// serve_span stops waiting for the filler and fetches its window
/// directly when the fill mark hasn't moved for this long.
const STALL: Duration = Duration::from_secs(2);

/// UA sent to googlevideo. Anonymous ranged playback from the resolving
/// IP is what YouTube itself relies on for <video> tags; a mainstream
/// browser UA keeps us inside that well-trodden path.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/// Everything the filler needs to re-resolve a fresh signed URL when
/// the current one dies mid-download.
#[derive(Clone)]
pub struct ResolveCtx {
    pub ytdlp_program: PathBuf,
    pub video_id: String,
    pub format: String,
    /// True for muxed/video-only variants — switches the mime top level.
    pub video: bool,
    /// Netscape cookie file for the signed-in user, when there is one.
    /// Without it the resolve runs anonymously, which caps audio at itag
    /// 140 (130k) and refuses Premium-only tracks outright — the exact
    /// state 0.4.2 shipped to fix. Applies to the mid-download
    /// re-resolve too: a refreshed URL for a 774/141 stream can only be
    /// minted by an authenticated extraction.
    pub cookies: Option<PathBuf>,
}

/// Shared state of one in-flight proxied download.
pub struct ProxyState {
    /// Current signed googlevideo URL. The filler refreshes it after a
    /// re-resolve; passthrough fetches always read the latest.
    pub url: Mutex<String>,
    /// Exact file size, learned from the 1-byte probe.
    pub total: u64,
    pub mime: String,
    /// yt-dlp format_id of the FIRST extraction. A mid-download
    /// re-resolve pins -f to this exact format so a selector fallback
    /// can't splice a different representation onto the written prefix.
    pub format_id: Option<String>,
    /// From the anonymous fallback after a signed-in timeout: served for
    /// this play, never kept as the canonical cached copy (see `fill`).
    pub degraded: bool,
    /// Bytes contiguously written to the .part file from offset 0.
    pub filled: AtomicU64,
    /// Final file renamed into place; `filled == total`.
    pub complete: AtomicBool,
    /// Filler gave up (retries and re-resolve exhausted).
    pub failed: AtomicBool,
    /// Fires on every filler write, on completion and on failure.
    pub notify: Notify,
}

impl ProxyState {
    fn new(
        url: String,
        total: u64,
        mime: String,
        format_id: Option<String>,
        degraded: bool,
    ) -> Self {
        ProxyState {
            url: Mutex::new(url),
            total,
            mime,
            format_id,
            degraded,
            filled: AtomicU64::new(0),
            complete: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
}

/// Resolve + probe + sanity floor: everything that must succeed before
/// a filler can start. Returns the ready-to-serve shared state.
pub async fn prepare(
    client: &reqwest::Client,
    ctx: &ResolveCtx,
    background: bool,
) -> Result<Arc<ProxyState>, String> {
    // Admission: see FOREGROUND_RESOLVES. A background (prefetch) resolve
    // takes the single background slot and yields to any play in flight;
    // a foreground resolve registers itself so background work holds off.
    let mut foreground = !background;
    let _permit = if background {
        match admit_background(&ctx.video_id).await {
            Admission::Slot(p) => Some(p),
            Admission::Promoted => {
                eprintln!(
                    "[proxy] {}: prefetch promoted, a play is waiting on it",
                    ctx.video_id
                );
                foreground = true;
                None
            }
            Admission::Skip => return Err(SKIPPED.to_string()),
        }
    } else {
        None
    };
    let _foreground = foreground.then(ForegroundGuard::enter);
    let resolved = resolve(ctx).await?;
    let total = probe_total(client, &resolved.url).await?;
    if total < MIN_TOTAL {
        return Err(format!("suspiciously small stream ({total} bytes)"));
    }
    Ok(Arc::new(ProxyState::new(
        resolved.url,
        total,
        resolved.mime,
        resolved.format_id,
        resolved.degraded,
    )))
}

/// Sidecar that marks a cached file as the anonymous fallback's output.
/// A file with this marker is deleted at the next launch, and by
/// `evict_degraded` whenever playback moves to another track, so the
/// next play of that track resolves signed-in again instead of replaying
/// the lower tier for ever.
pub fn degraded_marker(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(".degraded");
    PathBuf::from(s)
}

/// Delete every degraded cached file under `dir` except the one for
/// `keep` (the track playing right now, which must stay readable).
/// Returns how many were removed.
pub async fn evict_degraded(dir: &Path, keep: Option<&str>) -> usize {
    let mut removed = 0;
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return 0;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let marker = entry.path();
        let Some(name) = marker.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(file_name) = name.strip_suffix(".degraded") else {
            continue;
        };
        // Exact id, not a prefix: "abc" must not spare "abcdef.webm".
        let id = file_name
            .strip_suffix(".video.mp4")
            .or_else(|| file_name.strip_suffix(".webm"))
            .or_else(|| file_name.split(".vonly").next().filter(|_| file_name.contains(".vonly")))
            .unwrap_or(file_name);
        if keep.is_some_and(|k| k == id) {
            continue;
        }
        let file = dir.join(file_name);
        let _ = tokio::fs::remove_file(&file).await;
        let _ = tokio::fs::remove_file(&marker).await;
        removed += 1;
        eprintln!("[proxy] evicted degraded cache file {file_name}");
    }
    removed
}

/// Map of in-flight proxy downloads, keyed like the legacy downloads
/// map. The OnceCell gives per-key single-flight on the (slow) resolve
/// + probe: concurrent requests for the same key await one init, and a
/// failed init leaves the cell empty so a later request may retry.
pub type ProxyMap = Arc<Mutex<HashMap<String, Arc<OnceCell<Arc<ProxyState>>>>>>;

pub fn new_proxy_map() -> ProxyMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn new_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(UA)
        .build()
        .expect("reqwest client")
}

// ---------------------------------------------------------------------
// Resolve + probe
// ---------------------------------------------------------------------

struct Resolved {
    url: String,
    mime: String,
    format_id: Option<String>,
    /// Came from the anonymous fallback after the signed-in path timed
    /// out: a lower tier than the account is entitled to, and not to be
    /// kept as the canonical cached copy.
    degraded: bool,
}

/// Direct-URL resolution via `yt-dlp -j -f <format>`.
///
/// Authenticated first, then one anonymous retry when the signed-in
/// extraction comes back with NO formats. That is what "Requested format
/// is not available" means here: the selector ends in bare `bestaudio`,
/// which matches anything with audio, so it only fails when yt-dlp dropped
/// every format. The one cause seen so far (2026-08-28) was a missing JS
/// runtime, since handled by `ytdlp::js_runtime_args`: unsolved player
/// challenges drop every ciphered format, the signed-in clients are all
/// ciphered, and the anonymous ios client hands out plain URLs, which is
/// why the retry always worked and hid the problem for a day. It first
/// read as YouTube intermittently stripping the session; it was the launch
/// environment. The retry stays as the floor for the next cause: anonymous
/// is what shipped before 0.4.2 (130k, no Premium tracks), a downgrade
/// rather than a 502, and the reason now goes into the log with it.
async fn resolve(ctx: &ResolveCtx) -> Result<Resolved, String> {
    // Anonymous tracks resolve once, plainly.
    let Some(cookies) = ctx.cookies.as_deref() else {
        return resolve_with(ctx, None, RESOLVE_TIMEOUT).await;
    };

    // Signed-in: run the real resolve, and if it is still going at
    // HEDGE_AFTER, start an anonymous one alongside and take whichever
    // finishes first. The signed-in path hung past 12s on one fetched
    // play in ten today (17.7s, 29s, 41s, 98s); the anonymous path,
    // measured at 2.0s, would have had sound in each within seconds. The
    // hedge only ever costs the anonymous tier on a play that was already
    // slow, and that copy is marked degraded so it is not kept.
    let signed = resolve_with(ctx, Some(cookies), RESOLVE_TIMEOUT);
    tokio::pin!(signed);
    let hedge_timer = tokio::time::sleep(HEDGE_AFTER);
    tokio::pin!(hedge_timer);

    let signed_result = tokio::select! {
        r = &mut signed => Some(r),
        _ = &mut hedge_timer => None,
    };
    let signed_result = match signed_result {
        Some(r) => r,
        None => {
            eprintln!(
                "[proxy] {}: signed-in resolve past {}s; hedging with an anonymous resolve",
                ctx.video_id,
                HEDGE_AFTER.as_secs()
            );
            let anon = resolve_with(ctx, None, FALLBACK_TIMEOUT);
            tokio::pin!(anon);
            tokio::select! {
                r = &mut signed => match r {
                    // The signed path came through after all: it wins,
                    // the anonymous child is dropped (kill_on_drop).
                    Ok(r) => return Ok(r),
                    // Signed died; whatever the hedge returns is the answer.
                    Err(e) => {
                        eprintln!("[proxy] {}: signed-in resolve failed while hedged ({e})", ctx.video_id);
                        let mut a = anon.await?;
                        a.degraded = true;
                        return Ok(a);
                    }
                },
                a = &mut anon => match a {
                    Ok(mut a) => {
                        a.degraded = true;
                        eprintln!(
                            "[proxy] {}: anonymous hedge won with format {} (degraded; not kept as the cached copy)",
                            ctx.video_id,
                            a.format_id.as_deref().unwrap_or("?")
                        );
                        return Ok(a);
                    }
                    // The hedge itself failed; fall through to the signed
                    // result, whatever it turns out to be.
                    Err(e) => {
                        eprintln!("[proxy] {}: anonymous hedge failed ({e}); waiting on signed-in", ctx.video_id);
                        signed.await
                    }
                },
            }
        }
    };

    match signed_result {
        Ok(r) => Ok(r),
        Err(e) if e.contains("Requested format is not available") => {
            eprintln!(
                "[proxy] {}: signed-in extraction returned no formats; retrying anonymously ({e})",
                ctx.video_id
            );
            resolve_with(ctx, None, RESOLVE_TIMEOUT).await
        }
        // A signed-in resolve that hits the ceiling is not retried the
        // same way. That was tried (2026-09-03) and on 2026-09-04 14:14 it
        // cost a click 60 seconds instead of 30: the second attempt hung
        // exactly like the first, then the legacy blocking path took
        // another 36. The legacy path succeeded because it is a DIFFERENT
        // path: the anonymous client, no watch page, no JS challenge,
        // measured 2.0s. So that is the fallback here, with its own
        // shorter ceiling. The price is the anonymous tier (130k) for this
        // one play, which beats a minute of silence; the result is marked
        // degraded so it is not kept as the canonical cached copy and the
        // next play resolves signed-in again.
        //
        // Only on a timeout, and only when there was a signed-in path to
        // fall back FROM. An outright yt-dlp error (a private or removed
        // video, "Video unavailable") is not slow, it is dead, and
        // retrying that only doubles the wait before an honest failure.
        Err(e) if ctx.cookies.is_some() && e.starts_with(TIMED_OUT_PREFIX) => {
            eprintln!(
                "[proxy] {}: {e}; falling back to an anonymous resolve",
                ctx.video_id
            );
            let mut r = resolve_with(ctx, None, FALLBACK_TIMEOUT).await?;
            r.degraded = true;
            eprintln!(
                "[proxy] {}: anonymous fallback resolved format {} (degraded; not kept as the cached copy)",
                ctx.video_id,
                r.format_id.as_deref().unwrap_or("?")
            );
            Ok(r)
        }
        Err(e) => Err(e),
    }
}

async fn resolve_with(
    ctx: &ResolveCtx,
    cookies: Option<&Path>,
    ceiling: Duration,
) -> Result<Resolved, String> {
    let url = format!("https://www.youtube.com/watch?v={}", ctx.video_id);
    let mut cmd = tokio::process::Command::new(&ctx.ytdlp_program);
    // No --no-warnings here: stderr is captured, not inherited, so on
    // success the warnings go nowhere, and on failure the first one is
    // usually the reason (see the error path below).
    cmd.args(["-j", "-f", &ctx.format, "--no-playlist"]);
    cmd.args(crate::ytdlp::js_runtime_args());
    if let Some(path) = cookies {
        cmd.arg("--cookies").arg(path);
    }
    cmd.arg(&url);
    cmd.stdin(Stdio::null());
    // The wrapping timeout (and a skipped track abandoning this future)
    // drops the child future — without kill_on_drop that leaks a live
    // yt-dlp process per abandonment.
    cmd.kill_on_drop(true);
    let out = tokio::time::timeout(ceiling, cmd.output())
        .await
        .map_err(|_| {
            if ceiling == RESOLVE_TIMEOUT {
                TIMED_OUT.to_string()
            } else {
                format!("{TIMED_OUT_PREFIX} {}s", ceiling.as_secs())
            }
        })?
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // The ERROR line is the verdict and the first WARNING is usually
        // the reason ("n challenge solving failed"); keep those two and
        // drop the rest rather than the first 300 bytes of whatever came.
        let mut kept: Vec<String> = ["WARNING:", "ERROR:"]
            .iter()
            .filter_map(|prefix| stderr.lines().find(|l| l.starts_with(prefix)))
            .map(|l| l.chars().take(200).collect())
            .collect();
        if kept.is_empty() {
            kept.push(stderr.chars().take(300).collect());
        }
        return Err(format!("yt-dlp -j exit {}: {}", out.status, kept.join(" | ")));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("yt-dlp -j parse: {e}"))?;
    // Single-format selections put url/ext/codec at the root; multi-format
    // ones nest under requested_formats. Our selectors never merge tracks,
    // but handle both shapes anyway.
    let fmt = if json.get("url").and_then(|v| v.as_str()).is_some() {
        &json
    } else {
        json.get("requested_formats")
            .and_then(|v| v.get(0))
            .ok_or("yt-dlp -j: no url and no requested_formats")?
    };
    let direct = fmt
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("yt-dlp -j: no stream url")?
        .to_string();
    if !direct.starts_with("https://") {
        return Err(format!("unexpected stream url scheme: {}", &direct[..direct.len().min(40)]));
    }
    let ext = fmt.get("ext").and_then(|v| v.as_str()).unwrap_or("");
    let acodec = fmt.get("acodec").and_then(|v| v.as_str()).unwrap_or("");
    let vcodec = fmt.get("vcodec").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Resolved {
        url: direct,
        degraded: false,
        mime: mime_for(ext, acodec, vcodec, ctx.video).to_string(),
        format_id: fmt
            .get("format_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Mirror of `sniff_stream_mime`'s mapping, driven by yt-dlp metadata
/// instead of magic bytes (the file doesn't exist yet).
fn mime_for(ext: &str, acodec: &str, vcodec: &str, video: bool) -> &'static str {
    let mp4ish = ext == "m4a" || ext == "mp4" || acodec.starts_with("mp4a") || vcodec.starts_with("avc1");
    let webmish = ext == "webm" || acodec == "opus" || vcodec.starts_with("vp") || vcodec.starts_with("av01");
    if video {
        if webmish && !mp4ish { "video/webm" } else { "video/mp4" }
    } else if mp4ish {
        "audio/mp4"
    } else if webmish {
        "audio/webm"
    } else {
        "audio/webm"
    }
}

/// 1-byte range probe: learns the exact total size and proves the URL
/// serves ranged requests to a plain HTTPS client. Retries transient
/// 403s on the same URL (measured: 9/9 recover within 3 attempts).
async fn probe_total(client: &reqwest::Client, url: &str) -> Result<u64, String> {
    let mut last = String::new();
    for attempt in 0..URL_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
        }
        let resp = match tokio::time::timeout(
            Duration::from_secs(10),
            client.get(url).header(reqwest::header::RANGE, "bytes=0-0").send(),
        )
        .await
        {
            Err(_) => {
                last = "probe timeout".into();
                continue;
            }
            Ok(Err(e)) => {
                last = format!("probe: {e}");
                continue;
            }
            Ok(Ok(r)) => r,
        };
        match resp.status().as_u16() {
            206 => {
                let cr = resp
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                // Require exactly the span we asked for and a concrete
                // total — a mislabeled or unsatisfied range here would
                // poison every offset downstream.
                match parse_content_range(cr) {
                    Some((0, 0, Some(total))) => return Ok(total),
                    _ => return Err(format!("bad probe Content-Range {cr:?}")),
                }
            }
            // 200 means the server ignored Range. The whole serving
            // model needs ranged access (tail probes, passthrough
            // windows), so this URL is unusable — legacy path instead.
            200 => return Err("origin ignores Range requests".into()),
            s => {
                last = format!("probe HTTP {s}");
                continue;
            }
        }
    }
    Err(last)
}

/// Parse `bytes S-E/T` into (S, E, T). Returns None for any other
/// shape, including `bytes */T` — an unsatisfied-range form that must
/// never be combined with cached data (RFC 9110 §14.4). T is None for
/// `bytes S-E/*`.
fn parse_content_range(v: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = v.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse::<u64>().ok()?),
    };
    let (s, e) = range.trim().split_once('-')?;
    let s: u64 = s.trim().parse().ok()?;
    let e: u64 = e.trim().parse().ok()?;
    if e < s {
        return None;
    }
    Some((s, e, total))
}

// ---------------------------------------------------------------------
// Filler
// ---------------------------------------------------------------------

/// Downloads the whole file sequentially into `part_path`, renaming to
/// `final_path` when the byte count matches `state.total` exactly. On
/// exit (success or failure) removes this key from both maps and flips
/// the legacy DownloadState so blocked legacy waiters wake up.
#[allow(clippy::too_many_arguments)]
pub fn spawn_filler(
    client: reqwest::Client,
    ctx: ResolveCtx,
    state: Arc<ProxyState>,
    part_path: PathBuf,
    final_path: PathBuf,
    proxies: ProxyMap,
    map_key: String,
    legacy_complete: Arc<AtomicBool>,
    legacy_notify: Arc<Notify>,
    on_exit: impl FnOnce() + Send + 'static,
) {
    tokio::spawn(async move {
        let ok = fill(&client, &ctx, &state, &part_path, &final_path).await;
        if ok {
            state.complete.store(true, Ordering::Release);
        } else {
            state.failed.store(true, Ordering::Release);
            let _ = tokio::fs::remove_file(&part_path).await;
            eprintln!("[proxy] {}: filler FAILED", ctx.video_id);
        }
        state.notify.notify_waiters();
        // Wake anything blocked on the legacy DownloadState for this key
        // (requests that fell back while we were running, prefetchers).
        legacy_complete.store(true, Ordering::Release);
        legacy_notify.notify_waiters();
        proxies.lock().await.remove(&map_key);
        on_exit();
    });
}

async fn fill(
    client: &reqwest::Client,
    ctx: &ResolveCtx,
    state: &ProxyState,
    part_path: &Path,
    final_path: &Path,
) -> bool {
    if let Some(dir) = part_path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    // Truncate any stale .part from a previous run — it may have been
    // produced by a different format/URL and offsets wouldn't line up.
    let mut file = match tokio::fs::File::create(part_path).await {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[proxy] create {part_path:?}: {e}");
            return false;
        }
    };
    let t0 = std::time::Instant::now();
    let total = state.total;
    let mut pos: u64 = 0;
    let mut url_retries_left = URL_RETRIES;
    let mut reresolves_left = 1u32;

    // Download in bounded chunks, one ranged request each, instead of a
    // single `bytes=pos-` connection: googlevideo gives every fresh
    // range request a full-speed burst but throttles a long-lived
    // connection down to roughly playback rate once it's a few MB in
    // (observed live: a 14.5MB 4K WebM stalled at 10.3MB for minutes on
    // the open-ended form while a 5MB audio file finished in 0.33s).
    // Chunking is the same trick yt-dlp's downloader uses.
    //
    // EVERY way an attempt can fall short — bad status, mislabeled
    // Content-Range, body error, stall, or a clean-but-early EOF —
    // lands in the same ladder: burn a same-URL retry, then one
    // identity-checked re-resolve, then fail. A clean early EOF MUST
    // consume budget too, or a server that keeps closing at the same
    // byte turns the filler into an infinite reconnect loop that owns
    // the .part forever. Only a fully delivered chunk refills the
    // budget.
    'outer: while pos < total {
        let chunk_end = pos.saturating_add(FILL_CHUNK).min(total) - 1;
        let url = state.url.lock().await.clone();
        let mut why: Option<String> = None;

        let sent = tokio::time::timeout(
            Duration::from_secs(15),
            client
                .get(&url)
                .header(reqwest::header::RANGE, format!("bytes={pos}-{chunk_end}"))
                .send(),
        )
        .await;
        match sent {
            Ok(Ok(mut resp)) if resp.status().as_u16() == 206 => {
                let cr = resp
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                match parse_content_range(&cr) {
                    Some((s, _e, t)) if s == pos && t.map_or(true, |t| t == total) => {
                        // Header checks out — drain the body into the file.
                        loop {
                            match tokio::time::timeout(Duration::from_secs(30), resp.chunk()).await
                            {
                                Err(_) => {
                                    why = Some(format!("body stalled at {pos}"));
                                    break;
                                }
                                Ok(Err(e)) => {
                                    why = Some(format!("body error at {pos}: {e}"));
                                    break;
                                }
                                Ok(Ok(None)) => {
                                    if pos <= chunk_end {
                                        why = Some(format!(
                                            "early EOF at {pos} (chunk end {chunk_end})"
                                        ));
                                    }
                                    break;
                                }
                                Ok(Ok(Some(chunk))) => {
                                    // Never write past the requested chunk
                                    // end: surplus bytes would corrupt the
                                    // offset math for readers.
                                    let take =
                                        chunk.len().min((chunk_end + 1 - pos) as usize);
                                    if let Err(e) = file.write_all(&chunk[..take]).await {
                                        eprintln!(
                                            "[proxy] {} write .part: {e}",
                                            ctx.video_id
                                        );
                                        return false;
                                    }
                                    pos += take as u64;
                                    state.filled.store(pos, Ordering::Release);
                                    state.notify.notify_waiters();
                                    if pos > chunk_end {
                                        url_retries_left = URL_RETRIES;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    _ => why = Some(format!("bad Content-Range {cr:?} for offset {pos}")),
                }
            }
            Ok(Ok(r)) => why = Some(format!("HTTP {}", r.status())),
            Ok(Err(e)) => why = Some(format!("{e}")),
            Err(_) => why = Some("connect timeout".into()),
        }

        let Some(why) = why else { continue 'outer };
        if url_retries_left > 0 {
            url_retries_left -= 1;
            eprintln!("[proxy] {} fill: {why}; retrying same url", ctx.video_id);
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue 'outer;
        }
        if reresolves_left > 0 {
            reresolves_left -= 1;
            url_retries_left = URL_RETRIES;
            eprintln!("[proxy] {} fill: {why}; re-resolving url", ctx.video_id);
            // Pin the exact format of the first extraction: the selector
            // has fallbacks, and splicing a different representation onto
            // the written prefix would cache a corrupt file. The probe
            // must agree on the byte count for the same reason.
            let pinned = ResolveCtx {
                format: state
                    .format_id
                    .clone()
                    .unwrap_or_else(|| ctx.format.clone()),
                ..ctx.clone()
            };
            match resolve(&pinned).await {
                Ok(fresh) => match probe_total(client, &fresh.url).await {
                    Ok(t2) if t2 == total => {
                        *state.url.lock().await = fresh.url;
                        continue 'outer;
                    }
                    Ok(t2) => {
                        eprintln!(
                            "[proxy] {} re-resolve changed size ({t2} vs {total}); aborting",
                            ctx.video_id
                        );
                        return false;
                    }
                    Err(e) => {
                        eprintln!("[proxy] {} re-resolve probe failed: {e}", ctx.video_id);
                        return false;
                    }
                },
                Err(e) => {
                    eprintln!("[proxy] {} re-resolve failed: {e}", ctx.video_id);
                    return false;
                }
            }
        }
        eprintln!("[proxy] {} fill: {why}; giving up", ctx.video_id);
        return false;
    }

    if let Err(e) = file.flush().await {
        eprintln!("[proxy] {} flush: {e}", ctx.video_id);
        return false;
    }
    drop(file);
    let on_disk = tokio::fs::metadata(part_path).await.map(|m| m.len()).unwrap_or(0);
    if on_disk != total {
        eprintln!(
            "[proxy] {} size mismatch: {on_disk} on disk vs {total} probed",
            ctx.video_id
        );
        return false;
    }
    let marker = degraded_marker(final_path);
    if state.degraded {
        // The file has to land under its canonical name so the play in
        // progress keeps reading it. The marker is what stops it being
        // treated as the real cached copy afterwards: evicted when
        // playback moves on and at the next launch. It is committed
        // BEFORE the rename: the other order left a window (a full disk,
        // a crash between the two) in which an unmarked low-tier file
        // became the permanent cached copy. If the marker cannot be
        // written the file is not published at all.
        if let Err(e) = tokio::fs::write(&marker, b"").await {
            eprintln!("[proxy] {} degraded marker: {e}; not publishing", ctx.video_id);
            let _ = tokio::fs::remove_file(part_path).await;
            return false;
        }
    } else {
        // A stale marker from an earlier degraded copy must not outlive
        // the good file that replaces it, or the next eviction deletes
        // the good file.
        let _ = tokio::fs::remove_file(&marker).await;
    }
    if let Err(e) = tokio::fs::rename(part_path, final_path).await {
        eprintln!("[proxy] {} rename: {e}", ctx.video_id);
        let _ = tokio::fs::remove_file(&marker).await;
        return false;
    }
    eprintln!(
        "[proxy] cached {} ({total} bytes in {:.2}s{})",
        ctx.video_id,
        t0.elapsed().as_secs_f32(),
        if state.degraded { ", degraded" } else { "" }
    );
    true
}

// ---------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------

/// One parsed request span. `end` is inclusive.
#[derive(Debug, PartialEq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

/// Parse a Range header against a known total. Returns Ok(None) for an
/// absent/unusable header (serve 200), Ok(Some) for a satisfiable span
/// (serve 206), Err(()) for an unsatisfiable one (serve 416). Multi-range
/// requests use the first span only — neither AVFoundation nor Chromium
/// sends them; answering with a single 206 span is spec-conformant
/// behavior for a server that doesn't do multipart.
pub fn parse_range(header: Option<&str>, total: u64) -> Result<Option<Span>, ()> {
    let Some(h) = header else { return Ok(None) };
    let Some(spec) = h.trim().strip_prefix("bytes=") else {
        return Ok(None);
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    if first.is_empty() {
        return Ok(None);
    }
    if let Some(suffix) = first.strip_prefix('-') {
        // bytes=-N : final N bytes
        let n: u64 = suffix.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        let start = total.saturating_sub(n);
        return Ok(Some(Span { start, end: total - 1 }));
    }
    // RFC 9110 grammar requires the hyphen ("500-", "0-99", "-100");
    // a bare "bytes=500" is malformed, and a malformed Range header is
    // ignored (serve 200), not answered with 416.
    let Some((start_part, end_part)) = first.split_once('-') else {
        return Ok(None);
    };
    let start: u64 = start_part.trim().parse().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }
    let end_part = end_part.trim();
    let end = if end_part.is_empty() {
        total - 1
    } else {
        end_part.parse::<u64>().map_err(|_| ())?.min(total - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some(Span { start, end }))
}

/// Clamp a span to the serving window. Saturating: HTTP range numerals
/// can legally be enormous and must not overflow (RFC 9110 §14.1.1).
pub fn window_span(s: &Span) -> Span {
    Span {
        start: s.start,
        end: s.end.min(s.start.saturating_add(WINDOW - 1)),
    }
}

/// Read `[start, start+len)` from the .part file (or the final file if
/// the rename has already happened — the two never coexist).
async fn read_span(
    part_path: &Path,
    final_path: &Path,
    start: u64,
    len: usize,
) -> std::io::Result<Vec<u8>> {
    let mut f = match tokio::fs::File::open(part_path).await {
        Ok(f) => f,
        Err(_) => tokio::fs::File::open(final_path).await?,
    };
    f.seek(SeekFrom::Start(start)).await?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Where a span's bytes come from, and how many of them there are.
///
/// `len` is settled before the caller writes a single header, so
/// Content-Length and Content-Range are labelled from a length the body
/// is committed to. The guarantee is exact length or a broken transfer,
/// not exact length always: an upstream that stops early fails the
/// response instead of completing it at the wrong count. A disk read is
/// already in memory by the time we know its length; a passthrough
/// declares its length in the upstream Content-Range and then streams,
/// so the first byte reaches the player without waiting for the last.
pub struct SpanBody {
    pub len: usize,
    pub source: SpanSource,
}

pub enum SpanSource {
    Memory(Vec<u8>),
    Stream(mpsc::Receiver<Result<Vec<u8>, std::io::Error>>),
}

impl SpanBody {
    fn memory(bytes: Vec<u8>) -> Self {
        SpanBody {
            len: bytes.len(),
            source: SpanSource::Memory(bytes),
        }
    }
}

/// Body producer for a passthrough 206: forward exactly `promised` bytes
/// from an upstream response the caller has already validated.
///
/// Coming up short sends an error rather than ending the stream. That is
/// not what stops a short span being served as a complete one: hyper's
/// HTTP/1 encoder already aborts a clean EOF that lands short of
/// Content-Length. The error is here to make the failure explicit and to
/// put the byte counts in the log instead of leaving the encoder to
/// notice.
fn spawn_span_pump(
    resp: reqwest::Response,
    promised: usize,
) -> mpsc::Receiver<Result<Vec<u8>, std::io::Error>> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, std::io::Error>>(4);
    tokio::spawn(async move {
        let mut resp = resp;
        let mut sent = 0usize;
        while sent < promised {
            // Racing the read against the receiver closing means a client
            // that goes away mid-span releases the upstream response now,
            // rather than whenever the next chunk or the 30s timeout
            // lands. Seeking repeatedly against a stalled upstream would
            // otherwise pile up abandoned requests.
            let read = tokio::select! {
                biased;
                _ = tx.closed() => return,
                r = tokio::time::timeout(Duration::from_secs(30), resp.chunk()) => r,
            };
            match read {
                Ok(Ok(Some(mut c))) => {
                    // A server may overshoot the range it declared.
                    c.truncate(promised - sent);
                    sent += c.len();
                    if tx.send(Ok(c.to_vec())).await.is_err() {
                        return; // client went away
                    }
                }
                Ok(Ok(None)) => break,
                _ => break,
            }
        }
        if sent < promised {
            // Release the upstream before parking on a send that a slow
            // receiver may not drain for a while.
            drop(resp);
            let _ = tx
                .send(Err(std::io::Error::other(format!(
                    "short body {sent}/{promised}"
                ))))
                .await;
        }
    });
    rx
}

/// Fetch exactly `[start, end]` from the current signed URL, with the
/// same-URL retry that recovers transient 403s.
///
/// The retry covers everything that can go wrong before the body starts:
/// a connect timeout, a non-206, a Content-Range that does not match
/// what we asked for. Once one of those checks passes we hand the
/// response straight to the pump, so a failure partway through the body
/// is no longer retried here. That is deliberate. Buffering the whole
/// window to keep the retry meant a far seek waited for the last byte of
/// up to WINDOW before the player got the first, and a truncated 206
/// already re-enters this path through the media element's own retry.
async fn fetch_span(
    client: &reqwest::Client,
    state: &ProxyState,
    start: u64,
    end: u64,
) -> Result<SpanBody, String> {
    let mut last = String::new();
    for attempt in 0..=URL_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
        }
        let url = state.url.lock().await.clone();
        let resp = match tokio::time::timeout(
            Duration::from_secs(15),
            client
                .get(&url)
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .send(),
        )
        .await
        {
            Err(_) => {
                last = "connect timeout".into();
                continue;
            }
            Ok(Err(e)) => {
                last = format!("{e}");
                continue;
            }
            Ok(Ok(r)) => r,
        };
        if resp.status().as_u16() != 206 {
            last = format!("HTTP {}", resp.status());
            continue;
        }
        // A 206 whose Content-Range names a different offset would hand
        // the caller mislabeled bytes — validate before reading. A
        // server MAY legally answer with a shorter span than requested;
        // deliver exactly what it declared and let the caller label the
        // response from the actual byte count.
        let cr = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let promised = match parse_content_range(&cr) {
            Some((s, e2, t))
                if s == start && e2 <= end && t.map_or(true, |t| t == state.total) =>
            {
                (e2 - start + 1) as usize
            }
            _ => {
                last = format!("bad Content-Range {cr:?}");
                continue;
            }
        };
        // A response that declares a body shorter than the range it just
        // promised is a contradiction visible in the headers, so it still
        // belongs to the retry. Once the response goes to the pump there
        // is no retry left, and the caller has already committed to
        // `promised` bytes.
        if let Some(declared) = resp.content_length() {
            if declared < promised as u64 {
                last = format!("declared body {declared} < promised {promised}");
                continue;
            }
        }
        return Ok(SpanBody {
            len: promised,
            source: SpanSource::Stream(spawn_span_pump(resp, promised)),
        });
    }
    Err(last)
}

/// Serve one ranged request against an in-flight download. Returns the
/// bytes for the effective span, waiting briefly for the filler when the
/// span is just past the high-water mark (cheaper than fetching the same
/// bytes twice), passing through to googlevideo for far seeks and tail
/// probes.
pub async fn serve_span(
    client: &reqwest::Client,
    state: &ProxyState,
    part_path: &Path,
    final_path: &Path,
    span: &Span,
) -> Result<SpanBody, String> {
    let len = (span.end - span.start + 1) as usize;
    let deadline = tokio::time::Instant::now() + WAIT_BUDGET;
    let mut last_filled = state.filled.load(Ordering::Acquire);
    let mut last_progress = tokio::time::Instant::now();
    loop {
        let filled = state.filled.load(Ordering::Acquire);
        let done = state.complete.load(Ordering::Acquire);
        if done || span.end < filled {
            return read_span(part_path, final_path, span.start, len)
                .await
                .map(SpanBody::memory)
                .map_err(|e| format!("disk read: {e}"));
        }
        if state.failed.load(Ordering::Acquire) {
            return Err("download failed".into());
        }
        if filled > last_filled {
            last_filled = filled;
            last_progress = tokio::time::Instant::now();
        }
        let gap = span.end.saturating_sub(filled);
        // Fetch the window ourselves for a far seek, a filler that has
        // stopped moving (throttled/stuck), or when we've waited long
        // enough — a fresh bounded range request gets burst speed.
        if gap > NEAR_GAP
            || last_progress.elapsed() > STALL
            || tokio::time::Instant::now() >= deadline
        {
            match fetch_span(client, state, span.start, span.end).await {
                Ok(b) => return Ok(b),
                Err(e) => {
                    // The filler may have finished while the passthrough
                    // was failing — the file is then authoritative.
                    if state.complete.load(Ordering::Acquire) {
                        return read_span(part_path, final_path, span.start, len)
                            .await
                            .map(SpanBody::memory)
                            .map_err(|e2| format!("disk read after passthrough: {e2}"));
                    }
                    return Err(e);
                }
            }
        }
        let notified = state.notify.notified();
        tokio::pin!(notified);
        let _ = tokio::time::timeout(Duration::from_millis(500), notified).await;
    }
}

/// Body producer for a rangeless 200: stream the whole file in order,
/// tailing the .part file as the filler writes it. Sends chunks into an
/// mpsc whose receiver backs the hyper Body; an error mid-stream drops
/// the sender, truncating the response so the client sees a broken
/// transfer instead of a silently short "complete" one.
pub fn spawn_tail_pump(
    state: Arc<ProxyState>,
    part_path: PathBuf,
    final_path: PathBuf,
) -> mpsc::Receiver<Result<Vec<u8>, std::io::Error>> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, std::io::Error>>(4);
    tokio::spawn(async move {
        const CHUNK: u64 = 512 * 1024;
        let total = state.total;
        let mut sent: u64 = 0;
        let mut idle = tokio::time::Instant::now();
        while sent < total {
            let filled = state.filled.load(Ordering::Acquire);
            let done = state.complete.load(Ordering::Acquire);
            let avail = if done { total } else { filled };
            if sent < avail {
                let len = (avail - sent).min(CHUNK) as usize;
                match read_span(&part_path, &final_path, sent, len).await {
                    Ok(buf) => {
                        sent += buf.len() as u64;
                        if tx.send(Ok(buf)).await.is_err() {
                            return; // client went away
                        }
                        idle = tokio::time::Instant::now();
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                }
                continue;
            }
            if state.failed.load(Ordering::Acquire) {
                let _ = tx
                    .send(Err(std::io::Error::other("download failed")))
                    .await;
                return;
            }
            if idle.elapsed() > WAIT_BUDGET {
                let _ = tx.send(Err(std::io::Error::other("stalled"))).await;
                return;
            }
            let notified = state.notify.notified();
            tokio::pin!(notified);
            let _ = tokio::time::timeout(Duration::from_secs(2), notified).await;
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    /// `prefetch_handler` compares this string exactly to tell a declined
    /// prefetch from a real failure, and the two live in different files.
    /// When they drifted apart the skip fell through to the legacy
    /// downloader and spawned the yt-dlp it existed to prevent, so pin it.
    #[test]
    fn the_skip_marker_is_distinguishable_from_a_real_failure() {
        assert_eq!(SKIPPED, "prefetch skipped: resolver busy");
        // Must not collide with the errors that SHOULD reach the legacy path.
        assert_ne!(SKIPPED, TIMED_OUT);
        assert!(!SKIPPED.starts_with(TIMED_OUT_PREFIX));
        for real_failure in [
            "yt-dlp -j exit exit status: 1: ERROR: [youtube] x: Video unavailable",
            "legacy download already in flight",
            "suspiciously small stream (12 bytes)",
            "spawn yt-dlp: No such file or directory",
        ] {
            assert_ne!(real_failure, SKIPPED);
        }
    }

    /// The anonymous fallback in `resolve` keys off the timeout message's
    /// prefix, so a reworded timeout would silently stop falling back and
    /// a reworded yt-dlp error could start being treated as slow. Pin
    /// both directions, for both ceilings.
    #[test]
    fn only_a_timeout_earns_the_anonymous_fallback() {
        assert_eq!(
            TIMED_OUT,
            format!("{TIMED_OUT_PREFIX} {}s", RESOLVE_TIMEOUT.as_secs())
        );
        assert!(TIMED_OUT.starts_with(TIMED_OUT_PREFIX));
        let fallback_timed_out = format!("{TIMED_OUT_PREFIX} {}s", FALLBACK_TIMEOUT.as_secs());
        assert!(fallback_timed_out.starts_with(TIMED_OUT_PREFIX));
        // A dead video must not match: falling back just doubles the wait.
        let dead = "yt-dlp -j exit exit status: 1: ERROR: [youtube] x: Video unavailable";
        assert!(!dead.starts_with(TIMED_OUT_PREFIX));
        // Nor must the no-formats case, which has its own anonymous retry.
        let no_formats = "yt-dlp -j exit exit status: 1: ERROR: Requested format is not available";
        assert!(!no_formats.starts_with(TIMED_OUT_PREFIX));
    }

    /// The marker sits beside the canonical file and eviction spares only
    /// the track that is playing.
    #[tokio::test]
    async fn degraded_eviction_keeps_the_playing_track() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "ytubic-degraded-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for id in ["keepme", "dropme"] {
            let f = dir.join(format!("{id}.webm"));
            std::fs::write(&f, b"x").unwrap();
            std::fs::write(degraded_marker(&f), b"").unwrap();
        }
        // An ordinary cached file with no marker is never touched.
        std::fs::write(dir.join("normal.webm"), b"x").unwrap();
        let removed = evict_degraded(&dir, Some("keepme")).await;
        assert_eq!(removed, 1);
        assert!(dir.join("keepme.webm").exists());
        assert!(dir.join("normal.webm").exists());
        assert!(!dir.join("dropme.webm").exists());
        assert!(!dir.join("dropme.webm.degraded").exists());
    }

    /// Raw HTTP server that answers every connection with the same 206.
    /// The Content-Range and Content-Length values are set independently
    /// so a test can hand the code an upstream whose headers contradict
    /// each other, or whose body contradicts both.
    async fn serve_206(range_end: u64, total: u64, declared: usize, body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let body = body.clone();
                tokio::spawn(async move {
                    let mut scratch = [0u8; 1024];
                    let _ = sock.read(&mut scratch).await;
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-{range_end}/{total}\r\nContent-Length: {declared}\r\n\r\n"
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                });
            }
        });
        format!("http://{addr}/")
    }

    fn state_for(url: String, total: u64) -> ProxyState {
        ProxyState {
            url: Mutex::new(url),
            total,
            mime: "audio/mp4".into(),
            format_id: None,
            degraded: false,
            filled: AtomicU64::new(0),
            complete: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    async fn drain(
        mut rx: mpsc::Receiver<Result<Vec<u8>, std::io::Error>>,
    ) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        while let Some(item) = rx.recv().await {
            match item {
                Ok(b) => out.extend_from_slice(&b),
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(out)
    }

    /// The headers are already on the wire by the time the body starts,
    /// so an upstream that stops early must break the transfer. Ending
    /// cleanly would hand the player a body shorter than the
    /// Content-Length it was promised and call it a complete span.
    #[tokio::test]
    async fn a_short_upstream_body_errors_instead_of_truncating_silently() {
        let url = serve_206(99, 1000, 100, vec![b'x'; 40]).await;
        let resp = reqwest::Client::new().get(&url).send().await.unwrap();
        let err = drain(spawn_span_pump(resp, 100)).await.unwrap_err();
        assert!(err.contains("short body 40/100"), "got {err}");
    }

    #[tokio::test]
    async fn an_exact_upstream_body_delivers_every_promised_byte() {
        let url = serve_206(99, 1000, 100, vec![b'y'; 100]).await;
        let resp = reqwest::Client::new().get(&url).send().await.unwrap();
        let got = drain(spawn_span_pump(resp, 100)).await.unwrap();
        assert_eq!(got.len(), 100);
        assert!(got.iter().all(|b| *b == b'y'));
    }

    /// Overshoot is trimmed, not forwarded: Content-Length is already
    /// set from `promised`, so the extra bytes would overrun it.
    ///
    /// `promised` sits well under the body size on purpose. At 100 of 150
    /// the test would also pass on a socket that happened to split the
    /// body at exactly 100, without the trim ever running.
    #[tokio::test]
    async fn an_overshooting_upstream_is_trimmed_to_the_promised_length() {
        let url = serve_206(149, 1500, 150, vec![b'z'; 150]).await;
        let resp = reqwest::Client::new().get(&url).send().await.unwrap();
        let got = drain(spawn_span_pump(resp, 10)).await.unwrap();
        assert_eq!(got, vec![b'z'; 10]);
    }

    /// Content-Range promises 100 bytes, Content-Length admits to 40.
    /// The two disagree in the headers, before a single body byte, so
    /// this still belongs to the retry: handing it to the pump would
    /// commit the caller to a Content-Length the body cannot reach.
    #[tokio::test]
    async fn a_body_shorter_than_its_own_content_range_is_retried_not_streamed() {
        let url = serve_206(99, 1000, 40, vec![b'x'; 40]).await;
        let state = state_for(url, 1000);
        let err = fetch_span(&reqwest::Client::new(), &state, 0, 99)
            .await
            .err()
            .expect("a body that cannot reach the promised length must not be served");
        assert!(err.contains("declared body 40 < promised 100"), "got {err}");
    }

    /// Positive control for the test above: the same harness, headers
    /// that agree, and the span is served.
    #[tokio::test]
    async fn a_consistent_upstream_is_served() {
        let url = serve_206(99, 1000, 100, vec![b'x'; 100]).await;
        let state = state_for(url, 1000);
        let body = fetch_span(&reqwest::Client::new(), &state, 0, 99)
            .await
            .expect("headers agree, so this must be served");
        assert_eq!(body.len, 100);
        assert!(matches!(body.source, SpanSource::Stream(_)));
    }

    use super::*;

    #[test]
    fn range_absent() {
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(Some("chunks=0-1"), 100), Ok(None));
    }

    #[test]
    fn range_normal() {
        assert_eq!(
            parse_range(Some("bytes=0-99"), 1000),
            Ok(Some(Span { start: 0, end: 99 }))
        );
        // end clamped to total
        assert_eq!(
            parse_range(Some("bytes=0-4999"), 1000),
            Ok(Some(Span { start: 0, end: 999 }))
        );
    }

    #[test]
    fn range_open_ended() {
        assert_eq!(
            parse_range(Some("bytes=500-"), 1000),
            Ok(Some(Span { start: 500, end: 999 }))
        );
    }

    #[test]
    fn range_suffix() {
        assert_eq!(
            parse_range(Some("bytes=-100"), 1000),
            Ok(Some(Span { start: 900, end: 999 }))
        );
        // suffix larger than file = whole file
        assert_eq!(
            parse_range(Some("bytes=-5000"), 1000),
            Ok(Some(Span { start: 0, end: 999 }))
        );
    }

    #[test]
    fn range_unsatisfiable() {
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), Err(()));
        assert_eq!(parse_range(Some("bytes=5-2"), 1000), Err(()));
        assert_eq!(parse_range(Some("bytes=-0"), 1000), Err(()));
    }

    #[test]
    fn range_multi_takes_first() {
        assert_eq!(
            parse_range(Some("bytes=0-1,500-"), 1000),
            Ok(Some(Span { start: 0, end: 1 }))
        );
    }

    #[test]
    fn range_missing_hyphen_is_ignored() {
        // Malformed per RFC 9110 grammar — ignore the header, don't 416.
        assert_eq!(parse_range(Some("bytes=500"), 1000), Ok(None));
    }

    #[test]
    fn window_caps() {
        let s = window_span(&Span { start: 0, end: 100 * 1024 * 1024 });
        assert_eq!(s.end, WINDOW - 1);
        let s = window_span(&Span { start: 10, end: 20 });
        assert_eq!(s, Span { start: 10, end: 20 });
    }

    #[test]
    fn content_range_parsing() {
        assert_eq!(
            parse_content_range("bytes 0-0/12345"),
            Some((0, 0, Some(12345)))
        );
        assert_eq!(
            parse_content_range("bytes 100-199/5000"),
            Some((100, 199, Some(5000)))
        );
        assert_eq!(parse_content_range("bytes 5-9/*"), Some((5, 9, None)));
        // Unsatisfied-range form must never be treated as data.
        assert_eq!(parse_content_range("bytes */999"), None);
        assert_eq!(parse_content_range("bytes 9-5/100"), None);
        assert_eq!(parse_content_range("chunks 0-0/1"), None);
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_for("m4a", "mp4a.40.2", "none", false), "audio/mp4");
        assert_eq!(mime_for("webm", "opus", "none", false), "audio/webm");
        assert_eq!(mime_for("mp4", "none", "avc1.64002a", true), "video/mp4");
        assert_eq!(mime_for("webm", "none", "vp9", true), "video/webm");
        assert_eq!(mime_for("", "", "", false), "audio/webm");
    }
}
