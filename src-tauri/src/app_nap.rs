//! Keeping playback alive while the window is not visible.
//!
//! Two separate macOS mechanisms stop a hidden music player, and only
//! the second one turned out to matter here.
//!
//! ## App Nap (`set_active`)
//!
//! Throttles a process whose windows are occluded and which is emitting
//! no audio. Plausible, cheap to hold off, and it did NOT fix the bug:
//! the symptom survived it untouched. Kept because the assertion is
//! correct on its own terms, not because it solves anything observed.
//!
//! ## Window occlusion (`keep_webview_visible`) — the actual cause
//!
//! When a window moves to another Space, AppKit marks it occluded and
//! WKWebView drops its page to "not visible". WebKit then refuses to
//! *begin* media playback on a non-visible page. Audio already playing
//! keeps going (permission was granted while visible); a track that has
//! not started yet stays silent until you come back.
//!
//! Verified 2026-08-26. The webview was demonstrably alive while hidden
//! (it fetched the whole 5MB file through the local server) and the
//! player still showed 0:01 the instant the window came into view, so
//! nothing had played in the background. Not scheduling, not App Nap,
//! and not `inactiveSchedulingPolicy` either — that is set to
//! `disabled` in tauri.conf.json and the symptom survived it.
//!
//! NO FIX FOUND. Four theories tried and all dead:
//!
//!   1. App Nap (this module's `set_active`) - wrong layer, no effect.
//!   2. Throttled timers - there is no timer in the audio start path at
//!      all; it is a promise microtask.
//!   3. `inactiveSchedulingPolicy` - set to `disabled` in
//!      tauri.conf.json, correctly plumbed through tauri-runtime and
//!      wry, symptom survived.
//!   4. Disabling AppKit occlusion detection via
//!      `_setWindowOcclusionDetectionEnabled:` - the selector no longer
//!      exists (macOS 26.6 NSApplication exposes only the read-only
//!      `occlusionState`). Verified by respondsToSelector at runtime and
//!      by introspection; the code was removed rather than left looking
//!      like a fix.
//!
//! Untried idea, recorded so it is not re-derived from scratch: keep a
//! silent audio element or AudioContext alive so the page always counts
//! as media-playing, on the theory that WebKit's restriction is on
//! STARTING playback rather than continuing it. Hacky, may fight the
//! Now Playing integration, unproven.

#[cfg(target_os = "macos")]
pub use imp::set_active;

#[cfg(not(target_os = "macos"))]
pub fn set_active(_active: bool) {}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// The token `beginActivityWithOptions:reason:` hands back, held
    /// for as long as the activity should stay in effect.
    struct Token(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    // SAFETY: the token is an opaque handle we never message directly —
    // it is only stored here and later handed back to `endActivity:`.
    // NSProcessInfo's activity API is documented thread-safe, so which
    // thread holds or ends the token doesn't matter.
    unsafe impl Send for Token {}

    static ACTIVITY: Mutex<Option<Token>> = Mutex::new(None);

    pub fn set_active(active: bool) {
        let mut slot = ACTIVITY.lock().unwrap();
        if active {
            // Idempotent: the frontend re-sends on every state change.
            if slot.is_some() {
                return;
            }
            let info = NSProcessInfo::processInfo();
            let token = info.beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &NSString::from_str("audio playback / track loading"),
            );
            *slot = Some(Token(token));
        } else if let Some(token) = slot.take() {
            let info = NSProcessInfo::processInfo();
            // SAFETY: `token.0` came from beginActivityWithOptions on
            // this same process-info object and is ended exactly once
            // (`take()` above empties the slot).
            unsafe { info.endActivity(&token.0) };
        }
    }
}
