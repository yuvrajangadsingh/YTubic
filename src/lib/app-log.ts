import { invoke } from "@tauri-apps/api/core";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * One line into the app's own log (`ytubic.log`, prefixed `[web]`),
 * next to the stream server's lines and on the same clock. Fire and
 * forget: a failed invoke must never become a playback error. Outside
 * Tauri (plain-vite dev in a browser) it goes to the console instead.
 */
export function appLog(line: string): void {
  if (!IS_TAURI) {
    if (import.meta.env.DEV) console.log("[web]", line);
    return;
  }
  void invoke("frontend_log", { line }).catch(() => {});
}

/** The media element facts every stall question comes down to. */
export function mediaState(el: HTMLMediaElement): string {
  return (
    `vis=${document.visibilityState} rs=${el.readyState} ns=${el.networkState} ` +
    `paused=${el.paused} t=${el.currentTime.toFixed(1)}`
  );
}
