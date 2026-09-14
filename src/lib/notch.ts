import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_MAC } from "@/lib/platform";
import { useSettingsStore } from "@/lib/store/settings";

/** Turn the song-change peek on or off in Rust (`src-tauri/src/notch.rs`). */
export function pushNotchEnabled(enabled: boolean): void {
  invoke("notch_set_enabled", { enabled }).catch(() => {
    /* plain-vite dev without a Tauri backend, nothing to sync */
  });
}

/**
 * Mirror the persisted peek setting into Rust: once after launch, then on
 * every change. The songs themselves reach Rust through the media bridge
 * in `audio-engine.ts`, so this is the only wiring the peek needs.
 */
export function useNotchPeek(): void {
  const enabled = useSettingsStore((s) => s.notchSongPeek);
  useEffect(() => {
    if (!IS_MAC) return;
    pushNotchEnabled(enabled);
  }, [enabled]);
}
