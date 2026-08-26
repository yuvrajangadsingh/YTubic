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
//! The fix is to stop AppKit reporting occlusion at all, so the webview
//! never learns it is hidden and its media session stays permitted.

#[cfg(target_os = "macos")]
pub use imp::set_active;

#[cfg(not(target_os = "macos"))]
pub fn set_active(_active: bool) {}

#[cfg(target_os = "macos")]
pub use occlusion::keep_webview_visible;

#[cfg(not(target_os = "macos"))]
pub fn keep_webview_visible() {}

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

#[cfg(target_os = "macos")]
mod occlusion {
    use objc2::runtime::AnyClass;
    use objc2::{msg_send, sel};

    /// Stop AppKit reporting window occlusion, so WKWebView keeps
    /// treating its page as visible on another Space and WebKit's media
    /// session keeps permitting playback to start.
    ///
    /// `_setWindowOcclusionDetectionEnabled:` is private, so this is
    /// guarded on `respondsToSelector:` and is a silent no-op if a
    /// future macOS drops it — playback then behaves exactly as it does
    /// today rather than crashing.
    ///
    /// The cost is real: occlusion detection is also what lets AppKit
    /// stop drawing fully hidden windows. For a player whose job is to
    /// keep working in the background that is the right trade, but it
    /// is a trade.
    pub fn keep_webview_visible() {
        let Some(cls) = AnyClass::get(c"NSApplication") else {
            return;
        };
        unsafe {
            let app: *mut objc2::runtime::AnyObject = msg_send![cls, sharedApplication];
            if app.is_null() {
                return;
            }
            let sel = sel!(_setWindowOcclusionDetectionEnabled:);
            let responds: bool = msg_send![app, respondsToSelector: sel];
            if !responds {
                eprintln!("[occlusion] _setWindowOcclusionDetectionEnabled: unavailable");
                return;
            }
            let _: () = msg_send![app, _setWindowOcclusionDetectionEnabled: false];
            eprintln!("[occlusion] window occlusion detection disabled");
        }
    }
}
