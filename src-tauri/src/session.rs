//! What the stored cookie jar says about the session, and when to renew it.
//!
//! Two pieces of pure logic that used to live inline in `lib.rs` and were
//! both wrong in ways that read as "you are signed out":
//!
//!   * The auth check was `header.contains("SAPISID") ||
//!     header.contains("__Secure-1PSID")` over the serialized `Cookie`
//!     header. `__Secure-1PSID` is a PREFIX of `__Secure-1PSIDTS` and
//!     `__Secure-1PSIDCC`, two cookies Google rotates independently of the
//!     session id, so a jar that had lost the real credential still
//!     reported a live session — and `contains` can also match inside a
//!     cookie's value.
//!   * The refresh loop was `loop { refresh(); sleep(20 min) }`. A tokio
//!     timer does not advance while macOS sleeps: two consecutive refreshes
//!     in our own timestamped log landed 142 and 177 minutes apart, each
//!     firing the instant the Mac woke, while Google kept rotating.

use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Cookie predicate
// ---------------------------------------------------------------------------

/// Cookies this client can actually sign a request with.
///
/// `authHeaders()` in `src/lib/innertube/shared.ts` builds the SAPISIDHASH
/// from `__Secure-3PAPISID`, falling back to `SAPISID`, and knows no other
/// name. A jar carrying only `__Secure-1PAPISID` would therefore render a
/// profile in the sidebar while every InnerTube call went out unsigned, so
/// this set has to stay a subset of what that function reads. Widen it only
/// together with that function (adding `SAPISID1PHASH` support would add
/// `__Secure-1PAPISID`).
const SIGNING_COOKIES: [&str; 2] = ["__Secure-3PAPISID", "SAPISID"];

/// YouTube clears this on logout, while a signing cookie can survive the
/// rotation that follows — which is why "has a signing cookie" alone is not
/// proof of a live session. Same pairing yt-dlp tests for.
const LOGIN_MARKER: &str = "LOGIN_INFO";

/// One line of a Netscape cookie jar:
/// `domain \t include_subdomains \t path \t secure \t expiry \t name \t value`
#[derive(Debug, Clone, Copy)]
pub struct JarCookie<'a> {
    /// Bare host, leading dot stripped.
    pub domain: &'a str,
    pub include_sub: bool,
    pub path: &'a str,
    /// Unix seconds, or 0 for a session cookie with no expiry.
    pub expiry: i64,
    pub name: &'a str,
    pub value: &'a str,
}

impl JarCookie<'_> {
    pub fn matches_host(&self, host: &str) -> bool {
        host == self.domain || (self.include_sub && host.ends_with(&format!(".{}", self.domain)))
    }

    pub fn is_expired(&self, now: i64) -> bool {
        // 0 means "session cookie" in this format, not "expired in 1970".
        self.expiry > 0 && self.expiry <= now
    }

    /// RFC 6265 §5.1.4 path-match. A credential scoped to a subtree the
    /// request never enters would not be sent by a browser, so it must not
    /// count towards "this jar can authenticate" either — otherwise two
    /// same-name cookies on different paths become interchangeable.
    pub fn matches_path(&self, request_path: &str) -> bool {
        let cookie_path = if self.path.is_empty() { "/" } else { self.path };
        if request_path == cookie_path {
            return true;
        }
        if !request_path.starts_with(cookie_path) {
            return false;
        }
        // "/foo" matches "/foo/bar" but not "/foobar"; "/" matches anything.
        cookie_path.ends_with('/') || request_path.as_bytes().get(cookie_path.len()) == Some(&b'/')
    }
}

/// The path every authenticated request this app builds lands on. InnerTube
/// is the only authenticated surface we have — `src/lib/innertube/shared.ts`
/// posts to `https://music.youtube.com/youtubei/v1/<endpoint>` and nothing
/// else sends the jar.
pub const INNERTUBE_PATH: &str = "/youtubei/v1/browse";

pub fn parse_jar(jar: &str) -> impl Iterator<Item = JarCookie<'_>> {
    jar.lines().filter_map(|line| {
        if line.starts_with('#') || line.trim().is_empty() {
            return None;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 7 {
            return None;
        }
        Some(JarCookie {
            domain: f[0].trim_start_matches('.'),
            include_sub: f[1] == "TRUE",
            path: f[2],
            expiry: f[4].parse().unwrap_or(0),
            name: f[5],
            value: f[6],
        })
    })
}

/// Which halves of a usable credential the jar holds for one host.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Credentials {
    /// `LOGIN_INFO` — YouTube's "this browser is signed in" marker.
    pub login_marker: bool,
    /// A cookie the frontend can build a SAPISIDHASH from.
    pub signing_cookie: bool,
    /// Any exact identity-cookie name. Not enough on its own to call the
    /// session usable; it only says the jar is not empty, which separates
    /// "never signed in" from "signed in once and then rotated out".
    pub identity: bool,
}

impl Credentials {
    /// Can this client authenticate a request with this jar?
    ///
    /// The read-side answer, and deliberately weaker than [`complete`].
    /// Requiring `LOGIN_INFO` here would be a false negative the app
    /// cannot recover from: `is_logged_in` would answer an authoritative
    /// "signed out", which gates off the `/account_menu` query that is
    /// the only check able to prove the session live. A false positive
    /// costs one anonymous menu response and corrects itself.
    ///
    /// It is also reachable: the login window commits whatever the
    /// cookie store holds after a few seconds, so a slow YouTube
    /// handshake produces exactly this jar — signable, no `LOGIN_INFO` —
    /// and it authenticated fine before this module existed.
    pub fn signable(&self) -> bool {
        self.signing_cookie
    }

    /// A signing cookie AND YouTube's signed-in marker: the stricter
    /// shape yt-dlp tests for. Used only where waiting for it is free —
    /// the login and keeper captures hold off a few ticks for it, since
    /// a snapshot carrying the whole set replays more like the browser
    /// session Google issued it to.
    pub fn complete(&self) -> bool {
        self.login_marker && self.signing_cookie
    }

    /// Why the answer is "signed out", for the log and the UI. Never
    /// includes a cookie value.
    pub fn missing(&self) -> String {
        if !self.identity {
            return "no identity cookies in the jar".into();
        }
        if !self.signing_cookie {
            return "no signing cookie the client can use".into();
        }
        "LOGIN_INFO is gone (signed out server-side)".into()
    }
}

/// Exact-name identity cookies. Only used to tell an empty jar apart from a
/// logged-out one in the reason string; the can-we-authenticate decision is
/// [`Credentials::signable`].
const IDENTITY_COOKIES: [&str; 9] = [
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "__Secure-1PAPISID",
    "__Secure-3PAPISID",
];

/// Exact-name credential check over the parsed jar, never a substring
/// search of the serialized header. Empty values, expired cookies, and
/// cookies scoped to another host or another path all fail to count, so
/// this answers the same question the request itself would.
pub fn inspect_jar(jar: &str, host: &str, path: &str, now: i64) -> Credentials {
    let mut out = Credentials::default();
    for c in parse_jar(jar) {
        if c.value.is_empty() || c.is_expired(now) || !c.matches_path(path) || !c.matches_host(host)
        {
            continue;
        }
        if c.name == LOGIN_MARKER {
            out.login_marker = true;
        }
        if SIGNING_COOKIES.contains(&c.name) {
            out.signing_cookie = true;
        }
        if IDENTITY_COOKIES.contains(&c.name) {
            out.identity = true;
        }
    }
    out
}

/// Did anything about the cookie set change?
///
/// Evidence that a keeper reload actually reached Google, which nothing
/// else in the refresh can give us: `WebviewWindow::navigate` is
/// fire-and-forget, so offline it returns `Ok` while the page never
/// loads and the persisted WebKit store keeps handing back the cookies
/// it already had. Committing that snapshot would stamp the success
/// deadline and hide a jar that is hours stale — the exact
/// live-versus-replayed divergence Google reads as a stolen cookie.
///
/// Keyed by (domain, path, name), which is how RFC 6265 keys a stored
/// cookie: a rotation that moves a value, adds a cookie or drops one all
/// count.
pub fn jars_differ(a: &str, b: &str) -> bool {
    fn index(jar: &str) -> HashMap<(&str, &str, &str), &str> {
        parse_jar(jar)
            .map(|c| ((c.domain, c.path, c.name), c.value))
            .collect()
    }
    index(a) != index(b)
}

/// Serialize the cookies that apply to `host` + `path` into a `Cookie:`
/// header value. Expired and out-of-scope cookies are dropped for the same
/// reason they do not count in [`inspect_jar`]: a browser would not send
/// them, and letting the header disagree with the predicate is how "signed
/// in, but every request goes out anonymous" happens.
pub fn cookie_header(jar: &str, host: &str, path: &str, now: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in parse_jar(jar) {
        if c.is_expired(now) || !c.matches_path(path) || !c.matches_host(host) {
            continue;
        }
        parts.push(format!("{}={}", c.name, c.value));
    }
    parts.join("; ")
}

// ---------------------------------------------------------------------------
// Tri-state auth answer
// ---------------------------------------------------------------------------

pub const STATE_USABLE: &str = "usable";
pub const STATE_UNKNOWN: &str = "unknown";
pub const STATE_SIGNED_OUT: &str = "signed_out";

/// What we can honestly say about the stored session.
///
/// A boolean cannot hold this. "The login keychain would not open" and
/// "the jar holds no credentials" are different answers, and only the
/// second one may render a sign-in button — on a dark wake the first one
/// used to render it to a perfectly signed-in user.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthStatus {
    /// One of [`STATE_USABLE`], [`STATE_UNKNOWN`], [`STATE_SIGNED_OUT`].
    pub state: &'static str,
    /// Short, value-free explanation for the log and for debugging.
    pub reason: String,
}

impl AuthStatus {
    pub fn usable() -> Self {
        Self {
            state: STATE_USABLE,
            reason: String::new(),
        }
    }

    pub fn unknown(reason: impl Into<String>) -> Self {
        Self {
            state: STATE_UNKNOWN,
            reason: reason.into(),
        }
    }

    pub fn signed_out(reason: impl Into<String>) -> Self {
        Self {
            state: STATE_SIGNED_OUT,
            reason: reason.into(),
        }
    }

    pub fn is_usable(&self) -> bool {
        self.state == STATE_USABLE
    }

    pub fn is_unknown(&self) -> bool {
        self.state == STATE_UNKNOWN
    }
}

/// True when a failure means "the desktop session is not available right
/// now", not "the stored session is gone".
///
/// The measured macOS case is a dark wake: the jar's AES key lives in the
/// login keychain and reading it needs a UI session, so the keyring layer
/// answers `Platform failure: In dark wake, no UI possible`. Counting that
/// as a session failure would advance the retry counter, log a re-login
/// warning, and — worst — let a caller report the user as signed out.
pub fn is_environment_unavailable(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("dark wake")
        || e.contains("no ui possible")
        || e.contains("platform failure")
        || e.contains("credential store is unavailable")
        || e.contains("failed to read key from system credential store")
        // The guard against minting a key that would shadow the one the jar
        // is encrypted with: the old keychain item exists but would not open.
        || e.contains("not minting a replacement")
        // A window that will not build is the same class of problem: no
        // window server, no keeper, and nothing to say about the account.
        || e.contains("build session-keeper")
}

// ---------------------------------------------------------------------------
// Refresh scheduling
// ---------------------------------------------------------------------------

/// Wall-clock seconds between two SUCCESSFUL refreshes. Google leashes
/// *extracted* cookies to roughly two hours; renewing the bound session
/// every 20 minutes stays well inside that.
pub const REFRESH_INTERVAL_SECS: i64 = 20 * 60;

/// Spread applied to the interval so several accounts (and several installs)
/// never reload their keeper on the same second.
pub const REFRESH_JITTER_SECS: i64 = 60;

/// How often the loop wakes to compare the wall clock against the deadline.
/// This, not the wake notification, is what makes the deadline hold across a
/// system sleep: worst case a refresh lands a tick late.
pub const REFRESH_TICK_SECS: u64 = 60;

/// Backoff after a real failure. Capped, and deliberately not aggressive:
/// the dominant failure is "this profile is logged out", which is permanent,
/// and hammering authenticated reloads is the exact pattern that gets a
/// session revoked.
const FAILURE_BACKOFF_SECS: [i64; 4] = [30, 120, 300, 1200];

/// Backoff after the desktop session was unavailable. Shorter than a
/// failure's: nothing was attempted against Google, so retrying costs only a
/// keychain read, and the machine may be awake again within seconds.
const DEFER_BACKOFF_SECS: [i64; 4] = [15, 60, 180, 600];

/// A wake notification carries no field saying whether the wake was
/// user-visible, so it shortens the backoff to this rather than clearing it.
/// If we are still in a dark wake the next attempt just defers again.
const WAKE_SETTLE_SECS: i64 = 10;

/// How old a committed snapshot has to be before a wake is allowed to pull
/// the deadline in.
///
/// A wake overrides the success deadline, but not all the way to zero. A
/// laptop lid opened and closed a dozen times in an hour would otherwise
/// cost a dozen authenticated keeper reloads instead of three, and
/// hammering authenticated reloads is the pattern that gets a session
/// revoked. Below this age there is nothing to renew: the snapshot is
/// newer than the sleep.
pub const WAKE_MIN_AGE_SECS: i64 = 5 * 60;

/// Longest we will ever legitimately wait. Anything further out means the
/// wall clock moved, not that we scheduled it.
const MAX_BACKOFF_SECS: i64 = 1200;

/// Wall-clock second at which the next SUCCESS is due.
///
/// Derived only from the last committed success, never from an attempt. A
/// failed attempt that pushed this out is how a snapshot ages for hours
/// while the loop believes it is on schedule.
pub fn due_at(last_success: Option<i64>, now: i64, interval: i64) -> i64 {
    match last_success {
        None => 0,
        // A stamp from the future means the wall clock moved backward (an
        // NTP correction, a restored backup). Waiting out a deadline that
        // may be days away would let the snapshot rot, so treat it as due
        // and let the next success rewrite the stamp.
        Some(t) if t > now => 0,
        Some(t) => t.saturating_add(interval),
    }
}

/// Same guard for the retry clock: a backoff further out than the longest we
/// schedule can only be a backward clock jump.
pub fn sanitize_next_attempt(next_attempt_at: i64, now: i64) -> i64 {
    if next_attempt_at > now.saturating_add(MAX_BACKOFF_SECS) {
        0
    } else {
        next_attempt_at
    }
}

/// Both clocks have to be satisfied: the success deadline and the retry
/// backoff.
///
/// A wake does not appear here. It moves the `due_at` the caller passes
/// (down to, but never past, [`WAKE_MIN_AGE_SECS`]) instead of bypassing
/// it, so a machine that wakes repeatedly can neither skip the backoff nor
/// force a reload of a snapshot minted a minute ago.
pub fn should_attempt(now: i64, due_at: i64, next_attempt_at: i64) -> bool {
    now >= due_at && now >= sanitize_next_attempt(next_attempt_at, now)
}

/// How long to wait before re-checking, when this pass did NOT attempt.
///
/// Capped at the tick so a wake notification that never arrives still costs
/// at most one tick, and floored at a second so a deadline already in the
/// past cannot spin. The wake settle delay reaches this as a retry clock
/// ten seconds out, which is why a just-woken pass sleeps ten seconds
/// rather than rounding up to the next tick.
pub fn sleep_secs(now: i64, due_at: i64, next_attempt_at: i64) -> u64 {
    let target = due_at.max(sanitize_next_attempt(next_attempt_at, now));
    target
        .saturating_sub(now)
        .clamp(1, REFRESH_TICK_SECS as i64) as u64
}

/// A signed spread of up to `span` seconds either way. `seed` is wall-clock
/// nanoseconds at the call site — this only has to be uncorrelated between
/// installs, not unpredictable.
pub fn jitter(span: i64, seed: i64) -> i64 {
    if span <= 0 {
        return 0;
    }
    seed.rem_euclid(span.saturating_mul(2)) - span
}

fn backoff(table: &[i64], consecutive: u32) -> i64 {
    let i = (consecutive.max(1) as usize - 1).min(table.len() - 1);
    table[i]
}

/// The retry half of the schedule. Lives in memory only: `due_at` is the
/// part that has to survive a restart, and it is persisted as the last
/// success stamp.
#[derive(Debug, Default)]
pub struct RetryState {
    failures: u32,
    defers: u32,
    next_attempt_at: i64,
    forced_due: bool,
}

impl RetryState {
    pub fn next_attempt_at(&self) -> i64 {
        self.next_attempt_at
    }

    pub fn forced_due(&self) -> bool {
        self.forced_due
    }

    /// Called once an attempt actually starts, so a wake cannot keep forcing
    /// attempts after the one it asked for.
    pub fn on_attempt(&mut self) {
        self.forced_due = false;
    }

    /// A wake that found no account to refresh has still been served.
    ///
    /// Something other than an attempt has to clear the flag: signed out,
    /// or on an account with no persisted webview profile, the loop never
    /// reaches [`Self::on_attempt`], so a single lid-open would leave every
    /// later pass permanently "forced".
    pub fn on_nothing_to_refresh(&mut self) {
        self.forced_due = false;
    }

    pub fn on_committed(&mut self) {
        self.failures = 0;
        self.defers = 0;
        self.next_attempt_at = 0;
    }

    pub fn on_failed(&mut self, now: i64, seed: i64) {
        self.failures = self.failures.saturating_add(1);
        let wait = backoff(&FAILURE_BACKOFF_SECS, self.failures);
        self.next_attempt_at = now.saturating_add(wait + jitter(wait / 4, seed));
    }

    /// The jar and the success stamp are untouched by a defer, so `due_at`
    /// does not move and the failure counter does not advance. Only the
    /// retry clock does.
    pub fn on_deferred(&mut self, now: i64, seed: i64) {
        self.defers = self.defers.saturating_add(1);
        let wait = backoff(&DEFER_BACKOFF_SECS, self.defers);
        self.next_attempt_at = now.saturating_add(wait + jitter(wait / 4, seed));
    }

    pub fn on_wake(&mut self, now: i64) {
        self.forced_due = true;
        let settle = now.saturating_add(WAKE_SETTLE_SECS);
        if self.next_attempt_at > settle {
            self.next_attempt_at = settle;
        }
    }
}

// ---------------------------------------------------------------------------
// Wake-from-sleep signal
// ---------------------------------------------------------------------------

/// Wake notification, macOS only.
///
/// This is an optimisation, not the fix: the wall-clock deadline plus the
/// 60-second tick is what actually survives a system sleep. All this buys is
/// noticing a wake immediately instead of up to a tick later.
///
/// `NSWorkspaceDidWakeNotification` carries no field saying whether the wake
/// was user-visible, and Apple does not document that dark wakes are
/// excluded, so it may only mark work DUE. Whether the attempt can run is
/// still decided by the keychain probe in the refresh path — a dark wake
/// defers there and backs off.
///
/// Deliberately not built: Windows `PowerRegisterSuspendResumeNotification`
/// (this fork is macOS-first, and on Windows the tick carries the same
/// correctness, just up to a minute later) and IOKit
/// `IOPMSystemCapabilityChangeParameters` gating, which is the only public
/// API that would actually distinguish a dark wake from a full one.
pub mod wake {
    use std::sync::{Arc, OnceLock};
    use tokio::sync::Notify;

    static SIGNAL: OnceLock<Arc<Notify>> = OnceLock::new();

    /// `notify_one` stores a permit, so a wake that lands while the loop is
    /// mid-refresh is picked up on the next pass rather than lost.
    pub fn signal() -> Arc<Notify> {
        SIGNAL.get_or_init(|| Arc::new(Notify::new())).clone()
    }

    /// Subscribe to the platform wake notification. Call after the identity
    /// migration and the log redirect, and before the refresh task spawns,
    /// so a machine waking during startup is not missed.
    pub fn init() {
        #[cfg(target_os = "macos")]
        imp::subscribe();
    }

    #[cfg(target_os = "macos")]
    mod imp {
        use block2::RcBlock;
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        pub fn subscribe() {
            // NSWorkspace posts on its OWN notification centre, not the
            // default one. Reached through the runtime rather than by
            // pulling in objc2-app-kit for a single selector.
            unsafe {
                let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
                if workspace.is_null() {
                    return;
                }
                let center: *mut AnyObject = msg_send![workspace, notificationCenter];
                if center.is_null() {
                    return;
                }
                let name = NSString::from_str("NSWorkspaceDidWakeNotification");
                // A nil queue delivers on the posting thread; the block only
                // stores a permit, which is safe from any thread.
                let block = RcBlock::new(|_note: *mut AnyObject| {
                    super::signal().notify_one();
                });
                let observer: *mut AnyObject = msg_send![
                    center,
                    addObserverForName: &*name,
                    object: std::ptr::null_mut::<AnyObject>(),
                    queue: std::ptr::null_mut::<AnyObject>(),
                    usingBlock: &*block,
                ];
                if observer.is_null() {
                    return;
                }
                // The centre keeps the observer alive but not the block, and
                // we never unsubscribe, so the block has to outlive the
                // process.
                std::mem::forget(block);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000;
    const HOST: &str = "music.youtube.com";
    const PATH: &str = INNERTUBE_PATH;

    fn line(domain: &str, path: &str, expiry: i64, name: &str, value: &str) -> String {
        format!("{domain}\tTRUE\t{path}\tTRUE\t{expiry}\t{name}\t{value}\n")
    }

    fn signed_in_jar() -> String {
        let mut jar = String::from("# Netscape HTTP Cookie File\n");
        jar.push_str(&line(".youtube.com", "/", 0, "LOGIN_INFO", "abc"));
        jar.push_str(&line(
            ".youtube.com",
            "/",
            1_800_000_000,
            "__Secure-3PAPISID",
            "sign-me",
        ));
        jar
    }

    #[test]
    fn a_rotating_token_is_not_a_session() {
        // The exact defect: __Secure-1PSID is a prefix of both of these, so
        // the old `header.contains("__Secure-1PSID")` reported a live
        // session for a jar that had lost the real credential.
        let mut jar = String::from("# Netscape HTTP Cookie File\n");
        jar.push_str(&line(
            ".youtube.com",
            "/",
            1_800_000_000,
            "__Secure-1PSIDTS",
            "rotating",
        ));
        jar.push_str(&line(
            ".youtube.com",
            "/",
            1_800_000_000,
            "__Secure-1PSIDCC",
            "rotating",
        ));
        jar.push_str(&line(
            ".youtube.com",
            "/",
            1_800_000_000,
            "SIDCC",
            "rotating",
        ));
        let creds = inspect_jar(&jar, HOST, PATH, NOW);
        assert!(!creds.signable());
        assert!(!creds.identity, "no identity cookie is actually present");
    }

    #[test]
    fn a_signing_cookie_and_login_info_together_are_the_full_set() {
        let creds = inspect_jar(&signed_in_jar(), HOST, PATH, NOW);
        assert!(creds.signable() && creds.complete());
    }

    /// The blocker this predicate has to get right in BOTH directions.
    ///
    /// The login window commits whatever the store holds after four grace
    /// ticks, so a slow YouTube handshake really does produce a jar with a
    /// signing cookie and no `LOGIN_INFO`. Every request built from it is
    /// signed correctly, so calling it signed out would put a Sign in
    /// button in front of a user who had just signed in — and, because an
    /// authoritative `false` gates off `/account_menu`, nothing would ever
    /// contradict it.
    #[test]
    fn a_signing_cookie_without_login_info_can_still_authenticate() {
        let jar = line(
            ".youtube.com",
            "/",
            1_800_000_000,
            "__Secure-3PAPISID",
            "sign-me",
        );
        let creds = inspect_jar(&jar, HOST, PATH, NOW);
        assert!(creds.signable(), "the client can sign with this jar");
        assert!(!creds.complete(), "but it is not the full set");
    }

    /// `__Secure-1PAPISID` is a real signing cookie for other YouTube
    /// clients, but ours only knows how to build SAPISIDHASH from
    /// __Secure-3PAPISID / SAPISID. Accepting it would render a profile
    /// while every request went out unsigned.
    #[test]
    fn a_signing_cookie_the_frontend_cannot_use_does_not_count() {
        let mut jar = line(".youtube.com", "/", 0, "LOGIN_INFO", "abc");
        jar.push_str(&line(
            ".youtube.com",
            "/",
            1_800_000_000,
            "__Secure-1PAPISID",
            "unusable",
        ));
        assert!(!inspect_jar(&jar, HOST, PATH, NOW).signable());
    }

    #[test]
    fn an_expired_signing_cookie_does_not_count() {
        let mut jar = line(".youtube.com", "/", 0, "LOGIN_INFO", "abc");
        jar.push_str(&line(
            ".youtube.com",
            "/",
            NOW - 1,
            "__Secure-3PAPISID",
            "stale",
        ));
        assert!(!inspect_jar(&jar, HOST, PATH, NOW).signable());
        // Expiry 0 is a session cookie, not one that expired in 1970.
        let mut live = line(".youtube.com", "/", 0, "LOGIN_INFO", "abc");
        live.push_str(&line(".youtube.com", "/", 0, "__Secure-3PAPISID", "live"));
        assert!(inspect_jar(&live, HOST, PATH, NOW).signable());
    }

    #[test]
    fn path_match_follows_rfc_6265() {
        let c = |path| JarCookie {
            domain: "youtube.com",
            include_sub: true,
            path,
            expiry: 0,
            name: "SAPISID",
            value: "v",
        };
        assert!(c("/").matches_path("/youtubei/v1/browse"));
        assert!(c("").matches_path("/youtubei/v1/browse"), "empty means /");
        assert!(c("/youtubei").matches_path("/youtubei/v1/browse"));
        assert!(c("/youtubei/v1/browse").matches_path("/youtubei/v1/browse"));
        assert!(
            !c("/youtu").matches_path("/youtubei/v1/browse"),
            "prefix, not a segment"
        );
        assert!(!c("/embed").matches_path("/youtubei/v1/browse"));
    }

    #[test]
    fn an_empty_value_does_not_count() {
        let mut jar = line(".youtube.com", "/", 0, "LOGIN_INFO", "abc");
        jar.push_str(&line(".youtube.com", "/", 0, "__Secure-3PAPISID", ""));
        assert!(!inspect_jar(&jar, HOST, PATH, NOW).signable());
    }

    /// RFC 6265 keys a stored cookie by name, domain AND path. Our jar can
    /// hold two same-name cookies on different paths, and only the one that
    /// would actually be sent to /youtubei/v1/ may count.
    #[test]
    fn same_name_cookies_on_different_paths_are_not_interchangeable() {
        let mut jar = line(".youtube.com", "/", 0, "LOGIN_INFO", "abc");
        jar.push_str(&line(
            ".youtube.com",
            "/embed",
            0,
            "__Secure-3PAPISID",
            "scoped-elsewhere",
        ));
        assert!(
            !inspect_jar(&jar, HOST, PATH, NOW).signable(),
            "a cookie scoped to /embed is never sent to /youtubei/v1/"
        );
        assert!(
            !cookie_header(&jar, HOST, PATH, NOW).contains("scoped-elsewhere"),
            "and it must not be serialized into the header either"
        );

        jar.push_str(&line(
            ".youtube.com",
            "/",
            0,
            "__Secure-3PAPISID",
            "site-root",
        ));
        assert!(inspect_jar(&jar, HOST, PATH, NOW).signable());
        let header = cookie_header(&jar, HOST, PATH, NOW);
        assert!(header.contains("__Secure-3PAPISID=site-root"));
    }

    #[test]
    fn cookies_for_another_host_do_not_count() {
        // A google.com-scoped SAPISID is never sent to music.youtube.com,
        // and the frontend signs from the header it gets for that host.
        let mut jar = line(".youtube.com", "/", 0, "LOGIN_INFO", "abc");
        jar.push_str(&line(".google.com", "/", 0, "SAPISID", "google-only"));
        assert!(!inspect_jar(&jar, HOST, PATH, NOW).signable());
        assert!(!cookie_header(&jar, HOST, PATH, NOW).contains("google-only"));
    }

    #[test]
    fn a_cookie_value_that_spells_a_cookie_name_does_not_count() {
        // The old check searched the serialized header, so a value could
        // satisfy it.
        let jar = line(".youtube.com", "/", 0, "PREF", "f6=40000000&SAPISID=x");
        assert!(!inspect_jar(&jar, HOST, PATH, NOW).signable());
    }

    /// The offline-wake case: the keeper's `navigate` never landed, so the
    /// persisted WebKit store hands back exactly what it already had. That
    /// capture renewed nothing and must not stamp the success deadline.
    #[test]
    fn an_unchanged_capture_is_not_a_renewal() {
        let jar = signed_in_jar();
        assert!(!jars_differ(&jar, &jar.clone()));

        // A rotated value counts.
        let rotated = jar.replace("sign-me", "sign-me-2");
        assert!(jars_differ(&jar, &rotated));

        // So does an added cookie, and a dropped one.
        let mut plus = jar.clone();
        plus.push_str(&line(".youtube.com", "/", 0, "SIDCC", "fresh"));
        assert!(jars_differ(&jar, &plus));
        assert!(jars_differ(&plus, &jar));

        // Same names on different paths are different cookies, so moving
        // one is a change even though the name/value pairs are identical.
        let moved = jar.replace(
            "\t/\tTRUE\t1800000000\t__Secure-3PAPISID",
            "\t/embed\tTRUE\t1800000000\t__Secure-3PAPISID",
        );
        assert!(jars_differ(&jar, &moved));
    }

    #[test]
    fn an_empty_jar_says_so() {
        assert_eq!(
            inspect_jar("", HOST, PATH, NOW).missing(),
            "no identity cookies in the jar"
        );
    }

    #[test]
    fn dark_wake_reads_as_an_environment_problem() {
        assert!(is_environment_unavailable(
            "encrypt: failed to read key from system credential store: \
             Platform secure storage failure: In dark wake, no UI possible"
        ));
        assert!(is_environment_unavailable(
            "build session-keeper: failed to create webview"
        ));
        // A logged-out profile is a real failure, not an environment one.
        assert!(!is_environment_unavailable(
            "no auth cookies after reload (profile logged out?)"
        ));
    }

    // --- deadline arithmetic ---

    /// The deadline `run_refresh_loop` actually passes to
    /// [`should_attempt`]: a wake pulls it in, but never below
    /// [`WAKE_MIN_AGE_SECS`].
    fn effective_due(last: Option<i64>, now: i64, forced: bool) -> i64 {
        let due = due_at(last, now, REFRESH_INTERVAL_SECS);
        if forced {
            due.min(due_at(last, now, WAKE_MIN_AGE_SECS))
        } else {
            due
        }
    }

    #[test]
    fn a_long_sleep_leaves_the_refresh_due_immediately() {
        // The measured case: the machine slept through the deadline and the
        // tokio timer never advanced. Wall clock says three hours passed.
        let last = Some(NOW - 3 * 3600);
        let due = due_at(last, NOW, REFRESH_INTERVAL_SECS);
        assert!(due < NOW);
        assert!(should_attempt(NOW, due, 0));
    }

    #[test]
    fn a_backward_clock_jump_marks_the_refresh_due() {
        // Stamp from the future: the wall clock moved back, not forward.
        let due = due_at(Some(NOW + 86_400), NOW, REFRESH_INTERVAL_SECS);
        assert_eq!(due, 0);
        assert!(should_attempt(NOW, due, 0));
        // Same for a retry clock that could otherwise strand the loop.
        assert_eq!(sanitize_next_attempt(NOW + 86_400, NOW), 0);
        assert!(should_attempt(NOW, due, NOW + 86_400));
    }

    #[test]
    fn a_fresh_success_is_not_due_yet() {
        let due = due_at(Some(NOW), NOW, REFRESH_INTERVAL_SECS);
        assert_eq!(due, NOW + REFRESH_INTERVAL_SECS);
        assert!(!should_attempt(NOW, due, 0));
        // Never having succeeded means due now.
        assert!(should_attempt(
            NOW,
            due_at(None, NOW, REFRESH_INTERVAL_SECS),
            0
        ));
    }

    #[test]
    fn a_failure_backs_off_without_moving_the_success_deadline() {
        let last = Some(NOW - REFRESH_INTERVAL_SECS);
        let due_before = due_at(last, NOW, REFRESH_INTERVAL_SECS);
        let mut retry = RetryState::default();
        retry.on_attempt();
        retry.on_failed(NOW, 7);

        // The deadline is derived from the stamp, which a failure never
        // writes, so it cannot drift out.
        assert_eq!(due_at(last, NOW, REFRESH_INTERVAL_SECS), due_before);
        assert!(retry.next_attempt_at() > NOW);
        assert!(!should_attempt(NOW, due_before, retry.next_attempt_at()));

        // Backoff grows, then caps.
        let first = retry.next_attempt_at() - NOW;
        retry.on_failed(NOW, 7);
        assert!(retry.next_attempt_at() - NOW > first);
        for _ in 0..10 {
            retry.on_failed(NOW, 7);
        }
        assert!(retry.next_attempt_at() - NOW <= MAX_BACKOFF_SECS + MAX_BACKOFF_SECS / 4);
    }

    #[test]
    fn a_dark_wake_defer_is_not_a_session_failure() {
        let mut retry = RetryState::default();
        retry.on_deferred(NOW, 3);
        retry.on_deferred(NOW, 3);
        // Short, so a machine that woke a second later is not stranded.
        assert!(retry.next_attempt_at() - NOW <= DEFER_BACKOFF_SECS[1] * 2);

        // And the defers did not advance the FAILURE counter: a real failure
        // after them still gets the first-failure backoff.
        let mut after_failure = RetryState::default();
        after_failure.on_failed(NOW, 3);
        let first = after_failure.next_attempt_at();
        retry.on_failed(NOW, 3);
        assert_eq!(retry.next_attempt_at(), first);
    }

    #[test]
    fn a_success_clears_both_clocks() {
        let mut retry = RetryState::default();
        retry.on_failed(NOW, 1);
        retry.on_deferred(NOW, 1);
        retry.on_committed();
        assert_eq!(retry.next_attempt_at(), 0);
        assert!(should_attempt(NOW, 0, retry.next_attempt_at()));
        // Counters reset too: the next failure gets the first backoff again.
        let mut fresh = RetryState::default();
        fresh.on_failed(NOW, 1);
        retry.on_failed(NOW, 1);
        assert_eq!(retry.next_attempt_at(), fresh.next_attempt_at());
    }

    #[test]
    fn a_wake_shortens_the_backoff_but_does_not_clear_it() {
        let mut retry = RetryState::default();
        retry.on_deferred(NOW, 0);
        for _ in 0..5 {
            retry.on_deferred(NOW, 0);
        }
        let long = retry.next_attempt_at();
        retry.on_wake(NOW);
        assert!(retry.forced_due());
        assert!(retry.next_attempt_at() < long);
        assert!(
            retry.next_attempt_at() > NOW,
            "a wake must not let a dark-wake loop hammer the keychain"
        );
        // The wake overrides the success deadline, not the retry clock. The
        // snapshot here is old enough for the wake to be allowed to force.
        let last = Some(NOW - 2 * WAKE_MIN_AGE_SECS);
        let due = effective_due(last, NOW, true);
        assert!(!should_attempt(NOW, due, retry.next_attempt_at()));
        assert!(should_attempt(
            NOW + WAKE_SETTLE_SECS,
            due,
            retry.next_attempt_at()
        ));
    }

    /// A wake pulls the deadline in, but a lid opened twice in a minute
    /// must not cost two authenticated keeper reloads: below
    /// [`WAKE_MIN_AGE_SECS`] the snapshot is newer than the sleep and there
    /// is nothing to renew.
    #[test]
    fn a_wake_does_not_force_a_reload_of_a_fresh_snapshot() {
        let mut retry = RetryState::default();
        retry.on_committed();
        let last = Some(NOW);

        retry.on_wake(NOW + 48);
        let due = effective_due(last, NOW + 48, retry.forced_due());
        assert!(
            !should_attempt(NOW + 48, due, retry.next_attempt_at()),
            "committed 48 s ago; the wake has nothing to renew"
        );

        // Once the snapshot has some age, the same wake does force it,
        // well before the 20-minute deadline.
        let later = NOW + WAKE_MIN_AGE_SECS + 1;
        let due = effective_due(last, later, retry.forced_due());
        assert!(should_attempt(later, due, retry.next_attempt_at()));
        assert!(
            !should_attempt(later, due_at(last, later, REFRESH_INTERVAL_SECS), 0),
            "and it is genuinely earlier than the normal deadline"
        );
    }

    #[test]
    fn a_holding_pass_sleeps_only_until_it_could_act() {
        // Idle: nothing due for the rest of the interval, so wait a tick.
        let due = due_at(Some(NOW), NOW, REFRESH_INTERVAL_SECS);
        assert_eq!(sleep_secs(NOW, due, 0), REFRESH_TICK_SECS);

        // Just woken from an hour's sleep: the settle delay is real
        // seconds, not "some time in the next tick", or the notification
        // would buy nothing over the tick alone.
        let mut retry = RetryState::default();
        retry.on_deferred(NOW, 0);
        retry.on_wake(NOW);
        let woken_due = effective_due(Some(NOW - 3600), NOW, true);
        let delay = sleep_secs(NOW, woken_due, retry.next_attempt_at());
        assert!(delay <= WAKE_SETTLE_SECS as u64, "slept {delay}s");
        assert!(delay >= 1);

        // A deadline already in the past must not spin.
        assert_eq!(sleep_secs(NOW, NOW - 5000, 0), 1);
    }

    /// The regression that turned one lid-open into a permanent 1 Hz loop.
    ///
    /// Signed out (or on an account with no persisted profile) the loop
    /// never reaches an attempt, so nothing consumed `forced_due` and the
    /// old `sleep_secs` targeted a retry clock that was still zero: every
    /// pass slept one second and re-read `accounts.json` for the life of
    /// the process.
    #[test]
    fn a_wake_with_nothing_to_refresh_does_not_spin() {
        let mut retry = RetryState::default();
        retry.on_wake(NOW);
        // What the loop passes when there is no account to refresh: a
        // placeholder deadline one tick out and an untouched retry clock.
        let placeholder = NOW + REFRESH_TICK_SECS as i64;
        assert_eq!(sleep_secs(NOW, placeholder, retry.next_attempt_at()), 60);

        retry.on_nothing_to_refresh();
        assert!(!retry.forced_due(), "a served wake must not stay pending");
        assert_eq!(sleep_secs(NOW, placeholder, retry.next_attempt_at()), 60);
    }

    #[test]
    fn an_attempt_consumes_the_forced_flag() {
        let mut retry = RetryState::default();
        retry.on_wake(NOW);
        assert!(retry.forced_due());
        retry.on_attempt();
        assert!(!retry.forced_due());
    }

    /// Not a behavioural test — a wake cannot be provoked from here. It
    /// proves the runtime plumbing: that NSWorkspace and the four-part
    /// selector resolve and that the block encoding is accepted, which is
    /// the part that would otherwise only fail on a user's machine, hours
    /// after a sleep, in silence.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_wake_subscription_registers() {
        wake::init();
        // Idempotent enough to be called twice without tearing anything.
        wake::init();
        // The signal is process-wide, so two calls hand back the same one.
        assert!(std::sync::Arc::ptr_eq(&wake::signal(), &wake::signal()));
    }

    #[test]
    fn jitter_stays_inside_its_span() {
        for seed in [0_i64, 1, 999, -7, i64::MAX / 2] {
            let j = jitter(60, seed);
            assert!((-60..=60).contains(&j), "seed {seed} gave {j}");
        }
        assert_eq!(jitter(0, 12345), 0);
    }
}
