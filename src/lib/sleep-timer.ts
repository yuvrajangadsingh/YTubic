import { useEffect } from "react";
import { create } from "zustand";
import { usePlaybackStore } from "@/lib/store/playback";

/** Pause playback after a set time or at the end of the current track.
 *  Not persisted: a restart ends the timer, and nothing autoplays then
 *  anyway. Runs in the main window, where the audio engine is. */
type SleepTimer = {
  /** Unix ms to pause at, or null. */
  endsAt: number | null;
  afterTrack: boolean;
  setMinutes: (minutes: number) => void;
  setAfterTrack: () => void;
  clear: () => void;
};

export const useSleepTimer = create<SleepTimer>()((set) => ({
  endsAt: null,
  afterTrack: false,
  setMinutes: (minutes) =>
    set({ endsAt: Date.now() + minutes * 60_000, afterTrack: false }),
  setAfterTrack: () => set({ endsAt: null, afterTrack: true }),
  clear: () => set({ endsAt: null, afterTrack: false }),
}));

/** Called by the audio engine right after it moves on because a track
 *  ran out (end of file, a skipped long outro). With "end of track" armed
 *  it pauses there, on the next track, and disarms. A skip by hand never
 *  comes through here, so it keeps the timer armed for the new track. */
export function pauseIfSleepingAfterTrack(): void {
  const timer = useSleepTimer.getState();
  if (!timer.afterTrack) return;
  usePlaybackStore.getState().setPlaying(false);
  timer.clear();
}

export function useSleepTimerEngine(): void {
  const endsAt = useSleepTimer((s) => s.endsAt);

  useEffect(() => {
    if (endsAt === null) return;
    const t = window.setTimeout(
      () => {
        usePlaybackStore.getState().setPlaying(false);
        useSleepTimer.getState().clear();
      },
      Math.max(0, endsAt - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [endsAt]);
}
