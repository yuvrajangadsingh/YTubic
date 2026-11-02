import { focusManager } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Drive TanStack's focus refetch from the Tauri window instead of the
 * document.
 *
 * Out of the box the focus manager listens to `visibilitychange` only,
 * and in this app the document almost never goes hidden: occlusion
 * detection is off for the main window (the desktop-switch stall fix), so
 * the page stays "visible" while the user is in another app all day. The
 * log since the Sep 10 2026 launch has zero visibility events across
 * eight hours. Without this, every `refetchOnWindowFocus` in the app,
 * the auth queries' included, waits for an event that does not come.
 *
 * Only a focus GAIN is forwarded, and without a value. Passing `false`
 * on blur would make the manager report the window as unfocused, and
 * the retryer waits for focus before it continues a retry, so a check
 * that failed once while the user was in another app would sit paused
 * until they came back. Left unset, `isFocused()` keeps reading document
 * visibility, which is what every retry saw before this change.
 *
 * Idempotent: the manager keeps one listener, and the previous one is
 * torn down when a new setup replaces it.
 */
export function wireQueryFocusToWindow(): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }
  focusManager.setEventListener((setFocused) => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) setFocused();
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        // No window event means no focus refetch, which is exactly
        // today's behaviour. Nothing else depends on this.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  });
}
