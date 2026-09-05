use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command as TokioCommand;
use tokio::sync::{Mutex, Notify};

use axum::{
    extract::{Path, Request, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeFile;

mod now_playing;
mod app_nap;
mod applog;
mod authfs;
mod identity;
mod cast;
mod discord;
mod lastfm;
mod media;
mod session;
mod stream_proxy;
mod ytdlp;

fn sanitize_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Platform-native symmetric "encrypt with current user's credentials"
/// primitive. Linux and macOS use AES-256-GCM over a random data key. Where
/// that key is kept differs per platform (Secret Service on Linux, a 0600
/// file on macOS); see `encryption_key` below for why.
mod secure_store {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_MAGIC: &[u8; 5] = b"YTBC1";
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_NONCE_LEN: usize = 12;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_KEY_LEN: usize = 32;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_SERVICE: &str = "com.github.yuvrajangadsingh.ytubic";
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_USER: &str = "cookie-encryption-key-v1";

    /// Where the cookie key lives on disk (macOS). Set once from setup.
    #[cfg(target_os = "macos")]
    static KEY_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    #[cfg(target_os = "macos")]
    const KEY_FILE: &str = "cookie.key";

    /// Tell the store where the app's data directory is. macOS keeps the
    /// cookie key in a file there instead of the keychain; see
    /// `encryption_key` for why.
    pub fn init(app_data_dir: std::path::PathBuf) {
        #[cfg(target_os = "macos")]
        {
            let _ = KEY_DIR.set(app_data_dir);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = app_data_dir;
        }
    }

    /// The key on disk, if there is one. `Ok(None)` when the file does not
    /// exist; an error for a file of the wrong size, which must never be
    /// papered over by minting (that would orphan the jar).
    #[cfg(target_os = "macos")]
    fn key_from_dir(dir: &std::path::Path) -> Result<Option<[u8; KEYRING_KEY_LEN]>, String> {
        let path = dir.join(KEY_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => bytes.try_into().map(Some).map_err(|bytes: Vec<u8>| {
                format!("{} is {} bytes, not {KEYRING_KEY_LEN}", path.display(), bytes.len())
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read {}: {e}", path.display())),
        }
    }

    #[cfg(target_os = "macos")]
    fn store_key_in_dir(dir: &std::path::Path, key: &[u8; KEYRING_KEY_LEN]) -> Result<(), String> {
        crate::authfs::write_atomic_blocking(&dir.join(KEY_FILE), key, 0o600)
    }

    #[cfg(all(test, target_os = "macos"))]
    mod key_file_tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn tmp() -> std::path::PathBuf {
            let d = std::env::temp_dir().join(format!("ytubic-key-{}", rand::random::<u64>()));
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        #[test]
        fn absent_file_is_none_not_an_error() {
            let d = tmp();
            assert_eq!(key_from_dir(&d).unwrap(), None);
        }

        #[test]
        fn a_stored_key_reads_back_identical_and_private() {
            let d = tmp();
            let key = mint_key();
            store_key_in_dir(&d, &key).unwrap();
            assert_eq!(key_from_dir(&d).unwrap(), Some(key));
            let mode = std::fs::metadata(d.join(KEY_FILE)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "key file must be owner-only");
        }

        #[test]
        fn a_wrong_sized_file_is_an_error_never_silently_replaced() {
            // Minting over a damaged file would orphan the jar; the caller
            // must see the problem, not a fresh key.
            let d = tmp();
            std::fs::write(d.join(KEY_FILE), [7_u8; 31]).unwrap();
            assert!(key_from_dir(&d).is_err());
        }
    }

    /// The key an existing install already encrypts its jar with, read
    /// from the system credential store: the current item, else the
    /// pre-rename item (see identity.rs). `Ok(None)` when neither exists.
    ///
    /// An item that EXISTS but cannot be read (the dialog denied, an ACL
    /// failure) is an error, never `None`: minting a fresh key in that
    /// state would shadow the one the jar is encrypted with. On
    /// 2026-08-31 15:40 exactly that made an intact jar read as
    /// signed-out. Fail this run; the next launch asks again with
    /// nothing lost.
    /// Every well-formed key the credential store holds, current item
    /// first, then the pre-rename item. ALL of them, not the first: on
    /// Aug 31 a shadow item was minted under the current name while the
    /// real key sat under the old one, and "first found wins" would have
    /// chosen the shadow for ever. The caller checks candidates against
    /// the jar they are meant to open.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn keyring_existing_keys() -> Result<Vec<[u8; KEYRING_KEY_LEN]>, String> {
        use keyring::{Entry, Error};
        let mut found = Vec::new();
        for (service, label) in [
            (KEYRING_SERVICE, "current"),
            (crate::identity::OLD_ID, "pre-rename"),
        ] {
            let entry = Entry::new(service, KEYRING_USER)
                .map_err(|error| format!("system credential store is unavailable: {error}"))?;
            match entry.get_secret() {
                Ok(secret) if secret.len() == KEYRING_KEY_LEN => {
                    if let Ok(key) = <[u8; KEYRING_KEY_LEN]>::try_from(secret) {
                        found.push(key);
                    }
                }
                Ok(secret) => {
                    eprintln!(
                        "[secure] {label} keychain key is {} bytes, not {KEYRING_KEY_LEN}; ignoring it",
                        secret.len()
                    );
                }
                Err(Error::NoEntry) => {}
                Err(error) => {
                    return Err(format!(
                        "the {label} cookie key exists in the system credential store but could not be read ({error}); not minting a replacement"
                    ));
                }
            }
        }
        Ok(found)
    }

    /// Encrypted jars already on disk under `accounts/<id>/cookies.enc`.
    /// While any exist, a key is only accepted if it opens one of them,
    /// and none is ever minted: a fresh key beside an existing jar is the
    /// exact failure that made an intact jar read as signed-out.
    #[cfg(target_os = "macos")]
    fn existing_jars(app_data_dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let Ok(accounts) = std::fs::read_dir(app_data_dir.join("accounts")) else {
            return Vec::new();
        };
        accounts
            .flatten()
            .map(|e| e.path().join("cookies.enc"))
            .filter(|p| p.is_file())
            .collect()
    }

    #[cfg(target_os = "macos")]
    fn opens_a_jar(key: &[u8; KEYRING_KEY_LEN], jars: &[std::path::PathBuf]) -> bool {
        jars.iter().any(|jar| {
            std::fs::read(jar)
                .map(|bytes| keyring_decrypt_with_key(&bytes, key).is_ok())
                .unwrap_or(false)
        })
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn mint_key() -> [u8; KEYRING_KEY_LEN] {
        use rand::RngCore;
        let mut key = [0_u8; KEYRING_KEY_LEN];
        rand::rngs::OsRng.fill_bytes(&mut key);
        key
    }

    /// The 32-byte key the cookie jar is encrypted with.
    ///
    /// macOS: a 0600 file in the app's data directory, not a keychain
    /// item. A keychain item's access list is keyed to each build's code
    /// hash when the app has no Apple Team ID, so every rebuild and every
    /// update put up the "YTubic wants to access key" dialog, and on
    /// 2026-09-04 the first play after a relaunch waited 99 seconds on
    /// it. The keychain was guarding a key whose product already sits on
    /// disk: the jar is written out in plain text for yt-dlp, 0600, in
    /// the same directory. A 0600 file beside it gives up nothing that
    /// file did not already give up, and never asks.
    ///
    /// The first run after this change reads the existing keychain item
    /// one final time (one last dialog) so the jar stays readable, writes
    /// the file, and leaves the item in place unread. A fresh install
    /// mints straight into the file and never touches the keychain.
    ///
    /// Linux: unchanged, the system credential store as before.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn encryption_key() -> Result<[u8; KEYRING_KEY_LEN], String> {
        #[cfg(target_os = "macos")]
        {
            let dir = KEY_DIR
                .get()
                .ok_or_else(|| "secure store used before init".to_string())?;
            if let Some(key) = key_from_dir(dir)? {
                return Ok(key);
            }
            // Startup encrypts and decrypts from several tasks at once.
            // On the first run of this build they all found no file and
            // each went to the keychain: the migration line logged twice
            // and a third caller held a dialog open (2026-09-04 13:33).
            // Serialise the slow path and re-check under the lock so the
            // keychain is read exactly once.
            static MIGRATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let _serial = MIGRATION
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(key) = key_from_dir(dir)? {
                return Ok(key);
            }
            let candidates = keyring_existing_keys()?;
            let jars = existing_jars(dir);
            let (key, origin) = if jars.is_empty() {
                match candidates.into_iter().next() {
                    Some(key) => (key, "moved from the keychain"),
                    None => (mint_key(), "minted"),
                }
            } else {
                // A jar exists, so only a key that opens it is the key.
                match candidates.into_iter().find(|k| opens_a_jar(k, &jars)) {
                    Some(key) => (key, "moved from the keychain, verified against the jar"),
                    None => {
                        return Err(format!(
                            "{} encrypted cookie jar(s) exist but no keychain key opens them; not minting a replacement",
                            jars.len()
                        ));
                    }
                }
            };
            store_key_in_dir(dir, &key)?;
            eprintln!(
                "[secure] cookie key {origin}; it lives in {} now and the keychain will not be asked again",
                dir.join(KEY_FILE).display()
            );
            Ok(key)
        }
        #[cfg(target_os = "linux")]
        {
            use keyring::Entry;
            if let Some(key) = keyring_existing_keys()?.into_iter().next() {
                return Ok(key);
            }
            let key = mint_key();
            Entry::new(KEYRING_SERVICE, KEYRING_USER)
                .map_err(|error| format!("system credential store is unavailable: {error}"))?
                .set_secret(&key)
                .map_err(|error| format!("failed to save key in system credential store: {error}"))?;
            Ok(key)
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn keyring_encrypt_with_key(
        plain: &[u8],
        key: &[u8; KEYRING_KEY_LEN],
        nonce: &[u8; KEYRING_NONCE_LEN],
    ) -> Result<Vec<u8>, String> {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};

        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|_| "failed to initialize cookie encryption".to_string())?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(nonce), plain)
            .map_err(|_| "failed to encrypt cookie jar".to_string())?;

        let mut framed = Vec::with_capacity(KEYRING_MAGIC.len() + nonce.len() + ciphertext.len());
        framed.extend_from_slice(KEYRING_MAGIC);
        framed.extend_from_slice(nonce);
        framed.extend_from_slice(&ciphertext);
        Ok(framed)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn keyring_decrypt_with_key(
        encrypted: &[u8],
        key: &[u8; KEYRING_KEY_LEN],
    ) -> Result<Vec<u8>, String> {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};

        if !encrypted.starts_with(KEYRING_MAGIC) {
            // Earlier builds on this platform wrote plaintext jars. Accept
            // one so the next successful persistence pass can migrate it.
            return Ok(encrypted.to_vec());
        }

        let payload = &encrypted[KEYRING_MAGIC.len()..];
        if payload.len() <= KEYRING_NONCE_LEN {
            return Err("encrypted cookie jar is truncated".to_string());
        }
        let (nonce, ciphertext) = payload.split_at(KEYRING_NONCE_LEN);
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|_| "failed to initialize cookie decryption".to_string())?;
        cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|_| "failed to decrypt cookie jar".to_string())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        use rand::RngCore;

        let key = encryption_key()?;
        let mut nonce = [0_u8; KEYRING_NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        keyring_encrypt_with_key(plain, &key, &nonce)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        if !encrypted.starts_with(KEYRING_MAGIC) {
            return Ok(encrypted.to_vec());
        }
        let key = encryption_key()?;
        keyring_decrypt_with_key(encrypted, &key)
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        Ok(encrypted.to_vec())
    }

    #[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
    mod keyring_tests {
        use super::*;

        const KEY: [u8; KEYRING_KEY_LEN] = [7; KEYRING_KEY_LEN];
        const NONCE: [u8; KEYRING_NONCE_LEN] = [3; KEYRING_NONCE_LEN];

        #[test]
        fn encrypted_cookie_jar_round_trips() {
            let encrypted = keyring_encrypt_with_key(b"SID=secret", &KEY, &NONCE).unwrap();
            assert!(encrypted.starts_with(KEYRING_MAGIC));
            assert_eq!(
                keyring_decrypt_with_key(&encrypted, &KEY).unwrap(),
                b"SID=secret"
            );
        }

        #[test]
        fn tampered_cookie_jar_is_rejected() {
            let mut encrypted = keyring_encrypt_with_key(b"SID=secret", &KEY, &NONCE).unwrap();
            *encrypted.last_mut().unwrap() ^= 1;
            assert!(keyring_decrypt_with_key(&encrypted, &KEY).is_err());
        }

        #[test]
        fn plaintext_cookie_jar_is_accepted_for_migration() {
            assert_eq!(
                keyring_decrypt_with_key(b"SID=legacy", &KEY).unwrap(),
                b"SID=legacy"
            );
        }
    }
}

/// Per-account metadata persisted in `accounts.json`. Cookies are NOT
/// stored here — they live encrypted under `accounts/<id>/cookies.enc`.
/// `name` / `email` / `photo_url` start empty for a freshly logged-in
/// account and get backfilled by the frontend once `/account_menu`
/// returns the active user's info (see `update_account_meta`).
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct Account {
    id: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "photoUrl")]
    photo_url: Option<String>,
    /// Brand-channel identity within this Google account. `None` means
    /// the personal (default) channel. Sent as `X-Goog-PageId` on
    /// InnerTube requests; library, likes and home are scoped to it.
    #[serde(default, rename = "pageId")]
    page_id: Option<String>,
    /// Display meta for the selected channel so the UI can show it
    /// without a network round-trip.
    #[serde(default, rename = "channelName")]
    channel_name: Option<String>,
    #[serde(default, rename = "channelPhotoUrl")]
    channel_photo_url: Option<String>,
    /// Unix seconds when this account was first added.
    #[serde(default, rename = "addedAt")]
    added_at: i64,
}

/// Root document of `accounts.json`. `active` is the id of the
/// currently-selected account or `None` when the user is signed out
/// of everything.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct AccountsIndex {
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    accounts: Vec<Account>,
}

/// What we hand back to the frontend — augments [`Account`] with the
/// derived `isActive` flag so the UI doesn't have to cross-reference
/// against a second field.
#[derive(Clone, Debug, serde::Serialize)]
struct AccountSummary {
    id: String,
    email: String,
    name: String,
    #[serde(rename = "photoUrl")]
    photo_url: Option<String>,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
    #[serde(rename = "channelName")]
    channel_name: Option<String>,
    #[serde(rename = "channelPhotoUrl")]
    channel_photo_url: Option<String>,
    #[serde(rename = "isActive")]
    is_active: bool,
}

fn accounts_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("accounts")
}

fn accounts_index_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("accounts.json")
}

fn account_cookies_path(app: &tauri::AppHandle, id: &str) -> PathBuf {
    accounts_dir(app).join(id).join("cookies.enc")
}

/// Per-account persistent WebView2 profile. Unlike the throwaway login
/// profile of old, this survives a successful sign-in: it holds the
/// live, Google-bound browser session. A periodic hidden reload re-
/// extracts fresh cookies from it (see `refresh_account_cookies`) so the
/// snapshot we replay never outlives Google's ~2h leash on *extracted*
/// cookies. That leash is what made libraries silently empty mid-session.
fn account_webview_dir(app: &tauri::AppHandle, id: &str) -> PathBuf {
    accounts_dir(app).join(id).join("webview")
}

/// Wall-clock second of the last refresh that actually committed a jar for
/// this account, as decimal text.
///
/// This is scheduling state, not a log line: the refresh deadline is derived
/// from it and nothing else, so it has to survive a restart. It lives beside
/// the jar rather than inside it because `dedup_accounts_by_identity` ranks
/// accounts by `cookies.enc`'s mtime, and stamping a timestamp into the jar
/// itself would make a metadata rewrite look like fresher cookies.
fn last_refresh_path(app: &tauri::AppHandle, id: &str) -> PathBuf {
    accounts_dir(app).join(id).join("last-refresh")
}

async fn read_last_refresh(app: &tauri::AppHandle, id: &str) -> Option<i64> {
    tokio::fs::read_to_string(last_refresh_path(app, id))
        .await
        .ok()?
        .trim()
        .parse()
        .ok()
}

async fn write_last_refresh(app: &tauri::AppHandle, id: &str, at: i64) -> Result<(), String> {
    authfs::write_atomic(last_refresh_path(app, id), at.to_string().into_bytes(), 0o600).await
}

/// Browser UA the login and refresh WebViews both present to Google. Kept
/// identical so the session Google issues to the login window is the
/// same one the refresh window later renews. These are outbound fingerprints,
/// not a claim about the host: the non-macOS arm deliberately tells Google it
/// is Chrome on Windows, while WKWebView must present Safari or Google rejects
/// the sign-in as an insecure browser.
#[cfg(not(target_os = "macos"))]
const YT_LOGIN_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
#[cfg(target_os = "macos")]
const YT_LOGIN_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

/// Legacy single-account path — kept only for migration. New code
/// should resolve cookies via `active_cookies_path`.
fn legacy_cookies_enc_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("cookies.enc")
}

/// Why `accounts.json` did not produce an index. "Not there" and "there but
/// unreadable" used to collapse into the same empty default, which reads as
/// signed out AND lets the next sign-in commit its single row over the top
/// of a file that still held every other account.
///
/// The two failures are kept apart because only one of them can be repaired.
/// Bytes that are not an index will never become one; a read that failed
/// says nothing at all about the content and must not be acted on.
enum IndexRead {
    /// No file yet: a genuinely signed-out install.
    Absent,
    Loaded(AccountsIndex),
    /// Present, readable, and not an index. Rebuildable — see
    /// [`rebuild_index_from_disk`].
    Corrupt(String),
    /// Could not be read at all right now (IO, permissions). Never signed
    /// out, and never a reason to rewrite the file.
    Unavailable(String),
}

async fn read_index_checked(app: &tauri::AppHandle) -> IndexRead {
    let path = accounts_index_path(app);
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return IndexRead::Absent,
        Err(e) => return IndexRead::Unavailable(format!("read accounts.json: {e}")),
    };
    match serde_json::from_slice(&bytes) {
        Ok(idx) => IndexRead::Loaded(idx),
        Err(e) => IndexRead::Corrupt(format!("parse accounts.json ({} bytes): {e}", bytes.len())),
    }
}

/// Read-only view for callers that only need the account list. An
/// unreadable index degrades to empty here, which is what every read path
/// already did — the auth answer goes through [`auth_state`] instead, so a
/// corrupt file cannot claim the user is signed out.
async fn read_index(app: &tauri::AppHandle) -> AccountsIndex {
    match read_index_checked(app).await {
        IndexRead::Loaded(idx) => idx,
        IndexRead::Absent => AccountsIndex::default(),
        IndexRead::Corrupt(e) | IndexRead::Unavailable(e) => {
            eprintln!("[accounts] {e}");
            AccountsIndex::default()
        }
    }
}

/// Rebuild `accounts.json` from the account directories on disk.
///
/// Only ever reached for a file that is PRESENT, readable, and not an index
/// — a torn write from before the atomic-write fix, or a truncated restore.
/// Refusing to touch it (the right answer for a transient IO error) is a
/// trap here: every mutation reads through [`read_index_for_update`], sign-in
/// included, so the user would be left with a Sign in button that silently
/// deletes its own result and no way back inside the app.
///
/// The rows come from `accounts/<id>/cookies.enc`, so the other accounts'
/// sessions survive; only their meta is lost, and the frontend backfills the
/// active one on its next `/account_menu`. Active is the account with the
/// newest refresh stamp, because the loop only ever refreshes the active one.
/// The unparseable bytes are set aside, never deleted.
async fn rebuild_index_from_disk(app: &tauri::AppHandle) -> Result<AccountsIndex, String> {
    let path = accounts_index_path(app);
    let quarantine = path.with_extension(format!("json.unreadable-{}", now_ts()));
    tokio::fs::rename(&path, &quarantine)
        .await
        .map_err(|e| format!("set the unreadable accounts.json aside: {e}"))?;

    let mut rows: Vec<(Account, Option<i64>)> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(accounts_dir(app)).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Some(id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let jar = account_cookies_path(app, &id);
            let Ok(meta) = tokio::fs::metadata(&jar).await else {
                continue; // a webview profile with no jar is not an account
            };
            let added_at = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or_else(now_ts, |d| d.as_secs() as i64);
            let last = read_last_refresh(app, &id).await;
            rows.push((
                Account {
                    id,
                    added_at,
                    ..Default::default()
                },
                last,
            ));
        }
    }
    // Oldest first: `added_at` is what dedup ranks by, and pinned-playlist
    // buckets are keyed to the id it keeps.
    rows.sort_by_key(|(a, _)| a.added_at);
    let active = rows
        .iter()
        .filter(|(_, last)| last.is_some())
        .max_by_key(|(_, last)| last.unwrap_or(0))
        .or_else(|| rows.first())
        .map(|(a, _)| a.id.clone());
    let idx = AccountsIndex {
        active,
        accounts: rows.into_iter().map(|(a, _)| a).collect(),
    };
    write_index(app, &idx).await?;
    eprintln!(
        "[accounts] accounts.json was not readable as an index; rebuilt {} row(s) from disk \
         (the previous file is at {})",
        idx.accounts.len(),
        quarantine.display()
    );
    Ok(idx)
}

/// Read for a read-modify-write. Callers hold the index lock across this and
/// the matching `write_index`.
async fn read_index_for_update(app: &tauri::AppHandle) -> Result<AccountsIndex, String> {
    match read_index_checked(app).await {
        IndexRead::Loaded(idx) => Ok(idx),
        IndexRead::Absent => Ok(AccountsIndex::default()),
        IndexRead::Corrupt(e) => {
            eprintln!("[accounts] {e}");
            rebuild_index_from_disk(app).await
        }
        // Overwriting on this would delete every account row over a
        // transient IO error, which is the failure the split exists for.
        IndexRead::Unavailable(e) => Err(format!("{e}; refusing to overwrite it")),
    }
}

/// Every account id with state on disk: the rows in the index plus any
/// `accounts/<id>/` directory, so an unreadable index still names everything
/// a wipe has to lock.
async fn account_ids_on_disk(app: &tauri::AppHandle) -> Vec<String> {
    let mut ids: Vec<String> = match read_index_checked(app).await {
        IndexRead::Loaded(idx) => idx.accounts.into_iter().map(|a| a.id).collect(),
        _ => Vec::new(),
    };
    if let Ok(mut entries) = tokio::fs::read_dir(accounts_dir(app)).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Some(name) = entry.file_name().to_str() {
                if !ids.iter().any(|i| i == name) {
                    ids.push(name.to_string());
                }
            }
        }
    }
    ids
}

async fn write_index(app: &tauri::AppHandle, idx: &AccountsIndex) -> Result<(), String> {
    let path = accounts_index_path(app);
    let bytes = serde_json::to_vec_pretty(idx).map_err(|e| format!("serialize: {e}"))?;
    authfs::write_atomic(path, bytes, 0o600).await
}

/// One-time migration: if a plaintext `cookies.txt` from a previous
/// version exists, encrypt its contents into `cookies.enc` and remove
/// the original. Best-effort: logs on failure but never blocks startup.
async fn migrate_plaintext_cookies(app: &tauri::AppHandle) {
    let enc_path = legacy_cookies_enc_path(app);
    let old_path = enc_path.with_file_name("cookies.txt");
    if enc_path.exists() || !old_path.exists() {
        return;
    }
    let Ok(plain) = tokio::fs::read(&old_path).await else {
        return;
    };
    match secure_store::encrypt(&plain) {
        Ok(enc) => {
            // Atomic like every other jar write: the plaintext original is
            // deleted right after, so a torn write here would be the one
            // that has nothing to fall back to.
            if let Err(e) = authfs::write_atomic(enc_path.clone(), enc, 0o600).await {
                eprintln!("[auth] migration write failed: {e}");
                return;
            }
            let _ = tokio::fs::remove_file(&old_path).await;
            eprintln!("[auth] migrated plaintext cookies.txt to encrypted cookies.enc");
        }
        Err(e) => eprintln!("[auth] migration encrypt failed: {e}"),
    }
}

/// Promote a legacy single-account `cookies.enc` to the new
/// `accounts/<id>/cookies.enc` layout. Runs after the plaintext
/// migration so a fresh install with no state at all hits a clean
/// no-op. Account meta (email / name / photo) is left empty — the
/// frontend backfills it on the first `/account_menu` round-trip.
async fn migrate_to_accounts_layout(app: &tauri::AppHandle) {
    let index_path = accounts_index_path(app);
    if index_path.exists() {
        return; // already migrated
    }
    let legacy = legacy_cookies_enc_path(app);
    if !legacy.exists() {
        // No legacy state and no new state — signed-out fresh install.
        return;
    }
    let new_id = generate_account_id();
    let new_path = account_cookies_path(app, &new_id);
    if let Some(dir) = new_path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(dir).await {
            eprintln!("[auth] migrate accounts: mkdir failed: {e}");
            return;
        }
    }
    if let Err(e) = tokio::fs::rename(&legacy, &new_path).await {
        eprintln!("[auth] migrate accounts: rename failed: {e}");
        return;
    }
    let idx = AccountsIndex {
        active: Some(new_id.clone()),
        accounts: vec![Account {
            id: new_id.clone(),
            added_at: now_ts(),
            ..Default::default()
        }],
    };
    let locks = app.state::<authfs::MutationLocks>();
    let _index = locks.inner().index().await;
    if let Err(e) = write_index(app, &idx).await {
        eprintln!("[auth] migrate accounts: write index failed: {e}");
        return;
    }
    eprintln!("[auth] migrated single cookies.enc into accounts/{new_id}/");
}

/// Wall-clock seconds. The refresh deadline and every cookie expiry are
/// wall time on purpose: a monotonic clock does not advance while the
/// machine sleeps, and Google's leash on an extracted cookie does.
fn now_ts() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// Wall-clock nanoseconds, used only as a jitter seed.
fn jitter_seed() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp_nanos() as i64
}

fn generate_account_id() -> String {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    // Unix-nanos is monotone within a process; a stray clock skew on
    // another machine isn't a concern (account ids stay local).
    format!("acct-{:x}", nanos)
}

/// Why an account's jar did not decrypt. Collapsing these into `None` is
/// how a dark wake used to report a signed-in user as signed out: on macOS
/// the jar's AES key lives in the login keychain, and reading it needs a UI
/// session, so decrypt fails while the session itself is perfectly fine.
enum JarRead {
    /// No jar on disk for this account.
    Absent,
    Loaded(String),
    /// The jar exists but we could not read it right now. Never signed out.
    Unavailable(String),
}

/// The one question every part of the auth path asks: can this jar
/// authenticate an InnerTube request? Going through a single helper is the
/// point — the capture gate, the commit's continuity check, `is_logged_in`
/// and the yt-dlp export all used to test different things, so a jar could
/// be captured, committed, and then reported as signed out.
fn jar_credentials(jar: &str) -> session::Credentials {
    session::inspect_jar(jar, "music.youtube.com", session::INNERTUBE_PATH, now_ts())
}

async fn read_jar(app: &tauri::AppHandle, id: &str) -> JarRead {
    let path = account_cookies_path(app, id);
    let encrypted = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return JarRead::Absent,
        Err(e) => return JarRead::Unavailable(format!("read cookie jar: {e}")),
    };
    let plain = match tokio::task::spawn_blocking(move || secure_store::decrypt(&encrypted)).await {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => return JarRead::Unavailable(format!("decrypt cookie jar: {e}")),
        Err(e) => return JarRead::Unavailable(format!("decrypt task: {e}")),
    };
    match String::from_utf8(plain) {
        Ok(s) => JarRead::Loaded(s),
        Err(_) => JarRead::Unavailable("cookie jar is not valid UTF-8".into()),
    }
}

async fn read_active_jar(app: &tauri::AppHandle) -> JarRead {
    match read_index_checked(app).await {
        IndexRead::Corrupt(e) | IndexRead::Unavailable(e) => JarRead::Unavailable(e),
        IndexRead::Absent => JarRead::Absent,
        IndexRead::Loaded(idx) => match idx.active {
            None => JarRead::Absent,
            Some(id) => read_jar(app, &id).await,
        },
    }
}

/// Decrypted jar for the active account, or `None` when there is nothing to
/// read. Kept for the callers that genuinely have no better answer than
/// "carry on anonymously"; anything that decides what the UI shows must use
/// [`read_active_jar`] so an unavailable jar stays distinguishable.
async fn read_cookies_plain(app: &tauri::AppHandle) -> Option<String> {
    match read_active_jar(app).await {
        JarRead::Loaded(jar) => Some(jar),
        JarRead::Absent => None,
        JarRead::Unavailable(e) => {
            eprintln!("[auth] {e}");
            None
        }
    }
}

/// Write the decrypted cookie jar somewhere yt-dlp can read it, and
/// return that path.
///
/// The jar is already stored in Netscape format, so this is a decrypt
/// and a write, not a conversion. It buys two things, both measured on
/// 2026-08-26 against this account:
///
///   * Premium-only tracks. Anonymous yt-dlp gets `UNPLAYABLE: only
///     available to Music Premium members` and the handler 502s.
///   * Bitrate. Anonymous tops out at itag 140 (130k AAC). Authenticated
///     exposes itag 141 (258k AAC) and 774 (271k Opus) — roughly double,
///     on every track, not just gated ones.
///
/// The old warning that authenticating yt-dlp trips bot detection and
/// strips every real format was retested and did not reproduce: an
/// ordinary track authenticated returned the full ladder and downloaded
/// real bytes.
///
/// Returns None when signed out, and every caller treats that as "spawn
/// anonymously" rather than an error — a cookie problem must never be
/// able to take playback down with it.
async fn ytdlp_cookie_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let id = read_index(app).await.active?;
    let JarRead::Loaded(jar) = read_jar(app, &id).await else {
        return None;
    };
    // Same exact-name predicate the rest of the app uses. The old test here
    // was `jar.contains("SAPISID")`, a substring search of a tab-delimited
    // FILE: it matched a cookie value, matched a google.com-only SAPISID
    // that music.youtube.com never sees, and missed a jar holding only
    // __Secure-3PAPISID — which the frontend signs with happily.
    //
    // `signable` and not the full set: yt-dlp builds its SAPISIDHASH from
    // the same signing cookies we do and never looks at LOGIN_INFO, so
    // withholding the file over a missing marker would cost Premium tracks
    // and drop every other track from 258k/271k to 130k for nothing.
    if !jar_credentials(&jar).signable() {
        // A jar with no signing cookie buys nothing and would only add a
        // failure mode.
        return None;
    }
    let dir = app.path().app_data_dir().ok()?.join("ytdlp-cookies");
    let path = dir.join("cookies.txt");
    // yt-dlp rewrites this file when YouTube rotates a cookie mid-run, so
    // it has to be our own copy and never the real jar.
    //
    // 0600 from creation, not a chmod afterwards: this is the decrypted
    // session, and the old order left it world-readable for the length of
    // the write. FOLLOW-UP (not in this change): all three callers share
    // this one path, so two concurrent tracks still overwrite each other's
    // copy — harmless today because they write the same jar, and yt-dlp's
    // own mid-run rewrites are already discarded rather than merged back.
    let locks = app.state::<authfs::MutationLocks>();
    let _guard = locks.inner().account(&id).await;
    if let Err(e) = authfs::write_atomic(path.clone(), jar.into_bytes(), 0o600).await {
        eprintln!("[auth] yt-dlp cookie export: {e}");
        return None;
    }
    Some(path)
}

/// Serialize a list of cookies into the Netscape cookie-jar format that
/// yt-dlp and our reader expect. Only keeps cookies for google/youtube
/// domains — that's all the auth flow touches.
fn cookies_to_netscape(cookies: &[cookie::Cookie<'static>]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for c in cookies {
        let Some(domain) = c.domain() else { continue };
        let bare = domain.trim_start_matches('.');
        let allowed = bare == "youtube.com"
            || bare.ends_with(".youtube.com")
            || bare == "google.com"
            || bare.ends_with(".google.com");
        if !allowed {
            continue;
        }
        // Normalize: always emit with leading dot + subdomains=TRUE.
        // Auth cookies are all subdomain-inclusive by design, and modern
        // webviews expose domains inconsistently (with / without the
        // leading dot). Emitting `domain\tFALSE` for `.youtube.com`
        // would make parsers treat it as an exact-host cookie, which
        // would silently skip SAPISID for `music.youtube.com`.
        let dom_out = format!(".{bare}");
        let include_sub = "TRUE";
        let path_str = c.path().unwrap_or("/");
        let secure = if c.secure().unwrap_or(false) {
            "TRUE"
        } else {
            "FALSE"
        };
        let expiry = match c.expires() {
            Some(cookie::Expiration::DateTime(dt)) => dt.unix_timestamp(),
            _ => 0,
        };
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            dom_out,
            include_sub,
            path_str,
            secure,
            expiry,
            c.name(),
            c.value()
        ));
    }
    out
}

/// One line of a Netscape jar, kept as stored so a rewrite preserves
/// entries we don't touch byte-for-byte.
struct JarEntry {
    domain: String,
    include_sub: String,
    path: String,
    secure: String,
    expiry: i64,
    name: String,
    value: String,
}

/// Apply `Set-Cookie` response headers to a Netscape jar, the way a
/// browser would: update the value/expiry of a cookie we already hold,
/// add cookies we don't, and drop cookies the server expires
/// (`Max-Age=0` / past `Expires`). Only google/youtube domains are
/// accepted — same filter as the login capture.
///
/// Returns `(new_jar, value_changed, needs_write)`:
/// `value_changed` — a cookie value was replaced, added or removed, so
/// cached Cookie headers are stale; `needs_write` additionally covers
/// attribute-only refreshes (expiry bumps) that should persist but
/// don't invalidate caches.
fn merge_set_cookies_into_jar(
    jar: &str,
    set_cookies: &[String],
    host: &str,
    now_ts: i64,
) -> (String, bool, bool) {
    let mut entries: Vec<JarEntry> = Vec::new();
    for line in jar.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 7 {
            continue;
        }
        entries.push(JarEntry {
            domain: f[0].to_string(),
            include_sub: f[1].to_string(),
            path: f[2].to_string(),
            secure: f[3].to_string(),
            expiry: f[4].parse().unwrap_or(0),
            name: f[5].to_string(),
            value: f[6].to_string(),
        });
    }

    let mut value_changed = false;
    let mut needs_write = false;

    for raw in set_cookies {
        let Ok(c) = cookie::Cookie::parse(raw.trim()) else {
            continue;
        };
        // Host-only cookies (no Domain attribute) belong to the
        // responding host.
        let bare = c
            .domain()
            .unwrap_or(host)
            .trim_start_matches('.')
            .to_ascii_lowercase();
        let allowed = bare == "youtube.com"
            || bare.ends_with(".youtube.com")
            || bare == "google.com"
            || bare.ends_with(".google.com");
        if !allowed {
            continue;
        }
        // RFC 6265 §5.3.5: a response may only set a cookie on its own host
        // or on a domain that host sits under. The allowlist above is not
        // that check — it accepts any google/youtube domain from any
        // google/youtube host, so a music.youtube.com response could plant a
        // cookie on accounts.google.com and we would then replay it to
        // Google as though Google had issued it.
        let host_bare = host.trim_start_matches('.').to_ascii_lowercase();
        if host_bare != bare && !host_bare.ends_with(&format!(".{bare}")) {
            continue;
        }

        // Max-Age wins over Expires (RFC 6265 §4.1.2.2); either in the
        // past is a deletion.
        let (remove, expiry) = if let Some(ma) = c.max_age() {
            let secs = ma.whole_seconds();
            (secs <= 0, now_ts.saturating_add(secs))
        } else if let Some(cookie::Expiration::DateTime(dt)) = c.expires() {
            let ts = dt.unix_timestamp();
            (ts <= now_ts, ts)
        } else {
            (false, 0) // session cookie
        };

        // Stored cookies are keyed by name + domain here, not name + domain
        // + path as RFC 6265 §5.3 has it. Every Google auth cookie is issued
        // at the site root, so the two agree in practice — and where they
        // would not, the session predicate path-matches properly anyway
        // (see session::JarCookie::matches_path), so a path-scoped
        // look-alike can never stand in for a credential.
        let pos = entries
            .iter()
            .position(|e| e.name == c.name() && e.domain.trim_start_matches('.') == bare);

        if remove {
            if let Some(i) = pos {
                entries.remove(i);
                value_changed = true;
            }
            continue;
        }

        match pos {
            Some(i) => {
                let e = &mut entries[i];
                if e.value != c.value() {
                    e.value = c.value().to_string();
                    value_changed = true;
                }
                if e.expiry != expiry {
                    e.expiry = expiry;
                    needs_write = true;
                }
            }
            None => {
                entries.push(JarEntry {
                    domain: format!(".{bare}"),
                    include_sub: "TRUE".to_string(),
                    path: c.path().unwrap_or("/").to_string(),
                    secure: if c.secure().unwrap_or(false) {
                        "TRUE"
                    } else {
                        "FALSE"
                    }
                    .to_string(),
                    expiry,
                    name: c.name().to_string(),
                    value: c.value().to_string(),
                });
                value_changed = true;
            }
        }
    }

    needs_write |= value_changed;
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for e in &entries {
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            e.domain, e.include_sub, e.path, e.secure, e.expiry, e.name, e.value
        ));
    }
    (out, value_changed, needs_write)
}

/// Stable "same account" key derived from an account's backfilled meta.
/// Prefers the email; when that's empty (brand-channel identities, and
/// some accounts, omit it from `/account_menu`) it falls back to the
/// avatar URL, whose `yt3.ggpht.com/-<token>` base is stable per
/// account. Returns `None` when neither is known, so two accounts we
/// can't tell apart are never merged.
///
/// Cookie values can't serve as the key: every login runs in an
/// isolated WebView profile, so Google mints a fresh SAPISID/SID
/// session each time and the same account lands a different value on
/// each add.
fn meta_identity(email: &str, photo_url: Option<&str>) -> Option<String> {
    let email = email.trim();
    if !email.is_empty() {
        return Some(format!("email:{}", email.to_ascii_lowercase()));
    }
    if let Some(p) = photo_url {
        // Drop the "=s108-c-k-..." sizing suffix so the same avatar at
        // different requested sizes still compares equal.
        let base = p.split('=').next().unwrap_or(p).trim();
        if !base.is_empty() {
            return Some(format!("photo:{base}"));
        }
    }
    None
}

/// Collapse duplicate account rows that are the same Google account.
/// Re-adding an account you already have (or a stale/expired re-login)
/// used to append a fresh row that never merged, because dedup keyed on
/// an email that `/account_menu` often leaves empty. This heals that
/// state from the stored meta: within each set of rows sharing an
/// identity (see `meta_identity`) it keeps the earliest-added one
/// (stable id, so pinned-playlist buckets survive), copies the freshest
/// cookies into it, and drops the rest off disk. A row we can't identify
/// (no email, no avatar) is left untouched rather than risk merging two
/// real accounts.
///
/// Does not emit `accounts-changed`: callers either run it before the
/// UI reads the list (startup) or emit the event themselves.
async fn dedup_accounts_by_identity(app: &tauri::AppHandle) {
    let locks = app.state::<authfs::MutationLocks>();
    let _index = locks.inner().index().await;
    let mut idx = match read_index_for_update(app).await {
        Ok(idx) => idx,
        Err(e) => {
            eprintln!("[accounts] dedup: {e}");
            return;
        }
    };
    if idx.accounts.len() < 2 {
        return;
    }

    // Identity per row from its stored meta, same order as idx.accounts.
    let identities: Vec<Option<String>> = idx
        .accounts
        .iter()
        .map(|a| meta_identity(&a.email, a.photo_url.as_deref()))
        .collect();

    // Group row indices by identity.
    let mut groups: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    for (i, ident) in identities.iter().enumerate() {
        if let Some(key) = ident {
            groups.entry(key.clone()).or_default().push(i);
        }
    }

    // removed id -> keeper id, so `active` can follow its keeper.
    let mut remap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // (source id, keeper id) jars to copy before deleting the source.
    let mut fresh_copies: Vec<(String, String)> = Vec::new();

    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        // Keep the earliest-added row: its id is the one pins are keyed
        // to, and it's the account the user has had the longest.
        let keeper = *members
            .iter()
            .min_by_key(|&&i| idx.accounts[i].added_at)
            .unwrap();
        let keeper_id = idx.accounts[keeper].id.clone();

        // Freshest cookies: the jar written most recently. After a
        // re-login that's the keeper itself (login-time dedup refreshed
        // it in place, so no copy happens); when healing a pile of
        // legacy dups it's whichever login was most recent, the one
        // most likely to still authenticate. Falls back to the keeper
        // if no jar's mtime can be read.
        let mut freshest = keeper;
        let mut best_mtime: Option<std::time::SystemTime> = None;
        for &i in members {
            let p = account_cookies_path(app, &idx.accounts[i].id);
            let mtime = tokio::fs::metadata(&p)
                .await
                .ok()
                .and_then(|m| m.modified().ok());
            if let Some(t) = mtime {
                if best_mtime.map_or(true, |b| t > b) {
                    best_mtime = Some(t);
                    freshest = i;
                }
            }
        }
        let fresh_id = idx.accounts[freshest].id.clone();
        if fresh_id != keeper_id {
            fresh_copies.push((fresh_id, keeper_id.clone()));
        }

        for &i in members {
            if i != keeper {
                remap.insert(idx.accounts[i].id.clone(), keeper_id.clone());
            }
        }
    }

    if remap.is_empty() {
        return;
    }

    for (from_id, keeper_id) in &fresh_copies {
        let from_path = account_cookies_path(app, from_id);
        let keep_path = account_cookies_path(app, keeper_id);
        let Ok(bytes) = tokio::fs::read(&from_path).await else {
            eprintln!("[accounts] dedup: could not read {from_id}'s jar; keeping {keeper_id}'s");
            continue;
        };
        // Lock order: the index lock is already held, and an account lock is
        // taken under it. Never the reverse (see authfs::MutationLocks).
        let _jar = locks.inner().account(keeper_id).await;
        if let Err(e) = authfs::write_atomic(keep_path, bytes, 0o600).await {
            eprintln!("[accounts] dedup: copy jar {from_id} -> {keeper_id}: {e}");
        }
        // The refresh stamp deliberately does NOT move with the jar: an
        // account that just absorbed someone else's snapshot should renew it
        // once, promptly, rather than trust a deadline set for the row that
        // is about to be deleted.
        let _ = tokio::fs::remove_file(last_refresh_path(app, keeper_id)).await;
    }

    if let Some(active) = idx.active.clone() {
        if let Some(keeper) = remap.get(&active) {
            idx.active = Some(keeper.clone());
        }
    }

    idx.accounts.retain(|a| !remap.contains_key(&a.id));

    // Persist the collapsed index BEFORE deleting the losers' jars. If
    // the app dies in between, an orphan dir is invisible litter; the
    // reverse order could leave the index pointing at deleted jars and
    // boot the app signed out.
    let removed = remap.len();
    if let Err(e) = write_index(app, &idx).await {
        eprintln!("[accounts] dedup write index: {e}");
        return;
    }
    for rid in remap.keys() {
        // Same reason as the other deletion paths: a refresh committing
        // under this lock re-creates whatever directory it writes into.
        let _jar = locks.inner().account(rid).await;
        let _ = tokio::fs::remove_dir_all(accounts_dir(app).join(rid)).await;
    }
    eprintln!("[accounts] collapsed {removed} duplicate account row(s) by identity");
}

/// Best-effort cleanup of transient login artifacts, run once per boot:
///
/// - leftover per-login WebView profiles under `login-sessions/`. The
///   post-login `remove_dir_all` regularly loses to WebView2 file locks
///   (the browser subprocess outlives the window for a beat), and each
///   stranded profile holds a signed-in Google session on disk. At boot
///   no login window exists, so the locks are gone and deletion sticks.
/// - the http plugin's `.cookies` store from builds where its `cookies`
///   feature was still on: plaintext session-security cookies, and the
///   shadow copy that fed the rotation-divergence bug.
async fn cleanup_login_artifacts(app: &tauri::AppHandle) {
    let cache = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    if let Ok(mut sessions) = tokio::fs::read_dir(cache.join("login-sessions")).await {
        while let Ok(Some(entry)) = sessions.next_entry().await {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
    let _ = tokio::fs::remove_file(cache.join(".cookies")).await;

    // Temp files from a run that died mid-write (see authfs). Inert — a
    // temp is nothing's destination — this just stops them accumulating.
    if let Some(root) = accounts_index_path(app).parent() {
        authfs::sweep_stale_temps(root).await;
    }
    if let Ok(mut accounts) = tokio::fs::read_dir(accounts_dir(app)).await {
        while let Ok(Some(entry)) = accounts.next_entry().await {
            authfs::sweep_stale_temps(&entry.path()).await;
        }
    }
}

/// Open an in-app Google sign-in window in an isolated WebView profile
/// and add the resulting cookies as a new account. Polls the (fresh)
/// webview cookie store until YouTube auth cookies appear, encrypts
/// them, writes them to `accounts/<id>/cookies.enc`, registers the
/// account in `accounts.json`, and marks it active.
///
/// Isolation matters: without it, "add another account" instantly
/// succeeds with whatever Google session is already in the shared
/// WebView2 user data dir — and there's no way for the user to pick a
/// different identity. The temp profile is deleted on close (success
/// or cancellation); our encrypted jar is the canonical store.
///
/// Emits `login-success` (payload: new account id) on success and
/// `login-cancelled` on close-without-auth.
///
/// We deliberately do NOT emit `accounts-changed` here. The newly-
/// added account has empty meta and may not even survive the next
/// step: the frontend's meta backfill calls `update_account_meta`,
/// which is when we find out via an identity lookup (email, or avatar
/// when the email is empty) whether this is genuinely a new account or
/// a re-sign-in of an existing one. That
/// command emits `accounts-changed` for both cases, and the global
/// listener does its full reset there. Firing the event twice was the
/// "double-reset on dedup" UX bug.
#[tauri::command]
async fn start_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("login") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    // Per-attempt account id, minted up front so the WebView profile can
    // live at its permanent home from the first keystroke. Still fresh
    // per attempt (a unique id), so Google's auth cookies are empty at
    // window open and "add account" starts from a clean sign-in, so
    // identity isolation is preserved. Unlike the old throwaway temp
    // profile, we KEEP this one after a successful login: it holds the
    // live, Google-bound session that `refresh_account_cookies` re-
    // extracts from periodically, so the replayed snapshot never outlives
    // Google's ~2h leash on extracted cookies.
    let account_id = generate_account_id();
    let webview_data = account_webview_dir(&app, &account_id);
    if let Err(e) = tokio::fs::create_dir_all(&webview_data).await {
        eprintln!("[login] mkdir webview-data: {e}");
    }
    // Wiped wholesale on cancel/error (profile + any partial jar); kept
    // on success.
    let account_dir = accounts_dir(&app).join(&account_id);

    // Hoisted so the case-(2) nudge below can replay the exact same URL.
    const SERVICE_LOGIN_URL: &str =
        "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";
    let url = SERVICE_LOGIN_URL
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;

    let win = WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(url))
        .title("Sign in - accounts.google.com")
        .inner_size(500.0, 720.0)
        .min_inner_size(420.0, 560.0)
        .center()
        .data_directory(webview_data.clone())
        // The constant, not a literal. It used to carry its own macOS
        // branch pinned to Safari 17.4 while the keeper sent 17.6, so the
        // session was minted under one browser and renewed under another —
        // exactly the login/refresh divergence Google reads as replay.
        .user_agent(YT_LOGIN_UA)
        // Surface the current origin in the title so the user can spot
        // a redirect to an unexpected host (anti-phishing).
        .on_page_load(|win, payload| {
            let host = payload.url().host_str().unwrap_or("???");
            let _ = win.set_title(&format!("Sign in - {host}"));
        })
        .build()
        .map_err(|e| e.to_string())?;

    let app_poll = app.clone();
    // Failure paths wipe the whole account dir (profile + jar); on
    // success we keep it so the live session can be refreshed later.
    let cleanup_dir = account_dir.clone();
    tauri::async_runtime::spawn(async move {
        // Set to true once we've redirected the webview to YT ourselves.
        // Guards against thrashing if YT auto-sign-in is slow and we
        // catch a Google-auth-only state on multiple ticks.
        let mut nudged_to_yt = false;
        // Ticks spent waiting for the handshake to finish after auth
        // cookies first appear (see below).
        let mut full_set_grace: u8 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;

            let Some(win) = app_poll.get_webview_window("login") else {
                let _ = app_poll.emit("login-cancelled", ());
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            };

            let cookies = match win.cookies() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[login] cookies error: {e}");
                    continue;
                }
            };

            // The same predicate `is_logged_in` will answer with, over the
            // same serialization we are about to commit. It used to be an
            // ad-hoc `__Secure-1PSID || SAPISID` test, and `__Secure-1PSID`
            // is not a cookie this client can sign with: a jar captured on
            // it alone committed happily and then read back as signed out,
            // showing a Sign in button to a user who had just signed in.
            let netscape = cookies_to_netscape(&cookies);
            let creds = jar_credentials(&netscape);

            if !creds.signable() {
                // No signing cookie on youtube.com yet. Two ways to land
                // here:
                //   1) User hasn't completed Google sign-in. Keep waiting.
                //   2) Google sign-in succeeded but Google parked the
                //      webview on `myaccount.google.com` (first-time
                //      security review / "stay signed in?" prompt) and
                //      never honored the `continue=music.youtube.com`
                //      hint. The user is stuck on a Google settings
                //      page and YT never gets a chance to handshake.
                //
                // For case (2), replay the ServiceLogin URL. With a
                // live Google session, Google's own redirect chain
                // bridges the .google.com cookies into the .youtube.com
                // cookies InnerTube needs. Navigating straight to
                // music.youtube.com instead relied on YT's client-side
                // auto-sign-in, which upstream measured completing only
                // about half the time and otherwise leaving the user on
                // a bare page with no way forward.
                if !nudged_to_yt {
                    let has_google_auth = cookies.iter().any(|c| {
                        let name = c.name();
                        (name == "SAPISID" || name == "SID" || name == "__Secure-1PSID")
                            && c.domain()
                                .map(|d| d.trim_start_matches('.').ends_with("google.com"))
                                .unwrap_or(false)
                    });
                    if has_google_auth {
                        if let Ok(url) = SERVICE_LOGIN_URL.parse::<tauri::Url>() {
                            match win.navigate(url) {
                                Ok(()) => eprintln!(
                                    "[login] google-auth detected without YT cookies; replayed ServiceLogin so Google bridges the youtube.com cookies"
                                ),
                                Err(e) => eprintln!(
                                    "[login] failed to redirect to YT: {e}"
                                ),
                            }
                        }
                        nudged_to_yt = true;
                    }
                }
                continue;
            }

            // SAPISID shows up before YouTube finishes its handshake;
            // capturing at first sight used to miss LOGIN_INFO /
            // VISITOR_INFO1_LIVE / YSC. Those make our replayed traffic
            // look like the browser session Google issued it to, so
            // give the handshake a few ticks to complete. Capture
            // anyway after ~6 s in case the cookie set changes shape —
            // the jar is already signable by this point, which is what
            // decides whether the app can authenticate with it.
            if !creds.complete() && full_set_grace < 4 {
                full_set_grace += 1;
                continue;
            }

            // Same id as the persisted WebView profile created above, so
            // the account row and its live session profile stay paired.
            let new_id = account_id.clone();
            let cookies_path = account_cookies_path(&app_poll, &new_id);
            let plain = netscape.into_bytes();
            let encrypted =
                match tokio::task::spawn_blocking(move || secure_store::encrypt(&plain)).await {
                    Ok(Ok(e)) => e,
                    // Both bail-outs emit `login-cancelled`: it is the only
                    // event that clears the Sign in spinner, and without it
                    // a failed encrypt left the button spinning forever.
                    Ok(Err(e)) => {
                        eprintln!("[login] encrypt cookies: {e}");
                        let _ = app_poll.emit("login-cancelled", ());
                        let _ = win.close();
                        let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                        return;
                    }
                    Err(e) => {
                        eprintln!("[login] encrypt join: {e}");
                        let _ = app_poll.emit("login-cancelled", ());
                        let _ = win.close();
                        let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                        return;
                    }
                };
            let locks = app_poll.state::<authfs::MutationLocks>();
            // Scoped: the index lock is taken below, and an account lock is
            // never held across that (see authfs::MutationLocks).
            let jar_written = {
                let _jar = locks.inner().account(&new_id).await;
                authfs::write_atomic(cookies_path.clone(), encrypted, 0o600).await
            };
            if let Err(e) = jar_written {
                eprintln!("[login] write account cookies: {e}");
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                let _ = app_poll.emit("login-cancelled", ());
                return;
            }
            // Cookies straight out of the login window ARE a fresh snapshot,
            // so start the refresh deadline here rather than making the
            // keeper reload 20 seconds after a sign-in.
            let _ = write_last_refresh(&app_poll, &new_id, now_ts()).await;

            let _index = locks.inner().index().await;
            let mut idx = match read_index_for_update(&app_poll).await {
                Ok(idx) => idx,
                Err(e) => {
                    eprintln!("[login] read index: {e}");
                    let _ = app_poll.emit("login-cancelled", ());
                    let _ = win.close();
                    let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                    return;
                }
            };
            idx.accounts.push(Account {
                id: new_id.clone(),
                added_at: now_ts(),
                ..Default::default()
            });
            idx.active = Some(new_id.clone());
            if let Err(e) = write_index(&app_poll, &idx).await {
                // We've already written the cookies file; not fatal but
                // visible to the user as "account didn't appear in
                // list". Surface it through the cancel event so the
                // frontend at least flips out of the spinning state.
                eprintln!("[login] write index: {e}");
                let _ = app_poll.emit("login-cancelled", ());
                let _ = tokio::fs::remove_dir_all(
                    &account_cookies_path(&app_poll, &new_id)
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_default(),
                )
                .await;
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            }

            // `login-success` is the soft signal: the frontend invalidates
            // its auth queries so the meta backfill runs with the new
            // cookies. The follow-up `update_account_meta` call is where
            // dedup happens (by identity, email or avatar) and where
            // `accounts-changed` fires, so we never run the full reset
            // twice for one login flow.
            let _ = app_poll.emit("login-success", &new_id);
            let _ = win.close();
            // Keep the WebView profile: it's the live session the periodic
            // refresh re-extracts from. Only cancel/error paths above (and
            // account removal) delete it.
            return;
        }
    });

    let _ = win;
    Ok(())
}

/// Page loads the session-keeper has finished, process-wide.
///
/// The refresh has no other evidence that the keeper reached Google:
/// `WebviewWindow::navigate` is fire-and-forget, so with no network it
/// returns `Ok` and the page never loads, while the keeper's persisted
/// cookie store keeps answering with whatever it already held. On macOS
/// this counter follows `webView:didFinishNavigation:`, which a failed
/// provisional navigation never reaches.
static KEEPER_PAGE_LOADS: AtomicU64 = AtomicU64::new(0);

/// The live "session-keeper" WebView for `id`: a hidden window on
/// music.youtube.com that reuses the account's persisted profile. As a
/// real browser engine it stays authenticated from the stored session and
/// keeps the server-side session (and its rotating cookies) warm, which
/// plain HTTP replay cannot do. Built ONCE and reused; any keeper left
/// over from a previously-active account is closed first, so at most one
/// runs at a time. Returns (window, just_created).
async fn ensure_session_keeper(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<(tauri::WebviewWindow, bool), String> {
    if !account_webview_dir(app, id).exists() {
        return Err(format!("no persisted profile for {id}"));
    }
    let label = format!("keeper-{id}");
    // Close a stale keeper left over from a previously-active account, so
    // at most one keeper (the active account's) ever runs.
    for (l, w) in app.webview_windows() {
        if l.starts_with("keeper-") && l != label {
            let _ = w.close();
        }
    }
    if let Some(win) = app.get_webview_window(&label) {
        return Ok((win, false));
    }
    let url = "https://music.youtube.com/"
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;
    // Hidden, undecorated, focus-less, off-screen, no taskbar entry. Built
    // once and reused (not re-created every cycle), so there is no recurring
    // window creation to flash on screen; the window-state plugin is told to
    // never restore keeper windows (see `with_filter` in `run`), so a saved
    // "visible" state can't drag it back on-screen next launch either. The
    // webview still loads and keeps the session alive regardless of
    // visibility or position.
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("YTubic session keeper")
        .visible(false)
        .decorations(false)
        .focused(false)
        .skip_taskbar(true)
        .position(-32000.0, -32000.0)
        .inner_size(1024.0, 768.0)
        .data_directory(account_webview_dir(app, id))
        .user_agent(YT_LOGIN_UA)
        // Registered on the webview, so it fires for every later
        // `navigate()` too — which is what lets a refresh tell "reloaded
        // and Google answered" from "offline, nothing happened".
        .on_page_load(|_win, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                KEEPER_PAGE_LOADS.fetch_add(1, Ordering::Relaxed);
            }
        })
        .build()
        .map_err(|e| format!("build session-keeper: {e}"))?;
    // Force-hide on top of visible(false): if WebView2 shows the host window
    // when the external page finishes loading, this puts it straight back to
    // hidden so the user never sees a stray music.youtube.com window.
    let _ = win.hide();
    Ok((win, true))
}

/// Refresh the replayed cookie snapshot for `id` from its live session-
/// keeper WebView. Reloads the keeper to force fresh authenticated
/// requests (which renews the session and rotates its short-lived
/// cookies), reads the full cookie set, and overwrites `cookies.enc`. The
/// keeper window is left OPEN for next time.
///
/// This is what survives Google's ~2h leash on *extracted* cookies: the
/// bound browser session behind the keeper stays live, so the snapshot we
/// replay never goes stale.
///
/// Every path that is not [`RefreshOutcome::Committed`] leaves the existing
/// jar and its success stamp exactly as they were, so we never clobber a
/// usable jar with an empty one and never let a failed attempt look like a
/// completed refresh.
async fn refresh_account_cookies(app: &tauri::AppHandle, id: &str) -> RefreshOutcome {
    // Serialize refreshes so the periodic timer and a manual trigger can't
    // reload the keeper / rewrite the jar on top of each other.
    let guard = app.state::<RefreshGuard>();
    let _lock = guard.inner().0.lock().await;

    // Probe the credential store BEFORE building a window or reloading the
    // keeper. On macOS the jar's AES key lives in the login keychain and
    // reading it needs a UI session, so in a dark wake this is the first
    // thing that fails — and finding out here costs one keychain read
    // instead of eighteen seconds of polling a webview that cannot load.
    if let Err(e) = credential_store_ready().await {
        return RefreshOutcome::Deferred(e);
    }

    // Read before the keeper exists, so a just-built one's first load counts.
    let loads_before = KEEPER_PAGE_LOADS.load(Ordering::Relaxed);
    let (win, created) = match ensure_session_keeper(app, id).await {
        Ok(v) => v,
        Err(e) if session::is_environment_unavailable(&e) => {
            return RefreshOutcome::Deferred(e)
        }
        Err(e) => return RefreshOutcome::Failed(e),
    };
    // A reused keeper is reloaded to force fresh authenticated traffic; a
    // just-created one is already loading the URL from the builder.
    if !created {
        if let Ok(u) = "https://music.youtube.com/".parse::<tauri::Url>() {
            let _ = win.navigate(u);
        }
    }

    // Poll the keeper's cookie store until the full authed set is present
    // (LOGIN_INFO lands last, as at login), then snapshot it. The gate is
    // the same predicate `is_logged_in` uses, so a snapshot can never be
    // captured, committed, and then reported as signed out.
    let mut captured: Option<String> = None;
    for tick in 0..12u8 {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let Ok(cookies) = win.cookies() else { continue };
        let netscape = cookies_to_netscape(&cookies);
        let creds = jar_credentials(&netscape);
        if !creds.identity {
            continue; // the keeper hasn't loaded a session yet
        }
        // Give the handshake a few ticks to finish, then take what we have:
        // the continuity check below decides whether it is good enough to
        // replace what is already on disk, so a missing LOGIN_INFO can stall
        // this loop without stalling the refresh forever.
        if !creds.complete() && tick < 4 {
            continue;
        }
        captured = Some(netscape);
        break;
    }
    let Some(snapshot) = captured else {
        return RefreshOutcome::Failed("no auth cookies after reload (profile logged out?)".into());
    };
    let plain = snapshot.clone().into_bytes();
    let encrypted = match tokio::task::spawn_blocking(move || secure_store::encrypt(&plain)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => {
            let e = format!("encrypt: {e}");
            return if session::is_environment_unavailable(&e) {
                RefreshOutcome::Deferred(e)
            } else {
                RefreshOutcome::Failed(e)
            };
        }
        Err(e) => return RefreshOutcome::Failed(format!("encrypt join: {e}")),
    };

    // Only the commit is serialized against the other jar writers, not the
    // capture above: a `Set-Cookie` merge runs inside every InnerTube
    // response, and holding the lock for the whole eighteen-second poll
    // would stall the UI once per cycle. The cost is that a rotation merged
    // DURING the poll is replaced by the snapshot — which is the live
    // WebKit store for this account, so it is the more authoritative of the
    // two. Anything the snapshot drops is logged rather than silently lost.
    let locks = app.state::<authfs::MutationLocks>();
    let _jar = locks.inner().account(id).await;

    // Under the lock, confirm the account still exists. Sign out and account
    // removal delete the whole `accounts/<id>/` tree while this poll is
    // running, and `write_atomic` re-creates any directory it needs — so
    // without this check the jar the user just asked the app to forget gets
    // written back, live, and invisible to a UI that no longer lists it.
    // Both deletion paths take this same lock, so one of the two orders
    // always holds: either we see the row gone, or they wait and then delete
    // what we wrote.
    match read_index_checked(app).await {
        IndexRead::Loaded(idx) if idx.accounts.iter().any(|a| a.id == id) => {}
        IndexRead::Loaded(_) | IndexRead::Absent => {
            return RefreshOutcome::Failed("account was removed while refreshing".into())
        }
        IndexRead::Corrupt(e) | IndexRead::Unavailable(e) => {
            return RefreshOutcome::Failed(format!("cannot confirm the account still exists: {e}"))
        }
    }

    let previous = match read_jar(app, id).await {
        JarRead::Loaded(jar) => Some(jar),
        _ => None,
    };

    // Continuity. The snapshot replaces the jar wholesale, so a capture the
    // client could not authenticate with must never overwrite one it could:
    // every other part of a refresh can be retried, this cannot. Committing
    // over a jar that is already unsignable is fine — there is nothing to
    // lose and the fresher cookies may be what heals it.
    //
    // The test is `signable`, not the full set, on purpose. Refusing a
    // capture that merely lost LOGIN_INFO would pin the old jar in place
    // forever after a real server-side logout, which is how "protected"
    // cookies turn immortal. A lost marker is logged below instead.
    if !jar_credentials(&snapshot).signable() {
        if let Some(previous) = &previous {
            if jar_credentials(previous).signable() {
                return RefreshOutcome::Failed(format!(
                    "captured snapshot cannot sign requests ({}); keeping the previous jar",
                    jar_credentials(&snapshot).missing()
                ));
            }
        }
    }

    // Liveness. A snapshot identical to the jar it would replace renewed
    // nothing, and neither did a keeper that never finished a page load:
    // offline, `navigate()` still returns Ok and the persisted WebKit store
    // still answers with the old set. Committing that would stamp the
    // success deadline and leave the app replaying an hours-old snapshot for
    // another twenty minutes, which is exactly the live-versus-replayed
    // divergence Google reads as a stolen cookie. Either signal is enough;
    // requiring both would fail a legitimate cycle in which Google happened
    // to rotate nothing.
    let reloaded = KEEPER_PAGE_LOADS.load(Ordering::Relaxed) > loads_before;
    let renewed = previous
        .as_deref()
        .is_none_or(|p| session::jars_differ(p, &snapshot));
    if !reloaded && !renewed {
        return RefreshOutcome::Failed(
            "keeper finished no page load and the cookie set is unchanged (offline?)".into(),
        );
    }

    if let Some(previous) = &previous {
        log_snapshot_regressions(previous, &snapshot);
    }

    if let Err(e) = authfs::write_atomic(account_cookies_path(app, id), encrypted, 0o600).await {
        // A storage failure keeps the previous jar, so the session is
        // intact; it is the attempt that failed, and it must never reach
        // the UI as "signed out".
        return RefreshOutcome::Failed(format!("write refreshed cookies: {e}"));
    }
    // The success deadline derives from this stamp and nothing else, so an
    // unwritable stamp means the refresh did not fully commit: leave the
    // deadline where it was and let the loop back off and try again.
    if let Err(e) = write_last_refresh(app, id, now_ts()).await {
        return RefreshOutcome::Failed(format!("write refresh stamp: {e}"));
    }
    RefreshOutcome::Committed
}

/// How a refresh attempt ended. Three outcomes, not two: an attempt that
/// could not run because the desktop session was unavailable is not the
/// same as one that ran and found the account logged out, and treating them
/// alike is what turned a dark wake into a re-login prompt.
enum RefreshOutcome {
    /// The jar and its success stamp are both on disk.
    Committed,
    /// Nothing was written and nothing was learned. Does not advance the
    /// success deadline and does not count as a session failure.
    Deferred(String),
    /// The attempt ran and failed. The previous jar is untouched.
    Failed(String),
}

/// Can the platform credential store be read right now?
///
/// Only Linux and macOS keep the jar's key outside the process (Secret
/// Service / Keychain), so they are the only platforms with anything to
/// probe.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn credential_store_ready() -> Result<(), String> {
    match tokio::task::spawn_blocking(|| secure_store::encrypt(b"probe")).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("credential store: {e}")),
        Err(e) => Err(format!("credential store probe: {e}")),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
async fn credential_store_ready() -> Result<(), String> {
    Ok(())
}

/// Log the cookies the new snapshot would drop or roll back relative to the
/// jar it replaces. The keeper snapshot overwrites wholesale, so anything a
/// `Set-Cookie` merge learned since the last cycle disappears here; that has
/// never been visible, and it is one of the ways a replayed jar drifts from
/// what Google last issued. Values are never logged, only names.
fn log_snapshot_regressions(previous: &str, fresh: &str) {
    let names: HashMap<(&str, &str), &str> = session::parse_jar(fresh)
        .map(|c| ((c.domain, c.name), c.value))
        .collect();
    let mut dropped: Vec<String> = Vec::new();
    let mut rolled_back: Vec<String> = Vec::new();
    for c in session::parse_jar(previous) {
        match names.get(&(c.domain, c.name)) {
            None => dropped.push(format!("{} {}", c.domain, c.name)),
            Some(v) if *v != c.value => rolled_back.push(format!("{} {}", c.domain, c.name)),
            Some(_) => {}
        }
    }
    if !dropped.is_empty() {
        eprintln!("[refresh] snapshot drops cookie(s): {}", dropped.join(", "));
    }
    if !rolled_back.is_empty() {
        eprintln!(
            "[refresh] snapshot replaces value(s) the merge had echoed: {}",
            rolled_back.join(", ")
        );
    }
}

/// Force an immediate snapshot refresh for the active account. Exposed
/// for the UI (and manual testing) so a session can be renewed on demand
/// instead of only when the periodic timer fires. Returns `false` when
/// nobody is signed in.
#[tauri::command]
async fn refresh_active_session(app: tauri::AppHandle) -> Result<bool, String> {
    let idx = read_index(&app).await;
    let Some(active) = idx.active else {
        return Ok(false);
    };
    match refresh_account_cookies(&app, &active).await {
        RefreshOutcome::Committed => {
            let _ = app.emit("session-refreshed", &active);
            Ok(true)
        }
        // Both reject, because in neither case is the snapshot any newer
        // than it was — but a defer says "ask again shortly", not "this
        // account needs attention", so the caller can tell them apart.
        RefreshOutcome::Deferred(e) => {
            eprintln!("[refresh] {active}: deferred: {e}");
            Err(format!("deferred: {e}"))
        }
        RefreshOutcome::Failed(e) => {
            eprintln!("[refresh] {active}: {e}");
            Err(e)
        }
    }
}

/// Keep the active account's replayed cookie snapshot fresh.
///
/// Google leashes *extracted* cookies to roughly two hours; reloading the
/// hidden session-keeper every 20 minutes renews the bound session well
/// inside that window, so the library never silently empties mid-session.
/// Accounts with no persisted profile (added before the keeper shipped) are
/// skipped until the user signs in again.
///
/// The deadline is WALL CLOCK and persisted, because a tokio timer does not
/// advance while macOS sleeps: with `sleep(20 min)` two consecutive
/// refreshes in this app's own timestamped log landed 142 and 177 minutes
/// apart, each firing the instant the Mac woke, while Google kept rotating.
/// A short tick over a wall-clock deadline notices that within a minute
/// whether or not the wake notification arrives.
///
/// Two clocks, never one. `due_at` moves only when a refresh actually
/// commits; the retry clock is separate. A failed attempt that pushed the
/// success deadline out is how a snapshot ages for hours while the loop
/// believes it is on schedule.
async fn run_refresh_loop(app: tauri::AppHandle) {
    let wake = session::wake::signal();
    let mut retry = session::RetryState::default();
    let mut interval =
        session::REFRESH_INTERVAL_SECS + session::jitter(session::REFRESH_JITTER_SECS, jitter_seed());
    // Both conditions can hold for hours, so they log the transition and
    // then stay quiet.
    let mut warned_profileless: Option<String> = None;
    let mut warned_deferred = false;
    let mut warned_index = false;

    loop {
        let now = now_ts();
        // Read the index directly rather than through `read_index`: an
        // unreadable one would otherwise log on every tick, and this is the
        // one condition nothing in the app can heal by itself.
        let active = match read_index_checked(&app).await {
            IndexRead::Loaded(idx) => {
                warned_index = false;
                idx.active
            }
            IndexRead::Absent => None,
            IndexRead::Corrupt(e) | IndexRead::Unavailable(e) => {
                if !warned_index {
                    warned_index = true;
                    eprintln!("[refresh] {e}; session refresh is paused until it is readable");
                }
                None
            }
        };
        // Nothing to wait for unless an account is due; overwritten below.
        let mut due = now.saturating_add(session::REFRESH_TICK_SECS as i64);
        let mut attempted = false;
        let mut refreshable = false;
        if let Some(active) = active {
            if !account_webview_dir(&app, &active).exists() {
                if warned_profileless.as_deref() != Some(active.as_str()) {
                    eprintln!(
                        "[refresh] {active} has no persisted profile; sign in again to re-arm \
                         session refresh"
                    );
                    warned_profileless = Some(active);
                }
            } else {
                warned_profileless = None;
                refreshable = true;
                let last = read_last_refresh(&app, &active).await;
                due = session::due_at(last, now, interval);
                // A wake pulls the deadline in, but only as far as the point
                // where the snapshot is old enough to be worth renewing. A
                // lid opened a dozen times in an hour must not cost a dozen
                // authenticated keeper reloads.
                if retry.forced_due() {
                    due = due.min(session::due_at(last, now, session::WAKE_MIN_AGE_SECS));
                }
                if session::should_attempt(now, due, retry.next_attempt_at()) {
                    attempted = true;
                    retry.on_attempt();
                    match refresh_account_cookies(&app, &active).await {
                        RefreshOutcome::Committed => {
                            retry.on_committed();
                            interval = session::REFRESH_INTERVAL_SECS
                                + session::jitter(session::REFRESH_JITTER_SECS, jitter_seed());
                            if warned_deferred {
                                warned_deferred = false;
                                eprintln!("[refresh] desktop session is available again");
                            }
                            eprintln!("[refresh] renewed snapshot for {active}");
                            // Emitted only on a committed jar, never on an
                            // attempt: the frontend uses it to re-ask an auth
                            // question it may have answered wrongly while the
                            // session was unreadable.
                            let _ = app.emit("session-refreshed", &active);
                        }
                        // Nothing was written and nothing was learned: the
                        // deadline stands, the failure count stands, and we
                        // wait a little rather than hammering the keychain.
                        RefreshOutcome::Deferred(reason) => {
                            retry.on_deferred(now_ts(), jitter_seed());
                            if !warned_deferred {
                                warned_deferred = true;
                                eprintln!(
                                    "[refresh] deferred, desktop session unavailable \
                                     (dark wake?): {reason}"
                                );
                            }
                        }
                        RefreshOutcome::Failed(e) => {
                            retry.on_failed(now_ts(), jitter_seed());
                            eprintln!("[refresh] {active}: {e}");
                        }
                    }
                }
            }
        }

        if !refreshable {
            // Signed out, or on an account with no persisted profile: the
            // branch above is the only one that reaches `on_attempt`, so
            // without this a single lid-open would leave every later pass
            // permanently forced.
            retry.on_nothing_to_refresh();
        }

        // A pass that attempted has just changed the state it would sleep
        // on, and every backoff is longer than a few seconds, so a full tick
        // is right. A pass that held off sleeps only until the moment it
        // could act — which is what makes the wake's settle delay a real ten
        // seconds instead of "some time in the next minute".
        let delay = if attempted {
            session::REFRESH_TICK_SECS
        } else {
            session::sleep_secs(now_ts(), due, retry.next_attempt_at())
        };
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
            // A wake only marks the refresh DUE. It cannot prove a UI
            // session exists, so it never bypasses the keychain probe — a
            // dark wake still defers and backs off.
            _ = wake.notified() => retry.on_wake(now_ts()),
        }
    }
}

/// Parse a Netscape cookie jar and return a `Cookie:` header value
/// containing all cookies that match the given domain (honoring the
/// `include_subdomains` flag). Empty string if no jar or no matches.
async fn read_cookie_header(app: &tauri::AppHandle, host: &str) -> String {
    let Some(content) = read_cookies_plain(app).await else {
        return String::new();
    };
    session::cookie_header(&content, host, session::INNERTUBE_PATH, now_ts())
}

#[tauri::command]
async fn get_cookie_header(app: tauri::AppHandle, host: String) -> Result<String, String> {
    Ok(read_cookie_header(&app, &host).await)
}

/// The honest answer about the stored session for `host`: usable, unknown,
/// or signed out. Everything the UI shows about auth derives from this, and
/// only `signed_out` may render a sign-in button.
async fn auth_state(app: &tauri::AppHandle, host: &str) -> session::AuthStatus {
    let idx = match read_index_checked(app).await {
        IndexRead::Corrupt(e) | IndexRead::Unavailable(e) => {
            return session::AuthStatus::unknown(e)
        }
        IndexRead::Absent => return session::AuthStatus::signed_out("no accounts file"),
        IndexRead::Loaded(idx) => idx,
    };
    let Some(id) = idx.active else {
        return session::AuthStatus::signed_out("no active account");
    };
    match read_jar(app, &id).await {
        JarRead::Absent => session::AuthStatus::signed_out("no cookie jar for the active account"),
        // Decrypt failures land here, including the macOS dark-wake case
        // where the login keychain will not open. The session on disk is
        // fine; we simply cannot read it this second.
        JarRead::Unavailable(e) => session::AuthStatus::unknown(e),
        JarRead::Loaded(jar) => {
            let creds = session::inspect_jar(&jar, host, session::INNERTUBE_PATH, now_ts());
            // `signable`, not the stricter full set: a jar this client can
            // sign requests with IS authenticated as far as anything here
            // can tell, and answering an authoritative "signed out" for it
            // gates off the `/account_menu` probe that is the only thing
            // able to disagree. `/account_menu` still gets the last word in
            // the other direction, so the strictness belongs there.
            if creds.signable() {
                session::AuthStatus::usable()
            } else {
                session::AuthStatus::signed_out(creds.missing())
            }
        }
    }
}

/// Tri-state auth answer for the UI. `is_logged_in` keeps its boolean shape
/// for the callers that only branch two ways; this is what a caller uses to
/// tell "Google says you are anonymous" from "we could not look".
#[tauri::command]
async fn auth_status(app: tauri::AppHandle) -> Result<session::AuthStatus, String> {
    Ok(auth_state(&app, "music.youtube.com").await)
}

#[tauri::command]
async fn is_logged_in(app: tauri::AppHandle) -> Result<bool, String> {
    let status = auth_state(&app, "music.youtube.com").await;
    // Rejecting is the whole point: `Ok(false)` is an authoritative "you are
    // signed out" and the sidebar renders a sign-in button for it. An
    // unreadable jar is not that answer, and returning `false` for it is
    // what showed a signed-in user the sign-in button after a dark wake.
    if status.is_unknown() {
        return Err(status.reason);
    }
    Ok(status.is_usable())
}

/// Hard-exit the process. The window's close button hides into the tray
/// by default (see `WindowEvent::CloseRequested` below); this command is
/// the frontend's equivalent of the tray's Quit menu item.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// What the title-bar ✕ does, mirrored from the frontend settings store
/// (`useCloseBehaviorSync`). Lives in Rust rather than only in
/// localStorage because the decision point is the `CloseRequested`
/// window event, which must also cover Alt+F4 and the taskbar's Close.
/// Defaults to hide-to-tray until the frontend pushes a value shortly
/// after the webview boots.
#[derive(Default)]
struct CloseBehavior {
    quit_on_close: AtomicBool,
}

#[tauri::command]
fn set_close_behavior(state: tauri::State<'_, CloseBehavior>, quit_on_close: bool) {
    state.quit_on_close.store(quit_on_close, Ordering::Relaxed);
}

/// Register / unregister the app for launch at OS startup. Uses the
/// autostart plugin's Rust API from our own command so the frontend
/// needs no extra capability grants.
#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    let currently = autolaunch.is_enabled().unwrap_or(false);
    if enabled == currently {
        return Ok(());
    }
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())
    } else {
        autolaunch.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Track-change toast (Settings → General → Playback notifications).
/// The focus check lives here rather than in JS so it covers every
/// window at once: a toast is only useful when the user isn't already
/// looking at the app (main window hidden to tray, or another app in
/// the foreground).
#[tauri::command]
fn notify_track(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let any_focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));
    if any_focused {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Bring the main window to the front. Called from the floating
/// player when the user clicks an in-bar link (e.g. an artist name)
/// — without this, the navigation would fire silently in the
/// background while the floating window keeps focus.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Spawn (or refocus) the standalone floating-player window. The
/// frontend renders a stripped-down version of itself when it sees
/// `?floating-player=1` in the URL, so the new window hosts only the
/// player UI. Audio playback stays in the main window — the floater
/// mirrors state via Tauri events.
///
/// `x` / `y` are screen coords (CSS / logical pixels, as JS reports
/// them). When provided, the window appears centered horizontally on
/// the cursor with the title bar just under it — the natural landing
/// spot when the user drags the cover out of the main window. When
/// omitted, the window-state plugin's saved position takes over.
#[tauri::command]
async fn open_player_window(
    app: tauri::AppHandle,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("player") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        if let (Some(cx), Some(cy)) = (x, y) {
            let _ = existing.set_position(tauri::LogicalPosition::new(cx - 180.0, cy - 18.0));
        }
        return Ok(());
    }
    // The min height is sized so the Play/Pause control stays
    // visible at the narrowest legal window: titlebar (36) + p-4 top
    // (16) + cover (capped at 320 via `max-w-[20rem]` on the cover
    // wrapper) + gap (12) + meta (~36) + gap (12) + progress (~54)
    // + gap (12) + controls (~48) + p-3 bottom (12) ≈ 558. Lyrics
    // and the bottom button row sit below and graciously collapse
    // (lyrics is `flex-1 min-h-0`) when there isn't room.
    let win = WebviewWindowBuilder::new(
        &app,
        "player",
        WebviewUrl::App("index.html?floating-player=1".into()),
    )
    .title("YTubic — player")
    .decorations(false)
    .inner_size(360.0, 720.0)
    .min_inner_size(320.0, 560.0)
    .resizable(true)
    .skip_taskbar(false)
    // Tauri's default drag/drop handler swallows in-page HTML5 drag
    // events on WebView2, breaking the queue reorder. We don't
    // accept dropped files anywhere in the app, so disabling the
    // handler entirely is purely upside. The doc string for this
    // method literally calls out HTML5 DnD on Windows as the use case.
    .disable_drag_drop_handler()
    .build()
    .map_err(|e| e.to_string())?;
    // Dev builds: orange taskbar icon, same as the main window.
    #[cfg(debug_assertions)]
    let _ = win.set_icon(runtime_icon(&app));
    if let (Some(cx), Some(cy)) = (x, y) {
        // Override whatever the window-state plugin restored. Centering
        // horizontally on cursor with the 36px-tall title bar just
        // below puts the user's release point on top of the new card,
        // which feels like the window snapped to where they dropped.
        let _ = win.set_position(tauri::LogicalPosition::new(cx - 180.0, cy - 18.0));
    }
    Ok(())
}

#[tauri::command]
async fn close_player_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("player") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Sign the user out of every account they've added. Wipes the
/// accounts index, removes each per-account cookies dir, and emits
/// `accounts-changed` so the UI can collapse back to the signed-out
/// state. Mirrors the old single-account `clear_cookies` semantics
/// — "the app forgets you entirely" — extended to the multi-account
/// world.
#[tauri::command]
async fn clear_cookies(app: tauri::AppHandle) -> Result<(), String> {
    let locks = app.state::<authfs::MutationLocks>();
    let _index = locks.inner().index().await;
    // Hold every account's jar lock across the delete. A refresh commits
    // under that lock and `write_atomic` re-creates the directory tree it
    // writes into, so without this the account the user just asked the app
    // to forget can reappear on disk seconds later, with live credentials
    // and no row in the index to make it visible. Lock order is
    // index-then-account (see authfs::MutationLocks).
    let mut _jars = Vec::new();
    for id in account_ids_on_disk(&app).await {
        _jars.push(locks.inner().account(&id).await);
    }
    // And close any running keeper, as `remove_account` does, so no webview
    // is still holding (or re-creating) a profile directory that is about to
    // be deleted. A keeper's profile is a signed-in Google session on disk.
    for (label, w) in app.webview_windows() {
        if label.starts_with("keeper-") {
            let _ = w.close();
        }
    }
    let dir = accounts_dir(&app);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| format!("remove accounts dir: {e}"))?;
    }
    let index = accounts_index_path(&app);
    if index.exists() {
        tokio::fs::remove_file(&index)
            .await
            .map_err(|e| format!("remove index: {e}"))?;
    }
    // Sweep any stray legacy file too — defends against a partially-
    // migrated install where someone manually copied state around.
    let legacy = legacy_cookies_enc_path(&app);
    if legacy.exists() {
        let _ = tokio::fs::remove_file(&legacy).await;
    }
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

#[tauri::command]
async fn list_accounts(app: tauri::AppHandle) -> Result<Vec<AccountSummary>, String> {
    let idx = read_index(&app).await;
    let active = idx.active.clone();
    Ok(idx
        .accounts
        .into_iter()
        .map(|a| {
            let is_active = active.as_deref() == Some(a.id.as_str());
            AccountSummary {
                id: a.id,
                email: a.email,
                name: a.name,
                photo_url: a.photo_url,
                page_id: a.page_id,
                channel_name: a.channel_name,
                channel_photo_url: a.channel_photo_url,
                is_active,
            }
        })
        .collect())
}

/// Switch the active account. The InnerTube client picks up the new
/// cookies on its next request via `get_cookie_header`; the frontend
/// invalidates its query cache on the `accounts-changed` event.
#[tauri::command]
async fn switch_account(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let locks = app.state::<authfs::MutationLocks>();
    let _index = locks.inner().index().await;
    let mut idx = read_index_for_update(&app).await?;
    if !idx.accounts.iter().any(|a| a.id == id) {
        return Err(format!("no such account: {id}"));
    }
    if idx.active.as_deref() == Some(id.as_str()) {
        return Ok(()); // already active — silent no-op
    }
    idx.active = Some(id);
    write_index(&app, &idx).await?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Remove a single account. If the removed account was the active
/// one, pick the first remaining account as the new active (or
/// `None` when this was the last). Deletes the per-account cookies
/// directory off disk in the same call.
#[tauri::command]
async fn remove_account(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let locks = app.state::<authfs::MutationLocks>();
    let _index = locks.inner().index().await;
    let mut idx = read_index_for_update(&app).await?;
    let pos = idx
        .accounts
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| format!("no such account: {id}"))?;
    idx.accounts.remove(pos);
    // Close this account's session-keeper (if running) so its webview
    // releases the profile directory before we delete it.
    if let Some(w) = app.get_webview_window(&format!("keeper-{id}")) {
        let _ = w.close();
    }
    // Held across the delete AND the index write: a refresh already
    // mid-capture commits under this lock and re-creates whatever directory
    // it writes into, so the removed account's jar would come straight back.
    // Lock order is index-then-account (see authfs::MutationLocks).
    let _jar = locks.inner().account(&id).await;
    let dir = accounts_dir(&app).join(&id);
    if dir.exists() {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    if idx.active.as_deref() == Some(id.as_str()) {
        idx.active = idx.accounts.first().map(|a| a.id.clone());
    }
    write_index(&app, &idx).await?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Backfill or update meta for an account. Frontend calls this once
/// per session after `/account_menu` returns the active user's name
/// + email + avatar.
///
/// Dedup: if the supplied identity (email, or avatar when the email is
/// empty) matches a *different* existing account, this is a re-login of
/// an account we've seen before. Replace the older account's cookies
/// with the freshly-captured ones, drop this account's just-created
/// entry, and pin the older id as active.
#[tauri::command]
async fn update_account_meta(
    app: tauri::AppHandle,
    id: String,
    name: String,
    email: String,
    #[allow(non_snake_case)] photoUrl: Option<String>,
) -> Result<(), String> {
    let photo_url = photoUrl;
    let locks = app.state::<authfs::MutationLocks>();
    let _index = locks.inner().index().await;
    let mut idx = read_index_for_update(&app).await?;

    // Meta from /account_menu always describes the ACTIVE account: the
    // fetch runs with the active jar. A caller that pairs a stale id
    // with fresh meta (or a fresh id with stale meta) must not relabel
    // some other row; with identity dedup that could merge two real
    // accounts. Drop the write and let the backfill re-run with a
    // consistent pair.
    if idx.active.as_deref() != Some(id.as_str()) {
        return Ok(());
    }

    // The dedup branch below deletes this row's whole directory, and the
    // row stays in the index until the write at the end of the function.
    // Held across both, a refresh of this account cannot slip in between
    // and re-create the jar it just deleted (`write_atomic` re-creates any
    // directory it writes into). Lock order is index-then-account, and an
    // account lock is never held while taking the index one, so holding
    // two of them here is safe (see authfs::MutationLocks).
    let _this_jar = locks.inner().account(&id).await;

    // When the account acts as a brand channel, /account_menu describes
    // the channel, not the Google account, so its meta can't identify a
    // duplicate row.
    let acting_as_brand = idx
        .accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.page_id.is_some())
        .unwrap_or(false);

    // Re-login of an existing account? Match a *different* row by
    // identity (email, or avatar when the email is empty; see
    // `meta_identity`). Keying on email alone missed brand-channel and
    // no-email accounts, which is how duplicate rows used to pile up.
    let incoming = if acting_as_brand {
        None
    } else {
        meta_identity(&email, photo_url.as_deref())
    };
    let dup_pos = incoming.as_ref().and_then(|key| {
        idx.accounts.iter().position(|a| {
            a.id != id
                && meta_identity(&a.email, a.photo_url.as_deref()).as_deref() == Some(key.as_str())
        })
    });

    // A "fresh add" is the very first meta backfill after
    // `start_login` — the account row exists but its name + email
    // are still empty placeholders. That's the moment to fire
    // `accounts-changed`, because it's the only event the UI listens
    // to for the full account-switch reset. Subsequent meta refreshes
    // (every session boot for an existing account) don't trigger the
    // reset; the frontend just invalidates the accounts list to pick
    // up name/photo changes.
    let was_fresh_add = idx
        .accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.name.is_empty() && a.email.is_empty())
        .unwrap_or(false);

    // Track whether the active account id actually flips. Dedup is
    // the only path that flips active here; a plain meta update
    // leaves `idx.active` alone.
    let mut active_changed = false;

    if let Some(other_pos) = dup_pos {
        let other_id = idx.accounts[other_pos].id.clone();
        let this_cookies = account_cookies_path(&app, &id);
        let other_cookies = account_cookies_path(&app, &other_id);
        match tokio::fs::read(&this_cookies).await {
            Ok(bytes) => {
                // Lock order: the index lock is already held and an account
                // lock is taken under it, never the reverse.
                let _jar = locks.inner().account(&other_id).await;
                if let Err(e) = authfs::write_atomic(other_cookies, bytes, 0o600).await {
                    eprintln!("[accounts] copy cookies on dedup: {e}");
                } else {
                    // The row just took on a jar captured seconds ago at
                    // login, so its refresh deadline restarts from here.
                    let _ = write_last_refresh(&app, &other_id, now_ts()).await;
                }
            }
            Err(e) => eprintln!("[accounts] read cookies on dedup: {e}"),
        }
        // Re-login replaces the older row's session with the freshly
        // captured one, so its live WebView profile has to move over too.
        // Otherwise the renewed account would have no profile to refresh
        // from and would die at ~2h like the old snapshot-only flow. The
        // just-closed login window can hold WebView2 file locks for a
        // beat, so retry the move briefly before giving up.
        let this_webview = account_webview_dir(&app, &id);
        if this_webview.exists() {
            let other_webview = account_webview_dir(&app, &other_id);
            let _ = tokio::fs::remove_dir_all(&other_webview).await;
            let mut moved = false;
            for _ in 0..5u8 {
                if tokio::fs::rename(&this_webview, &other_webview)
                    .await
                    .is_ok()
                {
                    moved = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            if !moved {
                eprintln!(
                    "[accounts] could not move webview profile {id} -> {other_id}; \
                     re-login needed to re-arm session refresh"
                );
            }
        }
        let _ = tokio::fs::remove_dir_all(accounts_dir(&app).join(&id)).await;
        if let Some(this_pos) = idx.accounts.iter().position(|a| a.id == id) {
            idx.accounts.remove(this_pos);
        }
        if let Some(other) = idx.accounts.iter_mut().find(|a| a.id == other_id) {
            other.name = name;
            // Don't let an empty backfill (some accounts' /account_menu
            // carries no email) wipe a good stored email.
            if !email.is_empty() {
                other.email = email;
            }
            // The avatar can be the dedup identity when the email is
            // empty; never wipe it with a photo-less response.
            if photo_url.is_some() {
                other.photo_url = photo_url;
            }
        }
        if idx.active.as_deref() != Some(other_id.as_str()) {
            active_changed = true;
        }
        idx.active = Some(other_id);
    } else if let Some(acct) = idx.accounts.iter_mut().find(|a| a.id == id) {
        if acting_as_brand {
            // Route brand-channel meta into the channel fields and leave
            // the account-level identity (name / email / photo captured
            // on the personal channel) untouched: re-login dedup keys on
            // it, and overwriting the account photo with the brand one
            // made a later re-login of the same account look like a new
            // identity.
            if !name.is_empty() {
                acct.channel_name = Some(name);
            }
            if photo_url.is_some() {
                acct.channel_photo_url = photo_url;
            }
        } else {
            acct.name = name;
            // Some accounts' /account_menu carries no email; don't let
            // that backfill wipe the stored one (it drives the re-login
            // dedup above).
            if !email.is_empty() {
                acct.email = email;
            }
            // The avatar can be the dedup identity when the email is
            // empty; never wipe it with a photo-less response.
            if photo_url.is_some() {
                acct.photo_url = photo_url;
            }
        }
    } else {
        return Err(format!("no such account: {id}"));
    }

    write_index(&app, &idx).await?;
    if was_fresh_add || active_changed {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(())
}

/// Returns the id of the currently active account, or `None` when
/// signed out. Frontend uses this to pair fresh `account_menu` info
/// with the right account row.
#[tauri::command]
async fn get_active_account_id(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(read_index(&app).await.active)
}

/// Select which YouTube channel (personal or brand) an account acts
/// as. `pageId: None` selects the personal channel. When the choice on
/// the ACTIVE account actually changes we emit `accounts-changed`:
/// library, likes and home are channel-scoped, so the frontend must
/// run the same full reset as an account switch.
#[tauri::command]
async fn set_account_channel(
    app: tauri::AppHandle,
    id: String,
    #[allow(non_snake_case)] pageId: Option<String>,
    #[allow(non_snake_case)] channelName: Option<String>,
    #[allow(non_snake_case)] channelPhotoUrl: Option<String>,
) -> Result<(), String> {
    let locks = app.state::<authfs::MutationLocks>();
    let _index = locks.inner().index().await;
    let mut idx = read_index_for_update(&app).await?;
    let is_active = idx.active.as_deref() == Some(id.as_str());
    let acct = idx
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("no such account: {id}"))?;
    let changed = acct.page_id != pageId;
    acct.page_id = pageId;
    acct.channel_name = channelName;
    acct.channel_photo_url = channelPhotoUrl;
    write_index(&app, &idx).await?;
    if changed && is_active {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(())
}

/// Cookie header plus the active account's brand-channel page id in a
/// single call. The InnerTube client sends the page id back as the
/// `X-Goog-PageId` header. Bundling it with the cookie read (instead
/// of a second command) means a cold start can't pair fresh cookies
/// with a stale page id, or vice versa.
#[derive(Clone, Debug, serde::Serialize)]
struct AuthContext {
    cookie: String,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
}

#[tauri::command]
async fn get_auth_context(app: tauri::AppHandle, host: String) -> Result<AuthContext, String> {
    // Reject rather than hand back an empty context when the jar exists but
    // cannot be read: an empty context means "this user is anonymous", and
    // the caller caches it. One dark-wake keychain miss used to make every
    // InnerTube request for the next five minutes go out signed out.
    let cookie = match read_active_jar(&app).await {
        JarRead::Loaded(jar) => session::cookie_header(&jar, &host, session::INNERTUBE_PATH, now_ts()),
        JarRead::Absent => String::new(),
        JarRead::Unavailable(e) => return Err(format!("auth unavailable: {e}")),
    };
    let page_id = if cookie.is_empty() {
        None
    } else {
        let idx = read_index(&app).await;
        idx.accounts
            .iter()
            .find(|a| idx.active.as_deref() == Some(a.id.as_str()))
            .and_then(|a| a.page_id.clone())
    };
    Ok(AuthContext { cookie, page_id })
}

/// Singleflight for cookie-refresh runs, so the periodic timer and a manual
/// trigger can't reload the same keeper at once. The jar itself is guarded
/// separately by `authfs::MutationLocks` — this one is about the keeper
/// window, which is a process-wide resource.
#[derive(Default)]
struct RefreshGuard(tokio::sync::Mutex<()>);

/// Merge `Set-Cookie` headers from an InnerTube response into the
/// active account's jar, mirroring what a browser would do. Google
/// rotates session-security cookies (SIDCC / __Secure-*PSIDCC /
/// LOGIN_INFO) right after sign-in and expects the client to echo the
/// fresh values from then on; a client that keeps replaying the
/// pre-rotation snapshot matches the stolen-cookie heuristic and the
/// whole session gets revoked within hours (the v0.2.0 "library and
/// Premium vanish" bug).
///
/// Returns `true` when a cookie VALUE changed — the frontend drops its
/// cached Cookie header then. Missing jar / dead decrypt are quiet
/// no-ops: rotation echo is best-effort and must never break the data
/// call that triggered it.
#[tauri::command]
async fn merge_response_cookies(
    app: tauri::AppHandle,
    host: String,
    set_cookies: Vec<String>,
) -> Result<bool, String> {
    if set_cookies.is_empty() {
        return Ok(false);
    }
    let Some(id) = read_index(&app).await.active else {
        return Ok(false);
    };
    // Held across the whole read-modify-write, and shared with the refresh
    // commit and the login write, so a rotation can no longer be lost to a
    // snapshot landing between the read and the rename.
    let locks = app.state::<authfs::MutationLocks>();
    let _guard = locks.inner().account(&id).await;

    let jar = match read_jar(&app, &id).await {
        JarRead::Loaded(jar) => jar,
        JarRead::Absent => return Ok(false),
        // Echoing a rotation is best-effort and must never fail the data
        // call that triggered it — but a keychain that would not open is
        // worth saying out loud, because the rotation Google just issued is
        // being dropped and that is exactly what drifts the jar out of sync.
        JarRead::Unavailable(e) => {
            eprintln!("[auth] dropped a rotation, jar unavailable: {e}");
            return Ok(false);
        }
    };

    let (merged, value_changed, needs_write) =
        merge_set_cookies_into_jar(&jar, &set_cookies, &host, now_ts());
    if !needs_write {
        return Ok(false);
    }

    let bytes = merged.into_bytes();
    let encrypted = tokio::task::spawn_blocking(move || secure_store::encrypt(&bytes))
        .await
        .map_err(|e| format!("encrypt join: {e}"))?
        .map_err(|e| format!("encrypt cookies: {e}"))?;
    authfs::write_atomic(account_cookies_path(&app, &id), encrypted, 0o600).await?;
    if value_changed {
        eprintln!("[auth] echoed rotated session cookie(s) into the active jar");
    }
    Ok(value_changed)
}

/// File (under the store plugin's default dir) + key holding the
/// user-chosen cache root. Written by `set_cache_dir`, read once at
/// startup — the stream server captures its directories when it
/// spawns, so a change only applies on the next launch.
const SETTINGS_STORE_FILE: &str = "settings.json";
const CACHE_DIR_KEY: &str = "cacheDir";

/// The cache root this process actually started with (managed state,
/// set in `setup`). All track/cover cache paths derive from it so the
/// commands and the running stream server always agree, even when the
/// stored preference already points somewhere new.
struct ActiveCacheRoot(PathBuf);

fn default_cache_root(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// User-chosen cache root from the settings store, if any.
fn stored_cache_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(SETTINGS_STORE_FILE).ok()?;
    let value = store.get(CACHE_DIR_KEY)?;
    let s = value.as_str()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn stream_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.state::<ActiveCacheRoot>().0.join("stream")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheDirInfo {
    /// Root that will be used from the next launch on.
    path: String,
    default_path: String,
    is_custom: bool,
    /// True when the stored preference differs from what this process
    /// is running with — i.e. a restart is pending.
    needs_restart: bool,
}

#[tauri::command]
fn get_cache_dir(app: tauri::AppHandle) -> CacheDirInfo {
    let default = default_cache_root(&app);
    let stored = stored_cache_root(&app);
    let active = app.state::<ActiveCacheRoot>().0.clone();
    let effective = stored.clone().unwrap_or_else(|| default.clone());
    CacheDirInfo {
        needs_restart: effective != active,
        path: effective.display().to_string(),
        default_path: default.display().to_string(),
        is_custom: stored.is_some(),
    }
}

/// Persist a new cache root (`None` resets to the default). Validates
/// that the folder exists and is writable before saving; the change
/// takes effect on the next launch.
#[tauri::command]
async fn set_cache_dir(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store(SETTINGS_STORE_FILE)
        .map_err(|e| format!("open settings store: {e}"))?;
    match path {
        None => {
            store.delete(CACHE_DIR_KEY);
        }
        Some(raw) => {
            let raw = raw.trim().to_string();
            let dir = PathBuf::from(&raw);
            if raw.is_empty() || !dir.is_absolute() {
                return Err("Pick an absolute folder path.".into());
            }
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| format!("Can't create the folder: {e}"))?;
            let probe = dir.join(".ytubic-write-test");
            tokio::fs::write(&probe, b"ok")
                .await
                .map_err(|e| format!("Folder isn't writable: {e}"))?;
            let _ = tokio::fs::remove_file(&probe).await;
            store.set(CACHE_DIR_KEY, serde_json::Value::String(raw));
        }
    }
    store
        .save()
        .map_err(|e| format!("save settings store: {e}"))?;
    Ok(())
}

/// Native directory picker for the cache-folder setting. Returns
/// `None` when the user cancels. Blocking picker variant, so keep it
/// off the async runtime's core threads.
#[tauri::command]
async fn pick_cache_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .ok()
        .flatten()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}

#[derive(serde::Serialize)]
struct CacheEntry {
    #[serde(rename = "videoId")]
    video_id: String,
    size: u64,
    /// Seconds since unix epoch. Frontend formats for display.
    #[serde(rename = "modifiedSecs")]
    modified_secs: u64,
    /// Track title, if a sidecar was written when it was cached. The
    /// library walk is the frontend's fallback; without either, it shows
    /// the raw videoId.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// Display artist string (already joined), if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
}

/// On-disk sidecar written next to a cached `<id>.webm` as
/// `<id>.meta.json`. The Rust side stores it verbatim; the frontend
/// supplies the already-formatted display strings.
#[derive(serde::Serialize, serde::Deserialize)]
struct TrackMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
}

/// Best-effort read of a track's metadata sidecar. Any absence or parse
/// error is treated as "no metadata" — the cache file is still valid
/// without it.
async fn read_track_meta(dir: &std::path::Path, video_id: &str) -> TrackMeta {
    let path = dir.join(format!("{video_id}.meta.json"));
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<TrackMeta>(&bytes).unwrap_or(TrackMeta {
            title: None,
            artist: None,
        }),
        Err(_) => TrackMeta {
            title: None,
            artist: None,
        },
    }
}

/// List every finalized track (.webm) currently in the stream cache.
/// In-progress .part files are ignored — they'll appear once the
/// download finishes and the rename happens.
#[tauri::command]
async fn list_cache(app: tauri::AppHandle) -> Result<Vec<CacheEntry>, String> {
    let dir = stream_cache_dir(&app);
    let mut entries: Vec<CacheEntry> = Vec::new();
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Some(name) = e.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        let Some(video_id) = name.strip_suffix(".webm") else {
            continue;
        };
        if !sanitize_video_id(video_id) {
            continue;
        }
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let sidecar = read_track_meta(&dir, video_id).await;
        entries.push(CacheEntry {
            video_id: video_id.to_string(),
            size: meta.len(),
            modified_secs,
            title: sidecar.title,
            artist: sidecar.artist,
        });
    }
    Ok(entries)
}

/// Delete specific cached tracks. Passing an empty vec wipes the
/// entire stream cache directory. Returns the total bytes freed.
#[tauri::command]
async fn delete_cache_entries(
    app: tauri::AppHandle,
    video_ids: Vec<String>,
) -> Result<u64, String> {
    let dir = stream_cache_dir(&app);
    if !dir.exists() {
        return Ok(0);
    }
    let mut freed: u64 = 0;

    let targets: Vec<String> = if video_ids.is_empty() {
        // "Clear all" — enumerate on the fly. Strip whichever suffix a
        // file carries so orphaned sidecars / stray .part files (whose
        // .webm is already gone) get swept too, not just live tracks.
        let mut rd = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| format!("read_dir: {e}"))?;
        let mut out = std::collections::HashSet::new();
        while let Ok(Some(e)) = rd.next_entry().await {
            if let Some(name) = e.file_name().to_str() {
                // A track cached only as video (`<id>.video.mp4`) still
                // has to be swept, so enumerate every variant.
                // `.vonly{h}.{mp4,part}` variants are matched by
                // splitting on the marker instead of enumerating every
                // height suffix.
                let id = name
                    .strip_suffix(".video.mp4")
                    .or_else(|| name.strip_suffix(".webm"))
                    .or_else(|| name.strip_suffix(".meta.json"))
                    .or_else(|| name.strip_suffix(".video.part"))
                    .or_else(|| name.split(".vonly").next().filter(|_| name.contains(".vonly")))
                    .or_else(|| name.strip_suffix(".part"));
                if let Some(id) = id {
                    if sanitize_video_id(id) {
                        out.insert(id.to_string());
                    }
                }
            }
        }
        out.into_iter().collect()
    } else {
        video_ids
            .into_iter()
            .filter(|id| sanitize_video_id(id))
            .collect()
    };

    for id in targets {
        // Both stream variants for the id, plus stray .part files from
        // crashed downloads.
        for h in VONLY_HEIGHTS {
            let (part_name, final_name) = stream_file_names(&id, StreamVariant::VideoOnly(h));
            let path = dir.join(final_name);
            if let Ok(meta) = tokio::fs::metadata(&path).await {
                freed += meta.len();
            }
            let _ = tokio::fs::remove_file(&path).await;
            let _ = tokio::fs::remove_file(stream_proxy::degraded_marker(&path)).await;
            let _ = tokio::fs::remove_file(dir.join(part_name)).await;
        }
        for variant in [StreamVariant::Audio, StreamVariant::Muxed] {
            let (part_name, final_name) = stream_file_names(&id, variant);
            // A degraded marker must go with its file, or a later good
            // copy under the same name inherits it and gets evicted.
            let _ =
                tokio::fs::remove_file(stream_proxy::degraded_marker(&dir.join(&final_name))).await;
            let path = dir.join(final_name);
            if let Ok(meta) = tokio::fs::metadata(&path).await {
                freed += meta.len();
            }
            let _ = tokio::fs::remove_file(&path).await;
            let _ = tokio::fs::remove_file(dir.join(part_name)).await;
        }
        // Metadata sidecar, if one was written.
        let _ = tokio::fs::remove_file(dir.join(format!("{id}.meta.json"))).await;
    }
    Ok(freed)
}

/// Persist a cached track's display metadata to `<id>.meta.json` beside
/// its `.webm`. Called by the frontend when it streams or prefetches a
/// track into the persistent (Premium) cache — that's the moment it
/// knows the title/artist, which `list_cache` cannot derive from the
/// file alone. Idempotent; an empty title is a no-op.
#[tauri::command]
async fn set_cache_meta(
    app: tauri::AppHandle,
    video_id: String,
    title: Option<String>,
    artist: Option<String>,
) -> Result<(), String> {
    if !sanitize_video_id(&video_id) {
        return Err(format!("invalid videoId: {video_id}"));
    }
    let title = title.filter(|s| !s.trim().is_empty());
    // Nothing worth writing — skip rather than leave an empty sidecar.
    if title.is_none() {
        return Ok(());
    }
    let dir = stream_cache_dir(&app);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return Err(format!("create_dir_all: {e}"));
    }
    let meta = TrackMeta {
        title,
        artist: artist.filter(|s| !s.trim().is_empty()),
    };
    let bytes = serde_json::to_vec(&meta).map_err(|e| format!("serialize: {e}"))?;
    let path = dir.join(format!("{video_id}.meta.json"));
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// Make the managed yt-dlp binary available (download on first run,
/// throttled self-update after). Invoked by the frontend on mount so
/// the `ytdlp-state` event listener is guaranteed to exist before any
/// state event fires; also serves as the retry path after a failed
/// download. Idempotent — see `ytdlp::ensure`.
#[tauri::command]
async fn ensure_ytdlp(app: tauri::AppHandle) {
    ytdlp::ensure(app).await;
}

/// yt-dlp format selectors for the audio-only stream.
///
/// macOS renders playback in WKWebView, which only decodes a narrow set
/// of codecs. Prefer AAC-in-mp4 (m4a) first, then Opus/webm, and as a
/// last resort a progressive muxed mp4 (`b[ext=mp4][acodec!=none]`, i.e.
/// itag 18 h264+aac) so a video-only upload with no audio-only format
/// still has its audio play instead of erroring — same as real YT Music.
/// Other platforms keep their original webm-first selection unchanged;
/// WebView2 / WebKitGTK decode Opus fine and the extra ladder isn't
/// needed there.
#[cfg(target_os = "macos")]
// Quality ladder, best first. Both top rungs are Premium-only and need
// cookies (see ytdlp_cookie_file); signed out, selection falls through to
// itag 140 exactly as before.
//
//   774  Opus  271k 48kHz  <- the platform ceiling
//   141  AAC   258k 44.1k
//   140  AAC   130k        <- what anonymous playback gets
//
// 774 is Opus in WebM and WebKit will not range-request WebM: it issues a
// single non-ranged GET for the whole file. That cost 205MB on a 4K video,
// but at ~6-10MB from the local cache it is cheap, and seeking was VERIFIED
// working on 2026-08-26 (scrubbing jumps cleanly on 267-271k Opus). 141
// stays behind it as a same-quality-class fallback in the container
// everything else uses, not because 774 is known to be a problem.
//
// Non-catalogue uploads (fan reuploads and the like) carry no Premium tier
// at all and correctly fall through to 140 - that is the source, not a bug.
//
// Neither rung is lossless; YouTube Music has no lossless tier at all.
const AUDIO_FORMAT: &str = "774/141/bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[ext=webm]/bestaudio/b[ext=mp4][acodec!=none]";
#[cfg(not(target_os = "macos"))]
const AUDIO_FORMAT: &str = "bestaudio[ext=webm]/bestaudio";

/// yt-dlp format selectors for the music-video stream. Progressive
/// (muxed) only: we pipe yt-dlp's stdout straight through, and merging
/// separate video+audio tracks would need ffmpeg, which we don't ship —
/// so no `bestvideo+bestaudio`, and no bare `best` (that can resolve to
/// an adaptive video-only file). On macOS the selection is pinned to
/// h264-in-mp4 (`vcodec^=avc1`) with itag 18 as the floor, which is what
/// WKWebView can actually decode. Other platforms get a webm progressive
/// last resort on top of that.
#[cfg(target_os = "macos")]
const VIDEO_FORMAT: &str = "b[ext=mp4][vcodec^=avc1][acodec!=none]/18";

/// Video-only DASH selector for the companion surface. h264-in-mp4
/// only (WKWebView decode), capped at the user's chosen height. The
/// bare `bv[vcodec^=avc1]` tail keeps a video with nothing under the
/// cap playable at whatever it has.
fn vonly_format(height: u32) -> String {
    if height > 1080 {
        // YouTube has no h264 above 1080p; 1440p/4K are VP9 (or AV1).
        // Modern WKWebView decodes VP9-in-WebM, and the frontend falls
        // back to artwork if this machine's decoder refuses. The avc1
        // rungs keep a non-VP9 video playable at 1080p.
        format!(
            "bv[ext=webm][vcodec^=vp9][height<={height}]/bv[ext=mp4][vcodec^=avc1][height<=1080]/bv[ext=mp4][vcodec^=avc1]/bv[vcodec^=avc1]"
        )
    } else {
        format!(
            "bv[ext=mp4][vcodec^=avc1][height<={height}]/bv[ext=mp4][vcodec^=avc1]/bv[vcodec^=avc1]"
        )
    }
}
#[cfg(not(target_os = "macos"))]
const VIDEO_FORMAT: &str =
    "b[ext=mp4][vcodec^=avc1][acodec!=none]/18/b[ext=webm][acodec!=none]";

/// Run yt-dlp to resolve a videoId into metadata JSON.
#[tauri::command]
fn resolve_stream_ytdlp(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    if !sanitize_video_id(&video_id) {
        return Err(format!("invalid videoId: {video_id}"));
    }
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    // Same jar the InnerTube pipeline uses. Without it YouTube refuses
    // Premium-only tracks outright and caps everything else at 130k.
    let cookies = tauri::async_runtime::block_on(ytdlp_cookie_file(&app));
    let mut command = std::process::Command::new(ytdlp::program(&ytdlp::managed_path(&app)));
    command.args([
        "-j",
        "-f",
        AUDIO_FORMAT,
        "--no-playlist",
        "--no-warnings",
    ]);
    command.args(ytdlp::js_runtime_args());
    if let Some(path) = cookies.as_ref() {
        command.arg("--cookies").arg(path);
    }
    command.arg(&url);
    let output = command.output().map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp exit {}: {}",
            output.status,
            stderr.chars().take(400).collect::<String>()
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("stdout not utf8: {e}"))
}

/// Resolve the HLS variant URL for a music video. WKWebView plays HLS
/// natively (AVFoundation), which is the only way past the 360p
/// progressive ceiling without shipping ffmpeg: YouTube's iOS client
/// exposes per-quality m3u8 variants up to 1080p, and
/// `best[protocol^=m3u8]` picks the top one. The URL goes straight to
/// the media element (googlevideo allows anonymous playback from the
/// resolving IP); no proxying, no disk cache. Callers fall back to the
/// progressive proxy stream when this errors (id has no HLS).
#[tauri::command]
fn resolve_hls_stream(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    if !sanitize_video_id(&video_id) {
        return Err(format!("invalid videoId: {video_id}"));
    }
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let mut command = std::process::Command::new(ytdlp::program(&ytdlp::managed_path(&app)));
    command.args([
        "-g",
        "-f",
        "best[protocol^=m3u8]",
        "--no-playlist",
        "--no-warnings",
        "--extractor-args",
        "youtube:player_client=ios",
    ]);
    command.args(ytdlp::js_runtime_args());
    command.arg(&url);
    let output = command
        .output()
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp exit {}: {}",
            output.status,
            stderr.chars().take(400).collect::<String>()
        ));
    }
    let stdout = String::from_utf8(output.stdout).map_err(|e| format!("stdout not utf8: {e}"))?;
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("http") && l.contains("m3u8"))
        .ok_or_else(|| "no hls url in yt-dlp output".to_string())?;
    Ok(line.to_string())
}

/// Lifecycle of a single track's yt-dlp download. yt-dlp writes
/// bytes into a `<videoId>.part` file which is renamed to
/// `<videoId>.webm` on successful completion; stream handlers block on
/// `notify` until `complete` flips.
struct DownloadState {
    complete: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

type DownloadMap = Arc<Mutex<HashMap<String, Arc<DownloadState>>>>;

// NB: `cookies.enc` is read only by the InnerTube pipeline (library,
// search, liked songs). We deliberately do NOT forward cookies to
// yt-dlp: YouTube's bot-detection treats any authenticated yt-dlp
// request as a bot and strips every real audio format, leaving only
// storyboard thumbnails — so anonymous streaming via yt-dlp's default
// clients actually works better than authenticated streaming.
#[derive(Clone)]
struct StreamServer {
    /// Persistent cache. Tracks land here for Premium-authenticated
    /// users and stay across app restarts.
    cache_dir: PathBuf,
    /// Session-only cache for anonymous / Free users. Wiped on every
    /// app startup (see `start_stream_server`) so a non-Premium session
    /// never accumulates a track library on disk. The `download` map
    /// keys are prefixed (`e:` vs `p:`) so the same videoId can be
    /// in-flight independently for the two modes.
    ephemeral_dir: PathBuf,
    cover_dir: PathBuf,
    downloads: DownloadMap,
    /// Expected location of the managed yt-dlp copy. Resolution to an
    /// actual program (managed vs PATH fallback) happens per-spawn via
    /// `ytdlp::program` so a mid-session download takes effect
    /// immediately.
    ytdlp_bin: PathBuf,
    /// Needed to decrypt the cookie jar before each yt-dlp spawn, so
    /// downloads run as the signed-in (Premium) user rather than
    /// anonymously. See `ytdlp_cookie_file`.
    app: tauri::AppHandle,
    /// In-flight range-proxy downloads (see stream_proxy.rs). Keyed the
    /// same as `downloads`; a proxied download ALSO holds a `downloads`
    /// entry so the legacy attach/dedupe logic sees it.
    proxies: stream_proxy::ProxyMap,
    /// Shared client for googlevideo range fetches.
    http: reqwest::Client,
}

/// Read a boolean query flag (`?name=1` / `?name=true`) off a stream/
/// prefetch request.
fn query_flag(req: &Request, name: &str) -> bool {
    let Some(query) = req.uri().query() else {
        return false;
    };
    query.split('&').any(|kv| {
        let mut it = kv.splitn(2, '=');
        let key = it.next().unwrap_or("");
        let val = it.next().unwrap_or("");
        key == name && (val == "1" || val == "true")
    })
}

/// `?ephemeral=1` routes the download to `ephemeral_dir` instead of the
/// persistent cache.
fn is_ephemeral(req: &Request) -> bool {
    query_flag(req, "ephemeral")
}

/// `?video=1` asks for the music-video stream (progressive h264/mp4)
/// instead of the audio-only one. Cached side by side with the audio
/// variant under a distinct filename.
fn is_video(req: &Request) -> bool {
    query_flag(req, "video")
}

/// Which of the three cached stream variants a request refers to.
/// `Muxed` is the progressive 360p file (WKWebView-decodable audio+
/// video in one container, the historical `?video=1`), `VideoOnly` is
/// the high-res DASH video track used as a muted companion surface
/// while the audio variant stays the playback master (YouTube stopped
/// serving progressive files above 360p, and merging tracks would need
/// ffmpeg, which we don't ship).
#[derive(Clone, Copy, PartialEq)]
enum StreamVariant {
    Audio,
    Muxed,
    /// Payload = height cap for the DASH pick (1080/720/480/360),
    /// which is also part of the cache filename so each quality is
    /// cached independently.
    VideoOnly(u32),
}

/// Allowed vonly caps. Anything else in `?h=` falls back to 1080 so a
/// hand-crafted query can't turn into an unbounded cache-name space.
const VONLY_HEIGHTS: [u32; 6] = [2160, 1440, 1080, 720, 480, 360];

fn vonly_height(req: &Request) -> u32 {
    let h = req
        .uri()
        .query()
        .and_then(|q| {
            q.split('&').find_map(|kv| {
                let mut it = kv.splitn(2, '=');
                (it.next() == Some("h")).then(|| it.next().unwrap_or(""))?.parse::<u32>().ok()
            })
        })
        .unwrap_or(1080);
    if VONLY_HEIGHTS.contains(&h) { h } else { 1080 }
}

fn stream_variant(req: &Request) -> StreamVariant {
    if query_flag(req, "vonly") {
        StreamVariant::VideoOnly(vonly_height(req))
    } else if is_video(req) {
        StreamVariant::Muxed
    } else {
        StreamVariant::Audio
    }
}

/// On-disk names for one videoId's cached stream + its in-flight part
/// file. Audio keeps the historical `.webm` name (regardless of actual
/// container — see `sniff_stream_mime`); the video variant lives next
/// to it so the same id can have both cached.
fn stream_file_names(video_id: &str, variant: StreamVariant) -> (String, String) {
    match variant {
        StreamVariant::Muxed => (
            format!("{video_id}.video.part"),
            format!("{video_id}.video.mp4"),
        ),
        StreamVariant::VideoOnly(h) => (
            format!("{video_id}.vonly{h}.part"),
            format!("{video_id}.vonly{h}.mp4"),
        ),
        StreamVariant::Audio => (format!("{video_id}.part"), format!("{video_id}.webm")),
    }
}

/// Hash a URL into a stable hex filename. Uses Rust's stdlib
/// SipHash13 (DefaultHasher) — not cryptographic, but for cache-key
/// purposes only and keeps the dependency footprint small.
fn url_to_filename(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());
    let ext = if url.contains(".png") {
        "png"
    } else if url.contains(".webp") {
        "webp"
    } else {
        "jpg"
    };
    format!("{hash}.{ext}")
}

fn cover_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.state::<ActiveCacheRoot>().0.join("covers")
}

/// Download a cover image (typically from iTunes / mzstatic) and stash
/// it in the local cover cache, returning a localhost URL the webview
/// can use as `<img src>`. Subsequent calls for the same URL skip the
/// network and just return the existing local URL.
///
/// We don't cache failures — the next track switch retries.
#[tauri::command]
async fn cache_cover(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamServerState>,
    url: String,
) -> Result<String, String> {
    let port = {
        let p = state.port.lock().await;
        p.ok_or_else(|| "stream server not ready".to_string())?
    };
    let token = {
        let t = state.token.lock().await;
        t.clone()
            .ok_or_else(|| "stream server not ready".to_string())?
    };

    // SSRF guard: cover URLs come from remote metadata (iTunes/mzstatic +
    // YT image hosts). Only fetch https from those known CDNs so a crafted
    // metadata field can't point the server-side fetch at an internal
    // service (e.g. 169.254.169.254 or a LAN admin page). Redirects are
    // disabled below so a CDN-looking URL can't 302 into the allowlist.
    {
        let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
        if parsed.scheme() != "https" {
            return Err(format!("blocked scheme: {}", parsed.scheme()));
        }
        const ALLOWED_HOST_SUFFIXES: &[&str] = &[
            "mzstatic.com",
            "ytimg.com",
            "ggpht.com",
            "googleusercontent.com",
        ];
        let host = parsed.host_str().unwrap_or("");
        let host_ok = ALLOWED_HOST_SUFFIXES
            .iter()
            .any(|s| host == *s || host.ends_with(&format!(".{s}")));
        if !host_ok {
            return Err(format!("blocked cover host: {host}"));
        }
    }

    let dir = cover_cache_dir(&app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;

    let filename = url_to_filename(&url);
    let path = dir.join(&filename);

    if !path.exists() {
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("client: {e}"))?
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("fetch: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
        // Write to a .part file then atomically rename so a concurrent
        // reader never sees a half-written file.
        let part = path.with_extension(format!(
            "{}.part",
            path.extension().and_then(|e| e.to_str()).unwrap_or("")
        ));
        tokio::fs::write(&part, &bytes)
            .await
            .map_err(|e| format!("write: {e}"))?;
        tokio::fs::rename(&part, &path)
            .await
            .map_err(|e| format!("rename: {e}"))?;
    }

    Ok(format!("http://127.0.0.1:{port}/{token}/cover/{filename}"))
}

#[derive(serde::Serialize)]
struct CoverCacheStats {
    count: u64,
    bytes: u64,
}

/// Sum up the cover cache directory. Used by the Settings UI to show
/// "Covers: 47 files, 12 MB" alongside the existing track-cache row.
#[tauri::command]
async fn cover_cache_stats(app: tauri::AppHandle) -> Result<CoverCacheStats, String> {
    let dir = cover_cache_dir(&app);
    let mut count: u64 = 0;
    let mut bytes: u64 = 0;
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CoverCacheStats { count: 0, bytes: 0 });
        }
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        count += 1;
        bytes += meta.len();
    }
    Ok(CoverCacheStats { count, bytes })
}

/// Wipe every file in the cover cache directory. Returns total bytes
/// freed. The directory itself is preserved so the next `cache_cover`
/// call doesn't have to recreate it.
#[tauri::command]
async fn clear_cover_cache(app: tauri::AppHandle) -> Result<u64, String> {
    let dir = cover_cache_dir(&app);
    let mut freed: u64 = 0;
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        freed += meta.len();
        let _ = tokio::fs::remove_file(e.path()).await;
    }
    Ok(freed)
}

const ALLOWED_IMAGE_HOST_SUFFIXES: &[&str] = &[
    "mzstatic.com",
    "ytimg.com",
    "ggpht.com",
    "googleusercontent.com",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ImageUrlKind {
    /// An allowlisted remote CDN over https.
    Remote,
    /// The app's own cover server on loopback (http://127.0.0.1:<port>/...).
    Loopback,
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// SSRF gate: an image URL is fetchable only if it's the app's own loopback
/// cover server, or https on one of the known art CDNs. Everything else is
/// rejected so a crafted metadata field can't point the server-side fetch at
/// an internal service.
fn classify_image_url(url: &reqwest::Url) -> Result<ImageUrlKind, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "image url missing host".to_string())?;
    if is_loopback_host(host) {
        return match url.scheme() {
            "http" | "https" => Ok(ImageUrlKind::Loopback),
            scheme => Err(format!("blocked loopback scheme: {scheme}")),
        };
    }
    if url.scheme() != "https" {
        return Err(format!("blocked scheme: {}", url.scheme()));
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host_ok = ALLOWED_IMAGE_HOST_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")));
    if host_ok {
        Ok(ImageUrlKind::Remote)
    } else {
        Err(format!("blocked image host: {host}"))
    }
}

/// Follow redirects, but only to a target of the SAME kind as the start —
/// a remote CDN may only 3xx to another allowlisted CDN, and a loopback URL
/// may only 3xx to loopback. This keeps the old `redirect::none()` SSRF
/// guarantee (a CDN can't bounce us into an internal host) while still
/// following the routine 3xx that Google/YT image URLs hand out.
fn image_redirect_policy(initial: ImageUrlKind) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 8 {
            return attempt.error(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "too many image redirects",
            ));
        }
        match classify_image_url(attempt.url()) {
            Ok(kind) if kind == initial => attempt.follow(),
            Ok(_) => attempt.error(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "blocked cross-context image redirect",
            )),
            Err(e) => {
                attempt.error(std::io::Error::new(std::io::ErrorKind::PermissionDenied, e))
            }
        }
    })
}

fn image_referer(url: &reqwest::Url) -> Option<&'static str> {
    let host = url.host_str()?;
    if is_loopback_host(host) {
        return None;
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "mzstatic.com" || host.ends_with(".mzstatic.com") {
        Some("https://music.apple.com/")
    } else {
        Some("https://music.youtube.com/")
    }
}

/// Fetch image bytes for cover/accent use. Accepts the app's own loopback
/// cover server and the allowlisted art CDNs (see `classify_image_url`),
/// follows same-kind redirects, and sends browser-like headers so a CDN
/// that 403s a bare client (hotlink protection) still returns the image.
async fn fetch_image_bytes(url: &str) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("bad url: {e}"))?;
    let kind = classify_image_url(&parsed)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(image_redirect_policy(kind))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let mut req = client
        .get(parsed.clone())
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
             (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        )
        .header(
            reqwest::header::ACCEPT,
            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        );
    if let Some(referer) = image_referer(&parsed) {
        req = req.header(reqwest::header::REFERER, referer);
    }
    let resp = req.send().await.map_err(|e| format!("fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(resp
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?
        .to_vec())
}

/// Fallback accent when the art is near-monochrome or otherwise doesn't
/// yield a legible color: the app's YouTube-red brand color.
// Neutral fallback for near-monochrome art (black-and-white covers, dark
// photos) where `accent_from_bytes` finds no vibrant hue. A muted grey
// reads as a deliberate neutral accent; the old brand red looked like a
// bug against a desaturated cover.
const ACCENT_FALLBACK: &str = "#71717A";

fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (r, g, b) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d.abs() < f64::EPSILON {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if (max - r).abs() < f64::EPSILON {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if (max - g).abs() < f64::EPSILON {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } * 60.0;
    (h, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    if s.abs() < f64::EPSILON {
        let v = (l * 255.0).round() as u8;
        return (v, v, v);
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let hk = h / 360.0;
    let tc = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 1.0 / 2.0 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    (
        (tc(hk + 1.0 / 3.0) * 255.0).round() as u8,
        (tc(hk) * 255.0).round() as u8,
        (tc(hk - 1.0 / 3.0) * 255.0).round() as u8,
    )
}

/// Pick the accent color for a cover.
///
/// Three rungs, in order:
///
/// 1. VIVID — a saturated hue that also *covers* enough of the art. The
///    coverage floor is the whole point: without it the most saturated
///    hue wins by default, so a cover that is 95% steel-grey with two
///    small gold record-label logos got a brass accent off 0.15% of its
///    pixels. Measured over the local cover cache, 15 of 284 covers were
///    being themed by under 1% of the image. The 1% floor is Google's
///    Material `CUTOFF_EXCITED_PROPORTION`, tuned there against real
///    wallpapers and matching our corpus well.
/// 2. MUTED — nothing vivid is big enough, so tint from the art's own
///    overall color instead of a speck. A desaturated cover gets a
///    quiet version of what it actually looks like.
/// 3. NEUTRAL — genuinely monochrome art: `None`, and the caller uses
///    ACCENT_FALLBACK.
///
/// Ranking within the vivid rung stays saturation-weighted mass rather
/// than Material's population-weighted score: scored that way on the
/// same corpus, covers dominated by a person swung to skin tone (Lungi
/// Dance traded its blue plaid for tan). Coverage as a *filter* fixes
/// the speck bug without letting area outvote color identity.
fn accent_from_bytes(bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?;
    let small = img.thumbnail(64, 64).to_rgb8();
    let total = small.pixels().len() as f64;
    if total <= 0.0 {
        return None;
    }
    /// Winner must cover at least this share of ALL sampled pixels.
    const MIN_COVERAGE: f64 = 0.01;

    // Two hue grids, the second offset by half a bucket. A single fixed
    // grid splits a hue that straddles a boundary (a red spread across
    // 355 deg and 10 deg lands in two buckets), which would let a
    // genuinely dominant color fail the coverage floor on a technicality
    // — 9 of the low-coverage covers in the corpus were exactly this.
    let mut best: Option<(f64, f64, f64, f64)> = None; // (mass, r, g, b)
    for offset in [0.0f64, 15.0] {
        let mut sum = [[0f64; 3]; 12];
        let mut weight = [0f64; 12];
        let mut count = [0u32; 12];
        for p in small.pixels() {
            let (h, s, l) = rgb_to_hsl(p[0], p[1], p[2]);
            if !(0.20..=0.75).contains(&l) || s < 0.35 {
                continue;
            }
            let bucket = ((((h - offset).rem_euclid(360.0)) / 30.0).floor() as usize) % 12;
            sum[bucket][0] += p[0] as f64 * s;
            sum[bucket][1] += p[1] as f64 * s;
            sum[bucket][2] += p[2] as f64 * s;
            weight[bucket] += s;
            count[bucket] += 1;
        }
        for i in 0..12 {
            if weight[i] <= 0.0 || (count[i] as f64) / total < MIN_COVERAGE {
                continue;
            }
            if best.map_or(true, |(m, ..)| weight[i] > m) {
                best = Some((
                    weight[i],
                    sum[i][0] / weight[i],
                    sum[i][1] / weight[i],
                    sum[i][2] / weight[i],
                ));
            }
        }
    }

    if let Some((_, r, g, b)) = best {
        // Force the winner into the legible band: floor the saturation so
        // a muted average still shows as a color, and clamp lightness so
        // it's neither lost on black nor washed out under white text.
        let (h, s, l) = rgb_to_hsl(r.round() as u8, g.round() as u8, b.round() as u8);
        let (rr, gg, bb) = hsl_to_rgb(h, s.max(0.5), l.clamp(0.45, 0.70));
        return Some(format!("#{rr:02X}{gg:02X}{bb:02X}"));
    }

    muted_accent(&small, total)
}

/// Rung 2: tint derived from the art as a whole.
///
/// Hue is summed as a circular vector so opposing colors cancel instead
/// of averaging into a false middle, and each pixel's pull is capped so a
/// tiny ultra-saturated logo cannot outvote a large quiet field — the
/// same failure the coverage floor exists to stop.
///
/// Two independent tests must pass, because hue is numerically unstable
/// near grey and boosting noise would invent a color the art never had:
/// `evidence` (is there enough color at all) and `focus` (does it agree
/// on one hue).
fn muted_accent(small: &image::RgbImage, total: f64) -> Option<String> {
    /// Per-pixel cap on hue pull.
    const CHROMA_CAP: f64 = 0.15;
    /// Minimum color mass over the whole image.
    const MIN_EVIDENCE: f64 = 0.015;
    /// Minimum agreement among the pixels that carry color.
    const MIN_FOCUS: f64 = 0.40;

    let (mut vx, mut vy, mut wsum) = (0f64, 0f64, 0f64);
    let mut lights: Vec<f64> = Vec::new();
    for p in small.pixels() {
        let (h, _, l) = rgb_to_hsl(p[0], p[1], p[2]);
        if !(0.15..=0.85).contains(&l) {
            continue;
        }
        let max = p[0].max(p[1]).max(p[2]) as f64;
        let min = p[0].min(p[1]).min(p[2]) as f64;
        let w = ((max - min) / 255.0).min(CHROMA_CAP);
        let rad = h.to_radians();
        vx += w * rad.cos();
        vy += w * rad.sin();
        wsum += w;
        lights.push(l);
    }
    if lights.is_empty() || wsum <= 0.0 {
        return None;
    }
    let mag = vx.hypot(vy);
    let evidence = mag / total;
    let focus = mag / wsum;
    if evidence < MIN_EVIDENCE || focus < MIN_FOCUS {
        return None;
    }

    let h = vy.atan2(vx).to_degrees().rem_euclid(360.0);
    // Saturation floor is not cosmetic: the frontend's `legibleAccent()`
    // replaces anything under 0.22 with plain white, which would throw
    // away the tint we just derived.
    let s = (4.0 * evidence).clamp(0.25, 0.40);
    lights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut l = lights[lights.len() / 2].clamp(0.56, 0.70);

    // `legibleAccent()` also force-saturates any accent whose gamma-space
    // luma is below 0.5 (a rule meant for dark vivid accents on their own
    // backdrop). A quiet tint would come back neon, so lift it just past
    // that line here instead.
    while l < 0.80 {
        let (r, g, b) = hsl_to_rgb(h, s, l);
        let luma =
            0.2126 * (r as f64 / 255.0) + 0.7152 * (g as f64 / 255.0) + 0.0722 * (b as f64 / 255.0);
        if luma >= 0.50 {
            break;
        }
        l += 0.01;
    }
    let (rr, gg, bb) = hsl_to_rgb(h, s, l);
    Some(format!("#{rr:02X}{gg:02X}{bb:02X}"))
}

/// Album-art accent color for the fullscreen player. Fetches the art and
/// computes a vibrant dominant color off-thread. Always resolves (falls
/// back to brand red) so the frontend can set it unconditionally.
#[tauri::command]
async fn dominant_accent_color(url: String) -> Result<String, String> {
    let bytes = fetch_image_bytes(&url).await?;
    let color = tokio::task::spawn_blocking(move || accent_from_bytes(&bytes))
        .await
        .map_err(|e| format!("join: {e}"))?;
    Ok(color.unwrap_or_else(|| ACCENT_FALLBACK.to_string()))
}

/// Push the current track into the macOS system Now Playing panel
/// (title / artist / album / times / play state). A no-op off macOS
/// (see `now_playing`).
#[tauri::command]
fn set_now_playing(info: now_playing::NowPlayingInfo) {
    now_playing::apply(&info);
}

/// Hold (or release) the anti-App-Nap activity assertion. The audio
/// engine sends true while a track is loading or playing and false
/// when idle/paused — see `app_nap` for why the loading gap needs it.
/// A no-op off macOS.
#[tauri::command]
fn set_playback_activity(active: bool) {
    app_nap::set_active(active);
}

/// One line from the webview into the app log, prefixed `[web]`. The
/// Dock-launched app has no console on that side either, and the
/// desktop-switch stall (play requested, nothing happens) lives entirely
/// in the media element, so its timeline has to reach the same
/// timestamped file as the stream server's.
#[tauri::command]
fn frontend_log(line: String) {
    eprintln!("[web] {}", line.chars().take(400).collect::<String>());
}

#[derive(Default)]
struct StreamServerState {
    port: Arc<Mutex<Option<u16>>>,
    /// Per-launch secret used as a path prefix on every stream/prefetch/
    /// cover URL. The frontend gets it baked into the base URL, so it's
    /// transparent to the webview; a web page in the user's browser that
    /// guesses the random port still can't form a valid URL — this closes
    /// the CSRF-spawn and DNS-rebinding-read vectors.
    token: Arc<Mutex<Option<String>>>,
    /// The exact router the loopback listener is serving. Stashed so the
    /// on-demand LAN listener can serve the same one on a second socket:
    /// rebuilding it there would be a second copy of the route table free
    /// to drift out of step with this one. Cloning a Router is cheap.
    router: Arc<Mutex<Option<Router>>>,
    /// The LAN listener, alive only while something is casting. `None` is
    /// the normal state and means nothing off this machine can reach the
    /// server at all.
    lan: Arc<Mutex<Option<LanListener>>>,
}

#[tauri::command]
async fn get_stream_base_url(state: tauri::State<'_, StreamServerState>) -> Result<String, String> {
    let port = *state.port.lock().await;
    let token = state.token.lock().await.clone();
    match (port, token) {
        (Some(p), Some(t)) => Ok(format!("http://127.0.0.1:{p}/{t}")),
        _ => Err("stream server not ready".to_string()),
    }
}

/// A live `0.0.0.0` listener, kept only for as long as a receiver needs to
/// pull media from us. Casting to a TV means the TV does the fetching, and
/// loopback is invisible from anywhere but this machine. Binding wide for
/// the whole session would put the media server on every network the laptop
/// ever joins, so it goes up and comes back down with the cast instead.
struct LanListener {
    base_url: String,
    /// Firing this makes axum stop accepting and drop the socket, which is
    /// what actually frees the port again.
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

/// The address other machines on this network would reach us on: the source
/// address the kernel picks for off-link traffic, i.e. the one belonging to
/// whichever interface currently holds the default route. A UDP `connect` is
/// nothing but a routing-table lookup, so no packet leaves the box, no name
/// is resolved, and it answers instantly with no internet. It also beats
/// walking the interface list, which needs a crate and still leaves us
/// guessing which of the loopback/utun/bridge addresses a receiver could use.
/// The probe target is documentation space (RFC 5737) on purpose: nobody
/// routes it specially, so it always falls through to the default route.
fn lan_ipv4() -> Result<Ipv4Addr, String> {
    let probe = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|e| format!("no usable LAN address (socket: {e})"))?;
    probe
        .connect((Ipv4Addr::new(203, 0, 113, 1), 9))
        .map_err(|e| format!("no usable LAN address (no route off this machine: {e})"))?;
    let ip = match probe.local_addr() {
        Ok(SocketAddr::V4(a)) => *a.ip(),
        Ok(other) => return Err(format!("no usable LAN address (got {other})")),
        Err(e) => return Err(format!("no usable LAN address ({e})")),
    };
    // Handing back one of these would produce a cast that connects and then
    // silently never buffers: the receiver can't fetch from any of them.
    if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_multicast() {
        return Err(format!("no usable LAN address (got {ip})"));
    }
    Ok(ip)
}

/// Bring the LAN listener up if it isn't already and hand back its base URL.
/// Same router and same token as the loopback listener, so a receiver's GET
/// and the webview's GET land in identical handlers, and the unguessable
/// prefix keeps gating them: what the LAN sees is a token wall, not an open
/// file server. Idempotent, a second cast reuses the running listener.
// NB: not `pub`. A `pub` #[tauri::command] at the crate root makes the macro
// re-export its generated `__cmd__*` into the root macro namespace where the
// macro already lives, which is a redefinition (E0255). Every command in this
// file is private for that reason; the `pub` ones live in submodules.
#[tauri::command]
async fn stream_lan_base_url(
    state: tauri::State<'_, StreamServerState>,
) -> Result<String, String> {
    let mut lan = state.lan.lock().await;
    if let Some(running) = lan.as_ref() {
        return Ok(running.base_url.clone());
    }

    let token = state
        .token
        .lock()
        .await
        .clone()
        .ok_or("stream server not ready")?;
    let app = state
        .router
        .lock()
        .await
        .clone()
        .ok_or("stream server not ready")?;
    // Resolve the address before binding so a machine with no route off it
    // never opens the wide socket at all.
    let ip = lan_ipv4()?;

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("lan bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("lan local_addr failed: {e}"))?
        .port();

    let (shutdown, signal) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let served = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = signal.await;
        });
        if let Err(e) = served.await {
            eprintln!("[stream-server] lan serve error: {e}");
        }
    });

    let base_url = format!("http://{ip}:{port}/{token}");
    eprintln!("[stream-server] lan listening on 0.0.0.0:{port}, advertising {ip}");
    *lan = Some(LanListener {
        base_url: base_url.clone(),
        shutdown,
        task,
    });
    Ok(base_url)
}

/// Take the LAN listener back down. Idempotent, because a disconnect can
/// arrive from a session that never needed one (playback stayed local, or a
/// connect failed) and that isn't an error.
#[tauri::command]
async fn stream_lan_stop(state: tauri::State<'_, StreamServerState>) -> Result<(), String> {
    let listener = state.lan.lock().await.take();
    let listener = match listener {
        Some(l) => l,
        None => return Ok(()),
    };
    let _ = listener.shutdown.send(());
    // Graceful means axum drops the socket immediately (port free) but then
    // waits out in-flight responses, and a receiver parked on an open media
    // stream would keep that wait, and us, alive indefinitely. Give the
    // response a moment to end on its own, then cut it. Detached so a
    // disconnect returns to the UI at once.
    let mut task = listener.task;
    tokio::spawn(async move {
        if tokio::time::timeout(Duration::from_secs(3), &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
    });
    eprintln!("[stream-server] lan listener stopped");
    Ok(())
}

/// Spawn a yt-dlp downloader that writes into the shared memory buffer
/// AND to a part file on disk (names per `stream_file_names`). On
/// successful exit, renames the part file to its final name. Updates
/// `state.complete` + pings `notify` on every new chunk.
///
/// `video` picks the music-video stream (progressive h264/mp4) over the
/// audio-only one. `target_dir` selects which on-disk pool to write to
/// (persistent or ephemeral). `map_key` is the prefixed key in
/// `srv.downloads` so a single videoId can be in-flight independently
/// for every pool/variant combination.
fn spawn_downloader(
    video_id: String,
    variant: StreamVariant,
    target_dir: PathBuf,
    map_key: String,
    srv: StreamServer,
    state: Arc<DownloadState>,
) {
    let downloads = srv.downloads.clone();
    tokio::spawn(async move {
        let url = format!("https://www.youtube.com/watch?v={video_id}");
        let (part_name, final_name) = stream_file_names(&video_id, variant);
        let part_path = target_dir.join(part_name);
        let final_path = target_dir.join(final_name);
        let _ = tokio::fs::create_dir_all(&target_dir).await;
        let _ = tokio::fs::remove_file(&part_path).await; // clean stale

        let mut cmd = TokioCommand::new(ytdlp::program(&srv.ytdlp_bin));
        cmd.args([
            "-f",
            &match variant {
                StreamVariant::Muxed => VIDEO_FORMAT.to_string(),
                StreamVariant::VideoOnly(h) => vonly_format(h),
                StreamVariant::Audio => AUDIO_FORMAT.to_string(),
            },
            "--no-playlist",
            "--no-warnings",
            "--no-part",
            "-q",
            // YouTube regularly hands out a signed media URL that then 403s
            // on the very first byte-range request (token/pot desync or
            // per-URL throttling). Left alone this surfaces as a one-off
            // "download failed" that a manual re-click fixes. Retrying the
            // data download and the extractor a few times clears the vast
            // majority of these inside a single spawn, before the handler
            // ever returns 502 to the audio element.
            "--retries",
            "5",
            "--extractor-retries",
            "3",
            "--socket-timeout",
            "15",
            // No player_client pin. Every pinned client dies eventually
            // (tv → DRM Jul 2026, android_vr → deterministic 403 on all
            // media data Aug 20 2026), and a dead pin turns into this
            // exact failure: every track 403s, the handler returns 502,
            // the audio element throws SRC_NOT_SUPPORTED and the queue
            // skip-cascades. yt-dlp's own default client rotation is
            // maintained against YouTube changes and ships fixes within
            // days — the managed binary self-updates on the same cadence.
            "-o",
            "-",
        ]);
        cmd.args(ytdlp::js_runtime_args());
        // Authenticated download: Premium-only tracks are refused without
        // this, and everything else is capped at 130k. Absent (signed
        // out) it spawns anonymously exactly as before.
        if let Some(path) = ytdlp_cookie_file(&srv.app).await {
            cmd.arg("--cookies").arg(path);
        }
        cmd.arg(&url);
        let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[stream] spawn {video_id}: {e}");
                state.complete.store(true, Ordering::Release);
                state.notify.notify_waiters();
                downloads.lock().await.remove(&map_key);
                return;
            }
        };

        let mut stdout = child.stdout.take().unwrap();
        let mut file = tokio::fs::File::create(&part_path).await.ok();
        let mut buf = vec![0u8; 64 * 1024];
        let mut ok = true;
        // Per-read timeout so a wedged yt-dlp (stalled TCP / hung extractor)
        // can't keep this task and the child process alive forever with
        // `complete` stuck false — otherwise every later request for the id
        // attaches to the dead entry and blocks 120s then 504.
        const READ_TIMEOUT: Duration = Duration::from_secs(60);
        loop {
            match tokio::time::timeout(READ_TIMEOUT, stdout.read(&mut buf)).await {
                Err(_) => {
                    eprintln!("[stream] read timeout for {video_id}; killing yt-dlp");
                    let _ = child.start_kill();
                    ok = false;
                    break;
                }
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => {
                    let chunk = &buf[..n];
                    if let Some(ref mut f) = file {
                        if let Err(e) = f.write_all(chunk).await {
                            eprintln!("[stream] write .part: {e}");
                            file = None;
                            // A truncated prefix must NOT be renamed to .webm
                            // and cached — mark the whole download failed.
                            ok = false;
                        }
                    }
                    state.notify.notify_waiters();
                }
                Ok(Err(e)) => {
                    eprintln!("[stream] read stdout: {e}");
                    ok = false;
                    break;
                }
            }
        }
        if let Some(mut f) = file.take() {
            let _ = f.flush().await;
            drop(f);
        }
        let status = child.wait().await;
        let success = ok && status.map(|s| s.success()).unwrap_or(false);

        // Finish all file operations BEFORE signalling completion.
        // Otherwise handlers waiting on `state.complete` can race and
        // observe `final_path.exists() == false` in the tiny window
        // between yt-dlp exit and our rename, returning 502 even
        // though the download succeeded.
        // 32 KB floor: yt-dlp can exit 0 with a near-empty payload when
        // YouTube serves a storyboard-only response (rate-limit, geo-block,
        // SABR fallout). Renaming such a stub to .webm would pin a
        // permanently-broken cache entry that fails MEDIA_ERR_DECODE on
        // every replay — drop it instead so the next request retries.
        const MIN_AUDIO_BYTES: u64 = 32 * 1024;
        let part_size = tokio::fs::metadata(&part_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if success && part_size >= MIN_AUDIO_BYTES {
            if let Err(e) = tokio::fs::rename(&part_path, &final_path).await {
                eprintln!("[stream] rename: {e}");
                let _ = tokio::fs::remove_file(&part_path).await;
            } else {
                eprintln!("[stream] cached {video_id} ({part_size} bytes)");
            }
        } else {
            if success {
                eprintln!(
                    "[stream] download too small for {video_id}: {part_size} bytes (min {MIN_AUDIO_BYTES})"
                );
            } else {
                eprintln!("[stream] download failed {video_id}");
            }
            let _ = tokio::fs::remove_file(&part_path).await;
        }

        state.complete.store(true, Ordering::Release);
        state.notify.notify_waiters();

        if success {
            // Evict from in-memory map after a grace period so a brief
            // re-play stays in RAM, then falls back to on-disk ServeFile.
            let downloads_evict = downloads.clone();
            let key = map_key.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                downloads_evict.lock().await.remove(&key);
            });
        } else {
            // Failed: drop the entry immediately so the next play retries
            // instead of getting an instant 502 for the whole 60s window.
            downloads.lock().await.remove(&map_key);
        }
    });
}

/// Read the first 16 bytes of a completed track file and map the
/// container magic to the right mime. Audio tracks are saved with a
/// `.webm` extension regardless of what yt-dlp actually produced, so we
/// can't trust the extension; the `video` flag only switches the
/// top-level type, the container still comes from the magic bytes.
async fn sniff_stream_mime(path: &std::path::Path, video: bool) -> &'static str {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = tokio::fs::File::open(path).await {
        let _ = f.read(&mut buf).await;
    }
    if &buf[4..8] == b"ftyp" {
        if video { "video/mp4" } else { "audio/mp4" }
    } else if &buf[..4] == &[0x1A, 0x45, 0xDF, 0xA3] {
        if video { "video/webm" } else { "audio/webm" }
    } else if &buf[..3] == b"ID3" {
        "audio/mpeg"
    } else if video {
        "video/mp4"
    } else {
        "audio/webm"
    }
}

/// yt-dlp format selector for a variant — same selectors the legacy
/// downloader uses, so the proxied file is bit-identical to what
/// spawn_downloader would have produced.
fn variant_format(variant: StreamVariant) -> String {
    match variant {
        StreamVariant::Muxed => VIDEO_FORMAT.to_string(),
        StreamVariant::VideoOnly(h) => vonly_format(h),
        StreamVariant::Audio => AUDIO_FORMAT.to_string(),
    }
}

/// Get-or-start the range-proxy download for one (variant, id) key.
/// Single-flight per key: concurrent callers await one resolve+probe.
/// Errors mean "use the legacy blocking path" — and if a legacy
/// download for the key is already in flight, this errors immediately
/// so the caller attaches to it instead of double-downloading.
async fn proxy_ensure(
    srv: &StreamServer,
    video_id: &str,
    variant: StreamVariant,
    target_dir: &std::path::Path,
    map_key: &str,
    background: bool,
) -> Result<Arc<stream_proxy::ProxyState>, String> {
    let cell = {
        let mut map = srv.proxies.lock().await;
        map.entry(map_key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
            .clone()
    };
    let state = cell
        .get_or_try_init(|| async {
            // Fast-fail BEFORE the multi-second resolve when a legacy
            // yt-dlp pipe already owns this key — the caller then
            // attaches to it immediately instead of resolving first and
            // discovering the conflict a minute later.
            if srv.downloads.lock().await.contains_key(map_key) {
                return Err("legacy download already in flight".to_string());
            }
            let ctx = stream_proxy::ResolveCtx {
                ytdlp_program: ytdlp::program(&srv.ytdlp_bin),
                video_id: video_id.to_string(),
                format: variant_format(variant),
                video: variant != StreamVariant::Audio,
                // Same jar as the legacy download path: without it the
                // proxy would quietly reintroduce anonymous resolution
                // (130k cap, Premium tracks refused) for every uncached
                // track.
                cookies: ytdlp_cookie_file(&srv.app).await,
            };
            let t0 = std::time::Instant::now();
            let state = stream_proxy::prepare(&srv.http, &ctx, background).await?;
            eprintln!(
                "[proxy] {video_id}: resolved+probed in {:.2}s (total={} mime={} format={}{})",
                t0.elapsed().as_secs_f32(),
                state.total,
                state.mime,
                state.format_id.as_deref().unwrap_or("?"),
                if state.degraded { " degraded" } else { "" }
            );

            // Claim the legacy downloads slot so /prefetch and fallback
            // requests see this download as in flight. If it's already
            // claimed a legacy yt-dlp pipe owns the .part file — bail.
            let legacy = {
                let mut map = srv.downloads.lock().await;
                if map.contains_key(map_key) {
                    return Err("legacy download already in flight".to_string());
                }
                let s = Arc::new(DownloadState {
                    complete: Arc::new(AtomicBool::new(false)),
                    notify: Arc::new(Notify::new()),
                });
                map.insert(map_key.to_string(), s.clone());
                s
            };

            let (part_name, final_name) = stream_file_names(video_id, variant);
            let downloads = srv.downloads.clone();
            let evict_key = map_key.to_string();
            stream_proxy::spawn_filler(
                srv.http.clone(),
                ctx,
                state.clone(),
                target_dir.join(part_name),
                target_dir.join(final_name),
                srv.proxies.clone(),
                map_key.to_string(),
                legacy.complete.clone(),
                legacy.notify.clone(),
                move || {
                    tokio::spawn(async move {
                        downloads.lock().await.remove(&evict_key);
                    });
                },
            );
            Ok(state)
        })
        .await;
    match state {
        Ok(s) => Ok(s.clone()),
        Err(e) => {
            // A failed init leaves an empty OnceCell behind; without
            // cleanup every offline/geo-blocked track visited leaks one
            // map entry for the app's lifetime. Removing only a still-
            // uninitialized cell keeps a concurrently-succeeding init
            // reachable; the downloads-slot claim already guarantees a
            // racing duplicate init can't start a second writer.
            let mut map = srv.proxies.lock().await;
            if let Some(c) = map.get(map_key) {
                if c.get().is_none() {
                    map.remove(map_key);
                }
            }
            Err(e)
        }
    }
}

/// Answer one request against an in-flight proxied download: bounded
/// 206 windows for ranged requests, a tail-following 200 for rangeless
/// ones (WebKit fetches WebM with a single plain GET).
async fn proxy_respond(
    srv: &StreamServer,
    state: Arc<stream_proxy::ProxyState>,
    video_id: &str,
    variant: StreamVariant,
    target_dir: &std::path::Path,
    // NB: not &Request — axum's Body is !Sync, so borrowing the request
    // across the awaits below would make the handler future !Send.
    range_hdr: Option<&str>,
    t0: std::time::Instant,
) -> Response {
    use axum::http::header;
    let (part_name, final_name) = stream_file_names(video_id, variant);
    let part_path = target_dir.join(part_name);
    let final_path = target_dir.join(final_name);
    let total = state.total;
    let mime = state.mime.clone();

    match stream_proxy::parse_range(range_hdr, total) {
        Err(()) => Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(axum::body::Body::empty())
            .unwrap()
            .into_response(),
        Ok(None) => {
            eprintln!("[proxy] {video_id}: 200 tail-stream len={total} ({:.2}s)", t0.elapsed().as_secs_f32());
            let rx = stream_proxy::spawn_tail_pump(state, part_path, final_path);
            let body =
                axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, total)
                .header(header::ACCEPT_RANGES, "bytes")
                .body(body)
                .unwrap()
                .into_response()
        }
        Ok(Some(span)) => {
            let w = stream_proxy::window_span(&span);
            match stream_proxy::serve_span(&srv.http, &state, &part_path, &final_path, &w).await {
                Ok(bytes) => {
                    // Label the response from what was ACTUALLY delivered
                    // — a passthrough may legally return a shorter span
                    // than requested, and headers must never overpromise
                    // the body.
                    let end = w.start + bytes.len() as u64 - 1;
                    eprintln!(
                        "[proxy] {video_id}: 206 {}-{end}/{total} ({} bytes, {:.2}s)",
                        w.start,
                        bytes.len(),
                        t0.elapsed().as_secs_f32()
                    );
                    Response::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::CONTENT_TYPE, mime)
                        .header(header::CONTENT_LENGTH, bytes.len())
                        .header(header::CONTENT_RANGE, format!("bytes {}-{end}/{total}", w.start))
                        .header(header::ACCEPT_RANGES, "bytes")
                        .body(axum::body::Body::from(bytes))
                        .unwrap()
                        .into_response()
                }
                Err(e) => {
                    eprintln!("[proxy] {video_id}: span {}-{} failed: {e}", w.start, w.end);
                    (StatusCode::BAD_GATEWAY, "proxy fetch failed").into_response()
                }
            }
        }
    }
}

/// GET /stream/:video_id — unified serving path supporting Range
/// requests even during an active download.
async fn stream_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(video_id): Path<String>,
    req: Request,
) -> Response {
    if !sanitize_video_id(&video_id) {
        return (StatusCode::BAD_REQUEST, "invalid videoId").into_response();
    }

    let ephemeral = is_ephemeral(&req);
    let variant = stream_variant(&req);
    let target_dir = if ephemeral {
        srv.ephemeral_dir.clone()
    } else {
        srv.cache_dir.clone()
    };
    // Independent in-flight pools: {persistent, ephemeral} ×
    // {audio, muxed video, video-only}; the same id may legitimately
    // be downloading in more than one of them.
    let map_key = format!(
        "{}{}:{video_id}",
        if ephemeral { "e" } else { "p" },
        match variant {
            StreamVariant::Muxed => "v".to_string(),
            StreamVariant::VideoOnly(h) => format!("vo{h}"),
            StreamVariant::Audio => String::new(),
        },
    );
    let final_path = target_dir.join(stream_file_names(&video_id, variant).1);

    // If the full file isn't on disk yet, the preferred path is the
    // range proxy (stream_proxy.rs): resolve the direct googlevideo URL,
    // learn the exact total via a 1-byte probe, start a background
    // filler into the same .part/rename contract, and serve ranges
    // immediately — from disk below the fill line, by direct passthrough
    // above it. That answers the two constraints that historically
    // forced serve-after-full-download (unknown total length making
    // Content-Range invalid; moov-at-end m4a needing a tail read first).
    //
    // Any proxy failure (resolve, probe, legacy download already
    // holding the .part) drops to the legacy path below: start (or
    // attach to) a piped yt-dlp download and block until it completes,
    // then let ServeFile handle ranges off the finished file.
    let t0 = std::time::Instant::now();

    let range_hdr = req
        .headers()
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    eprintln!(
        "[stream] GET /stream/{video_id} range={range_hdr:?} variant={} ephemeral={ephemeral} cached={}",
        match variant {
            StreamVariant::Muxed => "muxed".to_string(),
            StreamVariant::VideoOnly(h) => format!("vonly{h}"),
            StreamVariant::Audio => "audio".to_string(),
        },
        final_path.exists()
    );

    if !final_path.exists() {
        // Mark the id as wanted by a play for as long as this request is
        // waiting on the cell, so a prefetch already queued for it stops
        // waiting as background work (see stream_proxy::foreground_waiting).
        stream_proxy::foreground_waiting(&video_id, true);
        let ensured = proxy_ensure(&srv, &video_id, variant, &target_dir, &map_key, false).await;
        stream_proxy::foreground_waiting(&video_id, false);
        match ensured {
            Ok(pstate) => {
                let range = (!range_hdr.is_empty()).then_some(range_hdr.as_str());
                return proxy_respond(&srv, pstate, &video_id, variant, &target_dir, range, t0)
                    .await;
            }
            Err(e) => {
                // The download may have completed in the window between
                // the exists() check and now — serve the file if so.
                if final_path.exists() {
                    eprintln!("[proxy] {video_id}: completed during ensure; serving file");
                } else {
                    eprintln!("[proxy] {video_id}: {e}; using legacy blocking path");
                }
            }
        }
    }

    if !final_path.exists() {
        let state = {
            let mut map = srv.downloads.lock().await;
            if let Some(s) = map.get(&map_key) {
                s.clone()
            } else {
                let s = Arc::new(DownloadState {
                    complete: Arc::new(AtomicBool::new(false)),
                    notify: Arc::new(Notify::new()),
                });
                map.insert(map_key.clone(), s.clone());
                drop(map);
                spawn_downloader(
                    video_id.clone(),
                    variant,
                    target_dir.clone(),
                    map_key.clone(),
                    srv.clone(),
                    s.clone(),
                );
                s
            }
        };

        // Bounded wait — 120 s is generous for any single track; if
        // yt-dlp is wedged past that, we'd rather fail fast than hang
        // the audio element forever.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        while !state.complete.load(Ordering::Acquire) {
            if tokio::time::Instant::now() >= deadline {
                eprintln!("[stream] {video_id}: TIMEOUT after 120s");
                return (StatusCode::GATEWAY_TIMEOUT, "download timeout").into_response();
            }
            let notified = state.notify.notified();
            tokio::pin!(notified);
            let _ = tokio::time::timeout(Duration::from_secs(5), notified).await;
        }

        if !final_path.exists() {
            eprintln!(
                "[stream] {video_id}: BAD_GATEWAY — complete but no .webm (elapsed {:.2}s)",
                t0.elapsed().as_secs_f32()
            );
            return (StatusCode::BAD_GATEWAY, "download failed").into_response();
        }
        eprintln!(
            "[stream] {video_id}: download finished in {:.2}s",
            t0.elapsed().as_secs_f32()
        );
    }

    // Sniff actual content-type from the file's magic bytes. Every
    // track is saved with a `.webm` extension, but yt-dlp falls back
    // to m4a when a video has no webm audio — serving that as
    // `video/webm` (what tower-http guesses from the extension) makes
    // Chromium refuse to decode.
    let sniffed_ct = sniff_stream_mime(&final_path, variant != StreamVariant::Audio).await;
    let mut resp = ServeFile::new(&final_path)
        .oneshot(req)
        .await
        .map(|r| r.into_response())
        .unwrap_or_else(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}")).into_response()
        });
    if resp.status().is_success() || resp.status() == StatusCode::PARTIAL_CONTENT {
        resp.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static(sniffed_ct),
        );
    }
    eprintln!(
        "[stream] {video_id}: responding {} ({:.2}s total) ct={:?} len={:?}",
        resp.status(),
        t0.elapsed().as_secs_f32(),
        resp.headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        resp.headers()
            .get(axum::http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()),
    );
    resp
}

/// GET /cover/:filename — serve a cached cover image. Files are placed
/// here by the `cache_cover` Tauri command. The filename is a hex hash +
/// extension produced by `url_to_filename`, which is the only way bytes
/// land in this directory — so accepting `[a-zA-Z0-9.]+` is enough to
/// rule out path traversal.
async fn cover_serve_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(filename): Path<String>,
    req: Request,
) -> Response {
    if filename.is_empty()
        || filename.len() > 64
        || !filename
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.')
        || filename.contains("..")
    {
        return (StatusCode::BAD_REQUEST, "invalid filename").into_response();
    }
    let path = srv.cover_dir.join(&filename);
    if !path.exists() {
        return (StatusCode::NOT_FOUND, "not cached").into_response();
    }
    let mut resp = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map(|r| r.into_response())
        .unwrap_or_else(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}")).into_response()
        });
    if resp.status().is_success() {
        // Filename is content-addressed (hash of the source URL), so
        // the bytes never change — let the webview cache aggressively.
        resp.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    resp
}

/// GET /prefetch/:video_id — fire-and-forget cache warmer. Honours the
/// same `?ephemeral=1` flag as /stream so non-Premium prefetches (if
/// the frontend ever lets one through) land in the session-only pool
/// rather than the persistent cache.
/// Drop the anonymous fallback's cached files (see `ProxyState.degraded`),
/// except the track named by `?keep=<id>`, which is the one playing now
/// and must stay readable. The frontend calls this whenever a track
/// starts, which also covers the first play after a launch, so a degraded
/// copy is never replayed once playback has moved on.
async fn degraded_evict_handler(
    AxumState(srv): AxumState<StreamServer>,
    req: Request,
) -> StatusCode {
    let keep = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("keep=")))
        .map(str::to_string)
        .filter(|id| sanitize_video_id(id));
    let mut n = stream_proxy::evict_degraded(&srv.cache_dir, keep.as_deref()).await;
    n += stream_proxy::evict_degraded(&srv.ephemeral_dir, keep.as_deref()).await;
    if n > 0 {
        eprintln!("[proxy] evicted {n} degraded cache file(s)");
    }
    StatusCode::NO_CONTENT
}

async fn prefetch_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(video_id): Path<String>,
    req: Request,
) -> StatusCode {
    if !sanitize_video_id(&video_id) {
        return StatusCode::BAD_REQUEST;
    }
    let ephemeral = is_ephemeral(&req);
    let variant = stream_variant(&req);
    let target_dir = if ephemeral {
        srv.ephemeral_dir.clone()
    } else {
        srv.cache_dir.clone()
    };
    let map_key = format!(
        "{}{}:{video_id}",
        if ephemeral { "e" } else { "p" },
        match variant {
            StreamVariant::Muxed => "v".to_string(),
            StreamVariant::VideoOnly(h) => format!("vo{h}"),
            StreamVariant::Audio => String::new(),
        },
    );
    let final_path = target_dir.join(stream_file_names(&video_id, variant).1);
    if final_path.exists() {
        return StatusCode::OK;
    }
    // Preferred: start (or join) a range-proxy download. proxy_ensure
    // claims the downloads slot atomically itself, so a concurrent
    // /stream or /prefetch can't start a second writer for the key.
    match proxy_ensure(&srv, &video_id, variant, &target_dir, &map_key, true).await {
        Ok(_) => return StatusCode::ACCEPTED,
        // A deliberate skip is NOT a failure and must not fall through to
        // the legacy downloader below: that spawns the uncapped yt-dlp the
        // skip existed to prevent. 429 tells the client this was refused
        // for pressure, not broken, so it can retry once; any other error
        // is a real proxy failure and still earns the legacy path.
        Err(e) if e == stream_proxy::SKIPPED => {
            eprintln!("[proxy] {video_id}: prefetch declined (resolver busy), not falling back");
            return StatusCode::TOO_MANY_REQUESTS;
        }
        Err(_) => {}
    }
    if final_path.exists() {
        return StatusCode::OK;
    }
    let state = {
        // Single lock hold for check-then-insert so a concurrent /stream
        // (whose check+insert is already atomic) or a second /prefetch can't
        // slip in between and spawn a second downloader writing the same
        // .part file, corrupting the cached track.
        let mut map = srv.downloads.lock().await;
        if map.contains_key(&map_key) {
            return StatusCode::ACCEPTED;
        }
        let state = Arc::new(DownloadState {
            complete: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        });
        map.insert(map_key.clone(), state.clone());
        state
    };
    spawn_downloader(video_id, variant, target_dir, map_key, srv.clone(), state);
    StatusCode::ACCEPTED
}

/// Generate an unguessable per-launch token used as a URL path prefix on
/// the local stream server. Uses OS-seeded RandomState (SipHash keys)
/// instead of pulling in an RNG crate — 128 bits is ample for a localhost
/// secret that only needs to resist online guessing by a web page.
fn generate_stream_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(0x9E37_79B9_7F4A_7C15);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

async fn start_stream_server(
    port_state: Arc<Mutex<Option<u16>>>,
    token_state: Arc<Mutex<Option<String>>>,
    router_state: Arc<Mutex<Option<Router>>>,
    cache_dir: PathBuf,
    ephemeral_dir: PathBuf,
    cover_dir: PathBuf,
    ytdlp_bin: PathBuf,
    app: tauri::AppHandle,
) {
    if let Err(e) = tokio::fs::create_dir_all(&cache_dir).await {
        eprintln!("[stream-server] mkdir {cache_dir:?}: {e}");
    }
    if let Err(e) = tokio::fs::create_dir_all(&ephemeral_dir).await {
        eprintln!("[stream-server] mkdir {ephemeral_dir:?}: {e}");
    }
    if let Err(e) = tokio::fs::create_dir_all(&cover_dir).await {
        eprintln!("[stream-server] mkdir {cover_dir:?}: {e}");
    }

    // Wipe whatever a previous (anonymous / Free) session left behind.
    // Persisting tracks across restarts is a Premium-only feature; if a
    // non-Premium user manages to crash the app mid-stream we still
    // want the leftover .webm gone before the next launch.
    if let Ok(mut rd) = tokio::fs::read_dir(&ephemeral_dir).await {
        let mut wiped: u64 = 0;
        while let Ok(Some(entry)) = rd.next_entry().await {
            if let Ok(meta) = entry.metadata().await {
                if meta.is_file() {
                    wiped += meta.len();
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
        if wiped > 0 {
            eprintln!("[stream-server] wiped {wiped} bytes from ephemeral dir");
        }
    }

    let server = StreamServer {
        cache_dir,
        ephemeral_dir,
        cover_dir,
        downloads: Arc::new(Mutex::new(HashMap::new())),
        ytdlp_bin,
        app: app.clone(),
        proxies: stream_proxy::new_proxy_map(),
        http: stream_proxy::new_http_client(),
    };

    // Per-launch token as an unguessable path prefix. Baked into the base
    // URL (get_stream_base_url) and cover URLs (cache_cover), so it's
    // transparent to the webview but blocks blind access from a web page
    // that only knows the random port.
    let token = generate_stream_token();
    *token_state.lock().await = Some(token.clone());

    let routes = Router::new()
        .route("/stream/:video_id", get(stream_handler))
        .route("/prefetch/:video_id", get(prefetch_handler))
        .route("/degraded/evict", get(degraded_evict_handler))
        .route("/cover/:filename", get(cover_serve_handler))
        .with_state(server);
    let app = Router::new()
        .nest(&format!("/{token}"), routes)
        .layer(CorsLayer::permissive());
    // Publish the router so the on-demand LAN listener (stream_lan_base_url)
    // can serve this very one, same routes and same token prefix, instead of
    // assembling its own.
    *router_state.lock().await = Some(app.clone());

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[stream-server] bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            eprintln!("[stream-server] local_addr failed: {e}");
            return;
        }
    };
    *port_state.lock().await = Some(port);
    eprintln!("[stream-server] listening on 127.0.0.1:{port}");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[stream-server] serve error: {e}");
    }
}

/// Show + focus the main window (from tray click or single-instance
/// re-launch).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// App icon for runtime surfaces (tray, taskbar). Debug builds get an
/// orange variant of the logo so a dev instance running next to an
/// installed release is distinguishable at a glance; release builds use
/// the bundled (red) icon.
fn runtime_icon(app: &tauri::AppHandle) -> tauri::image::Image<'static> {
    #[cfg(debug_assertions)]
    {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon-dev.png")) {
            return icon;
        }
    }
    app.default_window_icon()
        .cloned()
        .expect("bundled window icon missing")
        .to_owned()
}

/// The menu-bar icon. macOS extras are template images: a flat alpha mask
/// that the system repaints in the menu bar's own foreground colour, so it
/// turns white on a dark bar and black on a light one and stays legible when
/// the wallpaper changes underneath. The full-colour app icon can't do that —
/// it sat there as a red dot that ignored the system appearance. This is the
/// same play glyph with the disc dropped, black on transparency.
///
/// Everywhere else keeps the app icon: Windows and Linux trays expect colour.
fn tray_icon(app: &tauri::AppHandle) -> tauri::image::Image<'static> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        if let Ok(icon) =
            tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))
        {
            return icon;
        }
    }
    runtime_icon(app)
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show YTubic", true, None::<&str>)?;
    let play_item = MenuItem::with_id(app, "play_pause", "Play / Pause", true, Some("Space"))?;
    let prev_item = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let next_item = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item, &sep, &play_item, &prev_item, &next_item, &sep, &quit_item,
        ],
    )?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon(app))
        // No-op off macOS; there it's what makes the glyph track the menu bar.
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(if cfg!(debug_assertions) {
            "YTubic (dev)"
        } else {
            "YTubic"
        })
        .menu(&menu)
        // macOS menu-bar extras conventionally open on left-click. Windows
        // and Linux keep left-click reserved for restoring the main window.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "play_pause" => {
                let _ = app.emit("tray-action", "play_pause");
            }
            "prev" => {
                let _ = app.emit("tray-action", "prev");
            }
            "next" => {
                let _ = app.emit("tray-action", "next");
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            // Left-click the icon = show the window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls 0.23 refuses to pick a crypto backend for you when more than one
    // is compiled in, and panics the first time anything opens a TLS socket.
    // Both are: `ring` and `aws-lc-rs` arrive under the same rustls via
    // reqwest/tauri-plugin-http, and cargo unifies the features. Casting is
    // what surfaced it (the CASTv2 socket is TLS), but the ambiguity is
    // process-wide, so the choice belongs here at startup rather than in any
    // one caller. Err just means something already installed one.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let state = StreamServerState::default();
    let port_handle = state.port.clone();
    let token_handle = state.token.clone();
    let router_handle = state.router.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            // Default StateFlags includes DECORATIONS, which would
            // override our `decorations: false` from tauri.conf.json
            // every time the saved state is restored. Exclude it.
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                // Never persist or restore the hidden session-keeper windows.
                // Their saved "visible: true" + on-screen position was being
                // replayed on the next launch, popping a stray
                // music.youtube.com window into view until the user minimized
                // it. Keeping them out of the store lets their builder flags
                // (hidden, off-screen) hold on every launch.
                .with_filter(|label| !label.starts_with("keeper-"))
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(state)
        .manage(CloseBehavior::default())
        .manage(authfs::MutationLocks::default())
        .manage(RefreshGuard::default())
        .manage(discord::spawn())
        .manage(lastfm::LastfmState::default())
        // Idle until the first cast_connect: the session thread and its
        // socket only exist once a receiver is picked, so a launch that
        // never casts costs nothing.
        .manage(cast::CastState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_ytdlp,
            resolve_stream_ytdlp,
            resolve_hls_stream,
            get_stream_base_url,
            stream_lan_base_url,
            stream_lan_stop,
            cast::cast_discover,
            cast::cast_connect,
            cast::cast_disconnect,
            cast::cast_load,
            cast::cast_play,
            cast::cast_pause,
            cast::cast_stop,
            cast::cast_seek,
            cast::cast_set_volume,
            cast::cast_status,
            start_login,
            get_cookie_header,
            get_auth_context,
            merge_response_cookies,
            is_logged_in,
            auth_status,
            refresh_active_session,
            clear_cookies,
            list_accounts,
            switch_account,
            remove_account,
            update_account_meta,
            set_account_channel,
            get_active_account_id,
            list_cache,
            delete_cache_entries,
            set_cache_meta,
            cache_cover,
            cover_cache_stats,
            clear_cover_cache,
            dominant_accent_color,
            quit_app,
            set_close_behavior,
            autostart_set,
            autostart_is_enabled,
            notify_track,
            get_cache_dir,
            set_cache_dir,
            pick_cache_folder,
            focus_main_window,
            open_player_window,
            close_player_window,
            set_now_playing,
            set_playback_activity,
            frontend_log,
            media::media_update,
            media::media_clear,
            discord::discord_update,
            discord::discord_clear,
            discord::discord_set_enabled,
            lastfm::lastfm_is_configured,
            lastfm::lastfm_begin_auth,
            lastfm::lastfm_poll_session,
            lastfm::lastfm_user_info,
            lastfm::lastfm_update_now_playing,
            lastfm::lastfm_scrobble,
            lastfm::lastfm_love,
            lastfm::lastfm_flush,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // Main window: hide to tray or quit, per the user's
                    // Settings choice (default tray). Quit goes through
                    // an explicit exit — just letting the close proceed
                    // could leave a floating-player window keeping the
                    // process alive headless.
                    "main" => {
                        let quit = window
                            .state::<CloseBehavior>()
                            .quit_on_close
                            .load(Ordering::Relaxed);
                        if quit {
                            window.app_handle().exit(0);
                        } else {
                            let _ = window.hide();
                            api.prevent_close();
                        }
                    }
                    // The floating player window actually closes — we
                    // tell the main window so it can revert the layout
                    // mode back to "right".
                    "player" => {
                        let _ = window.app_handle().emit("player-window-closed", ());
                    }
                    _ => {}
                }
            }
        })
        .setup(move |app| {
            // Before anything opens an identifier-derived path (the log
            // redirect included): carry a pre-rename install's data over
            // to the new bundle identifier. Returns its report instead
            // of printing because stderr isn't captured yet.
            let identity_report = identity::migrate(app.handle());
            // From here on stderr lands in the app log with timestamps,
            // however the app was launched.
            applog::init(app.handle());
            // The cookie key's home on macOS; must precede the first
            // encrypt/decrypt, which the session load below performs.
            if let Ok(dir) = app.path().app_data_dir() {
                secure_store::init(dir);
            }
            for line in &identity_report {
                eprintln!("[identity] {line}");
            }
            let port = port_handle.clone();
            let token = token_handle.clone();
            let router = router_handle.clone();
            // User-chosen cache root (Settings → Storage) or the OS
            // default. Captured once and exposed as managed state so
            // every cache-path computation matches the directories the
            // stream server is about to bind — a preference change made
            // later only applies after relaunch.
            let cache_root =
                stored_cache_root(app.handle()).unwrap_or_else(|| default_cache_root(app.handle()));
            app.manage(ActiveCacheRoot(cache_root.clone()));
            // Retry any scrobbles stranded offline on the previous run. Spawns
            // its own task; a no-op when Last.fm isn't configured or the queue
            // is empty. See src/lastfm.rs.
            lastfm::flush_on_startup(app.handle().clone());
            let cache_dir = cache_root.join("stream");
            let ephemeral_dir = cache_root.join("stream-ephemeral");
            let cover_dir = cache_root.join("covers");
            let handle = app.handle().clone();
            // macOS Now Playing is owned by the WEBVIEW's media session
            // (navigator.mediaSession in audio-engine.ts). Registering the
            // native MPNowPlayingInfoCenter/MPRemoteCommandCenter bridge
            // alongside it put TWO rows in the system widget (a blank
            // "YTubic" twin above the real track) and double-fired
            // transport presses, so now_playing::init is no longer called.
            eprintln!("[stream-server] cache dir: {cache_dir:?}");
            eprintln!("[stream-server] ephemeral dir: {ephemeral_dir:?}");
            eprintln!("[stream-server] cover dir: {cover_dir:?}");
            let ytdlp_bin = ytdlp::managed_path(&handle);
            tauri::async_runtime::spawn(async move {
                migrate_plaintext_cookies(&handle).await;
                migrate_to_accounts_layout(&handle).await;
                // Heal any duplicate account rows left by the old
                // email-based dedup before the UI reads the list.
                dedup_accounts_by_identity(&handle).await;
                cleanup_login_artifacts(&handle).await;
                start_stream_server(
                    port,
                    token,
                    router,
                    cache_dir,
                    ephemeral_dir,
                    cover_dir,
                    ytdlp_bin,
                    handle.clone(),
                )
                .await;
            });
            // Subscribed here, after the identity migration and the log
            // redirect but before the refresh task exists, so a machine
            // waking during startup is not missed.
            session::wake::init();
            let refresh_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Let migrations + the stream server settle, and give a
                // just-completed login time to persist its profile.
                tokio::time::sleep(Duration::from_secs(20)).await;
                run_refresh_loop(refresh_handle).await;
            });
            // Native media controls: MPRIS on Linux, plus the hardware media
            // keys. setup() runs on the main thread, which souvlaki requires.
            // macOS is deliberately excluded: it has its own
            // MPRemoteCommandCenter bridge (now_playing.rs), and letting both
            // register would fight over the system Now Playing entry.
            // media_update/media_clear no-op when init never ran (CONTROLS
            // stays None).
            #[cfg(target_os = "linux")]
            media::init(app.handle());
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[tray] build failed: {e}");
            }

            // WebKitGTK disables smooth (kinetic) scrolling by default, so
            // wheel scrolling otherwise jumps in coarse steps on Linux.
            #[cfg(target_os = "linux")]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.with_webview(|webview| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    let wv = webview.inner();
                    if let Some(settings) = WebViewExt::settings(&wv) {
                        settings.set_enable_smooth_scrolling(true);
                    }
                });
            }
            // WebKit treats a window on another Space as occluded and marks
            // the page hidden. Measured on 2026-09-04, all from that one
            // state: rendering stops (the Space thumbnail goes flat grey),
            // timers slow to one tick per several minutes, a pending
            // play() is aborted on the visible-to-hidden edge, and after a
            // long pause remote media commands are accepted by WebKit and
            // never reach the page. Nothing inside the page can undo any of
            // it; this turns the detection off at the source, with the
            // same private WebKit property Electron-style shells set. The
            // cost is rendering a window nobody is looking at, which for
            // a music player is nothing next to the bugs it removes. App
            // Nap is handled separately in app_nap.rs.
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.with_webview(|webview| unsafe {
                    use objc2::msg_send;
                    use objc2::runtime::AnyObject;
                    let wk: *mut AnyObject = webview.inner().cast();
                    if wk.is_null() {
                        eprintln!("[webkit] no WKWebView handle; occlusion detection left on");
                        return;
                    }
                    let _: () = msg_send![wk, _setWindowOcclusionDetectionEnabled: false];
                    eprintln!("[webkit] window occlusion detection disabled for the main window");
                });
            }
            // Debug builds swap the taskbar/window icon to the orange
            // dev variant (see runtime_icon) so a dev instance is
            // instantly distinguishable from an installed release.
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_icon(runtime_icon(app.handle()));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // The native red button follows our close-to-menu-bar setting and
            // may hide the only window. A later Dock click emits Reopen; show
            // the window again so the running app never appears unresponsive.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main_window(_app);
            }
        });
}

#[cfg(test)]
mod accent_tests {
    use super::{accent_from_bytes, rgb_to_hsl};

    /// Encode a solid-background image with an optional patch, as PNG.
    fn art(bg: [u8; 3], patch: Option<([u8; 3], u32)>) -> Vec<u8> {
        let mut img = image::RgbImage::from_pixel(64, 64, image::Rgb(bg));
        if let Some((color, side)) = patch {
            for y in 0..side {
                for x in 0..side {
                    img.put_pixel(x, y, image::Rgb(color));
                }
            }
        }
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .expect("encode");
        out.into_inner()
    }

    fn hue_of(hex: &str) -> f64 {
        let n = u32::from_str_radix(&hex[1..], 16).unwrap();
        let (h, _, _) = rgb_to_hsl((n >> 16) as u8, (n >> 8) as u8, n as u8);
        h
    }

    /// The bug this rung exists for: a steel-grey cover with a tiny gold
    /// logo must not come out gold. 4x4 of 64x64 is 0.39%, under the 1%
    /// coverage floor.
    #[test]
    fn a_tiny_saturated_speck_does_not_win() {
        let hex = accent_from_bytes(&art([100, 112, 150], Some(([212, 175, 55], 4))))
            .expect("steel art should still yield a tint");
        let h = hue_of(&hex);
        assert!(
            (180.0..300.0).contains(&h),
            "expected a blue-ish tint from the field, got {hex} (hue {h:.0})"
        );
    }

    /// The same gold, given real presence (32x32 = 25%), is allowed to win.
    #[test]
    fn a_large_saturated_region_still_wins() {
        let hex = accent_from_bytes(&art([100, 112, 150], Some(([212, 175, 55], 32))))
            .expect("some accent");
        let h = hue_of(&hex);
        assert!(
            (30.0..70.0).contains(&h),
            "expected gold to win on coverage, got {hex} (hue {h:.0})"
        );
    }

    /// Truly monochrome art has no honest tint to offer.
    #[test]
    fn monochrome_art_yields_no_accent() {
        assert_eq!(accent_from_bytes(&art([128, 128, 128], None)), None);
    }

    /// Whatever the muted rung returns must survive the frontend's
    /// `legibleAccent()`, which whitens anything under 0.22 saturation and
    /// force-saturates anything with luma below 0.5.
    #[test]
    fn muted_output_survives_the_frontend_transform() {
        let hex = accent_from_bytes(&art([100, 112, 150], Some(([212, 175, 55], 4)))).unwrap();
        let n = u32::from_str_radix(&hex[1..], 16).unwrap();
        let (r, g, b) = ((n >> 16) as u8, (n >> 8) as u8, n as u8);
        let (_, s, _) = rgb_to_hsl(r, g, b);
        let luma =
            0.2126 * (r as f64 / 255.0) + 0.7152 * (g as f64 / 255.0) + 0.0722 * (b as f64 / 255.0);
        assert!(s >= 0.22, "{hex} would be whitened (s={s:.3})");
        assert!(luma >= 0.50, "{hex} would be force-saturated (luma={luma:.3})");
    }

    /// Parity probe against the tuning corpus. Ignored by default; run with
    /// `YTUBIC_TEST_COVER=<path> cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_accent_for_cover() {
        let path = std::env::var("YTUBIC_TEST_COVER").expect("set YTUBIC_TEST_COVER");
        let bytes = std::fs::read(&path).expect("read cover");
        println!("{path} -> {:?}", accent_from_bytes(&bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::generate_stream_token;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    #[test]
    fn stream_token_is_nonempty_hex_and_varies() {
        let a = generate_stream_token();
        let b = generate_stream_token();
        assert_eq!(a.len(), 32, "token should be 128 bits of hex");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two tokens in a row must differ");
    }

    // Guards the security fix (review high #1): the stream server nests all
    // routes under an unguessable per-launch token prefix, so a request that
    // doesn't carry the exact token can't reach a handler.
    #[test]
    fn nested_token_prefix_gates_routes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let token = "deadbeefdeadbeefdeadbeefdeadbeef";
            let inner = Router::new().route("/ping", get(|| async { "pong" }));
            let app: Router = Router::new().nest(&format!("/{token}"), inner);

            let status = |uri: &'static str, app: Router| async move {
                app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status()
            };

            assert_eq!(
                status("/deadbeefdeadbeefdeadbeefdeadbeef/ping", app.clone()).await,
                StatusCode::OK,
                "correct token reaches the handler"
            );
            assert_eq!(
                status("/wrongtoken/ping", app.clone()).await,
                StatusCode::NOT_FOUND,
                "a wrong token must not reach the handler"
            );
            assert_eq!(
                status("/ping", app).await,
                StatusCode::NOT_FOUND,
                "no token must not reach the handler"
            );
        });
    }

    use super::merge_set_cookies_into_jar;

    const NOW: i64 = 1_700_000_000;
    const HOST: &str = "music.youtube.com";

    fn jar() -> String {
        "# Netscape HTTP Cookie File\n\
         .youtube.com\tTRUE\t/\tTRUE\t1800000000\tSAPISID\told-sapisid\n\
         .youtube.com\tTRUE\t/\tTRUE\t1800000000\tSIDCC\told-sidcc\n"
            .to_string()
    }

    #[test]
    fn merge_replaces_rotated_value() {
        let lines = vec![
            "SIDCC=new-sidcc; Domain=.youtube.com; Path=/; Secure; Max-Age=31536000".to_string(),
        ];
        let (out, changed, dirty) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed && dirty);
        assert!(out.contains("SIDCC\tnew-sidcc"));
        assert!(!out.contains("old-sidcc"));
        assert!(
            out.contains("SAPISID\told-sapisid"),
            "untouched cookie survives"
        );
    }

    #[test]
    fn merge_inserts_new_cookie_with_domain() {
        let lines = vec![
            "LOGIN_INFO=abc; Domain=.youtube.com; Path=/; Secure; HttpOnly; Max-Age=63072000"
                .to_string(),
        ];
        let (out, changed, _) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed);
        assert!(out.contains(".youtube.com\tTRUE\t/\tTRUE\t1763072000\tLOGIN_INFO\tabc"));
    }

    #[test]
    fn merge_inserts_host_only_cookie_under_response_host() {
        let lines = vec!["PZS=1; Path=/; Secure; Max-Age=600".to_string()];
        let (out, changed, _) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed);
        assert!(out.contains(".music.youtube.com\tTRUE\t/\tTRUE"));
    }

    #[test]
    fn merge_removes_expired_cookie() {
        let lines = vec!["SIDCC=gone; Domain=.youtube.com; Path=/; Max-Age=0".to_string()];
        let (out, changed, _) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed);
        assert!(!out.contains("SIDCC"));
    }

    #[test]
    fn merge_ignores_foreign_domains() {
        let lines = vec![
            "tracker=1; Domain=.example.com; Path=/; Max-Age=1000".to_string(),
            "__cf_bm=x; Domain=.genius.com; Path=/; Max-Age=1000".to_string(),
        ];
        let (out, changed, dirty) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(!changed && !dirty);
        assert_eq!(out, jar(), "jar must be untouched");
    }

    /// RFC 6265 §5.3.5. The google/youtube allowlist alone accepts any
    /// google-family domain from any google-family host, so without this a
    /// music.youtube.com response could plant a cookie on
    /// accounts.google.com and we would replay it to Google as though
    /// Google had issued it.
    #[test]
    fn merge_rejects_a_domain_the_response_host_is_not_under() {
        let lines = vec![
            "EVIL=1; Domain=.google.com; Path=/; Secure; Max-Age=1000".to_string(),
            "ALSO_EVIL=1; Domain=accounts.google.com; Path=/; Secure; Max-Age=1000".to_string(),
        ];
        let (out, changed, dirty) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(!changed && !dirty);
        assert_eq!(out, jar(), "jar must be untouched");
    }

    #[test]
    fn merge_accepts_a_parent_domain_of_the_response_host() {
        // .youtube.com from music.youtube.com is legitimate, and so is a
        // host-only cookie from accounts.google.com.
        let lines = vec![
            "SIDCC=fresh; Domain=.youtube.com; Path=/; Secure; Max-Age=1000".to_string(),
        ];
        let (out, changed, _) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(changed);
        assert!(out.contains("SIDCC\tfresh"));

        let google = vec![
            "SAPISID=g; Domain=.google.com; Path=/; Secure; Max-Age=1000".to_string(),
        ];
        let (out, changed, _) =
            merge_set_cookies_into_jar(&jar(), &google, "accounts.google.com", NOW);
        assert!(changed);
        assert!(out.contains(".google.com\tTRUE\t/\tTRUE"));
    }

    #[test]
    fn merge_expiry_only_refresh_persists_without_cache_reset() {
        let lines = vec![
            "SIDCC=old-sidcc; Domain=.youtube.com; Path=/; Secure; Max-Age=31536000".to_string(),
        ];
        let (out, changed, dirty) = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(!changed, "same value must not invalidate the header cache");
        assert!(dirty, "but the fresher expiry should be written");
        assert!(out.contains(&format!("{}", NOW + 31_536_000)));
    }
}
