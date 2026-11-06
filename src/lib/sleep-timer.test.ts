import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setPlaying = vi.fn();
const toggle = vi.fn();
let playing = true;
vi.mock("@/lib/store/playback", () => ({
  usePlaybackStore: { getState: () => ({ setPlaying, toggle, playing }) },
}));

const {
  pauseIfSleepingAfterTrack,
  takeEndOfTrack,
  useSleepTimer,
  watchDeadline,
} = await import("./sleep-timer");

beforeEach(() => {
  setPlaying.mockClear();
  toggle.mockClear();
  playing = true;
  useSleepTimer.getState().clear();
});

describe("end of track", () => {
  it("pauses once and disarms", () => {
    useSleepTimer.getState().setAfterTrack();
    pauseIfSleepingAfterTrack();
    expect(setPlaying).toHaveBeenCalledWith(false);
    expect(useSleepTimer.getState().afterTrack).toBe(false);
    pauseIfSleepingAfterTrack();
    expect(setPlaying).toHaveBeenCalledTimes(1);
  });

  it("leaves playback alone otherwise, a minutes timer included", () => {
    pauseIfSleepingAfterTrack();
    useSleepTimer.getState().setMinutes(15);
    expect(takeEndOfTrack()).toBe(false);
    pauseIfSleepingAfterTrack();
    expect(setPlaying).not.toHaveBeenCalled();
    expect(useSleepTimer.getState().endsAt).not.toBeNull();
  });
});

describe("minutes", () => {
  afterEach(() => vi.useRealTimers());

  it("pauses through toggle once the wall clock passes the deadline", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    useSleepTimer.getState().setMinutes(1);
    const stop = watchDeadline(useSleepTimer.getState().endsAt!);
    vi.advanceTimersByTime(45_000);
    expect(toggle).not.toHaveBeenCalled();
    // A Mac sleep: the clock jumps, the interval only fires once after it.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    vi.advanceTimersByTime(15_000);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(useSleepTimer.getState().endsAt).toBeNull();
    stop();
  });
});
