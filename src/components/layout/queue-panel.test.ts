import { describe, expect, it } from "vitest";

(globalThis as unknown as { window: unknown }).window = {
  location: { search: "?floating-player" },
};
const { usePlaybackStore } = await import("@/lib/store/playback");

const t = (videoId: string) => ({ videoId, title: videoId, thumbnails: [] });

describe("play next", () => {
  // What the Up next row button does. History rows don't get it: moving a
  // row from before the current track shifts the current index, and the
  // engine reloads a track whose slot changed, restarting it.
  it("moves a later row to right after the current track, which stays put", () => {
    usePlaybackStore.setState({
      queue: ["a", "b", "c", "d"].map(t),
      index: 1,
    });
    const { index, moveTrack } = usePlaybackStore.getState();
    moveTrack(3, index + 1);
    const s = usePlaybackStore.getState();
    expect(s.queue.map((x) => x.videoId)).toEqual(["a", "b", "d", "c"]);
    expect(s.index).toBe(1);
  });
});
