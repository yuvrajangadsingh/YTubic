//! Keep the process out of App Nap while playback is wanted.
//!
//! App Nap throttles a process whose windows are fully occluded (other
//! Space, minimized, fullscreen elsewhere) and which is emitting no
//! audio. Mid-song that never triggers — audible audio counts as
//! activity — but in the silent gap between tracks, while the next
//! stream is still downloading, a hidden window meets both conditions.
//! The JS completion path ("download done → el.play()") then runs at
//! nap cadence and playback sits stalled until the window becomes
//! visible again. Symptom: switch desktops during a track change and
//! the next song only starts when you switch back.
//!
//! The frontend flips this on while a track is loading or playing and
//! off when idle/paused, so an open-but-silent YTubic still naps like
//! any other background app.
//!
//! `UserInitiatedAllowingIdleSystemSleep` blocks App Nap and timer
//! throttling but deliberately does NOT hold the machine awake — while
//! audio is audible coreaudiod already asserts that, and a loading gap
//! shouldn't stop the system from sleeping on a lid-closed laptop.

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
