import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setPlaying = vi.fn();
const toggle = vi.fn();
let playing = true;
const next = vi.fn();
let deviceId: string | null = null;
vi.mock("@/lib/store/playback", () => ({
  usePlaybackStore: {
    getState: () => ({ setPlaying, toggle, next, playing }),
  },
}));
vi.mock("@/lib/store/cast", () => ({
  useCastStore: { getState: () => ({ deviceId }) },
}));

const {
  advanceAfterTrack,
  pauseIfSleepingAfterTrack,
  takeEndOfTrack,
  useSleepTimer,
  watchDeadline,
} = await import("./sleep-timer");

beforeEach(() => {
  setPlaying.mockClear();
  toggle.mockClear();
  next.mockClear();
  deviceId = null;
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

describe("advanceAfterTrack", () => {
  it("moves on, then pauses there when end of track is set", () => {
    useSleepTimer.getState().setAfterTrack();
    advanceAfterTrack();
    expect(next).toHaveBeenCalledTimes(1);
    expect(setPlaying).toHaveBeenCalledWith(false);
  });

  it("while casting, pauses the receiver on this track instead", () => {
    deviceId = "tv";
    useSleepTimer.getState().setAfterTrack();
    advanceAfterTrack();
    expect(next).not.toHaveBeenCalled();
    expect(toggle).toHaveBeenCalledTimes(1);
    advanceAfterTrack();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
