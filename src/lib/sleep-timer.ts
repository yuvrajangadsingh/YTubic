import { useEffect } from "react";
import { create } from "zustand";
import { useCastStore } from "@/lib/store/cast";
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
  if (takeEndOfTrack()) usePlaybackStore.getState().setPlaying(false);
}

/** The engine's own advance, for a track that ran out or a long outro it
 *  skips. While casting, "end of track" stops on the receiver's current
 *  track instead: a LOAD there would start the next one playing. */
export function advanceAfterTrack(): void {
  const pb = usePlaybackStore.getState();
  if (useCastStore.getState().deviceId !== null && takeEndOfTrack()) {
    if (pb.playing) pb.toggle();
    return;
  }
  pb.next();
  pauseIfSleepingAfterTrack();
}

/** Disarm "end of track" if it is set, and say whether it was. Casting
 *  uses this as is: a LOAD on the receiver always starts playing, so there
 *  the queue stays on the finished track instead of moving on. */
export function takeEndOfTrack(): boolean {
  const timer = useSleepTimer.getState();
  if (!timer.afterTrack) return false;
  timer.clear();
  return true;
}

/** Wall-clock check, not one long timeout: WebKit's timers stop while the
 *  Mac sleeps, which would push the pause past the deadline after a wake. */
const CHECK_MS = 15_000;

/** Pause once the wall clock passes `endsAt`; returns the cleanup. */
export function watchDeadline(endsAt: number): () => void {
  const check = () => {
    if (Date.now() < endsAt) return;
    useSleepTimer.getState().clear();
    // toggle, not setPlaying: while casting it pauses the receiver.
    const pb = usePlaybackStore.getState();
    if (pb.playing) pb.toggle();
  };
  const t = window.setInterval(check, CHECK_MS);
  return () => window.clearInterval(t);
}

export function useSleepTimerEngine(): void {
  const endsAt = useSleepTimer((s) => s.endsAt);
  useEffect(() => {
    if (endsAt !== null) return watchDeadline(endsAt);
  }, [endsAt]);
}
