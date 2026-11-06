import { beforeEach, describe, expect, it, vi } from "vitest";

const setPlaying = vi.fn();
vi.mock("@/lib/store/playback", () => ({
  usePlaybackStore: { getState: () => ({ setPlaying }) },
}));

const { pauseIfSleepingAfterTrack, useSleepTimer } =
  await import("./sleep-timer");

describe("pauseIfSleepingAfterTrack", () => {
  beforeEach(() => {
    setPlaying.mockClear();
    useSleepTimer.getState().clear();
  });

  it("pauses once and disarms when end of track is set", () => {
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
    pauseIfSleepingAfterTrack();
    expect(setPlaying).not.toHaveBeenCalled();
    expect(useSleepTimer.getState().endsAt).not.toBeNull();
  });
});
