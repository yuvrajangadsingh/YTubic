import { describe, expect, it } from "vitest";

// The module builds its store at import time and touches IndexedDB /
// Tauri event plumbing on the way. Present ourselves as the floating
// window so construction skips the persist wiring, same trick as
// playback.test.ts. The functions under test are pure.
(globalThis as unknown as { window: unknown }).window = {
  location: { search: "?floating-player" },
};

const { resolveStreamId, wantsVideoStream } =
  await import("@/lib/store/track-source");
type Sources = Parameters<typeof wantsVideoStream>[1];

const paired = (over: Partial<Sources[string]> = {}): Sources => ({
  s1: { song: "s1", video: "v1", selected: "video", ...over },
});

describe("wantsVideoStream", () => {
  it("is false with no record at all", () => {
    expect(wantsVideoStream("s1", {}, true)).toBe(false);
  });

  describe("an explicit choice wins over the global mode", () => {
    it("streams video for a chosen video track even with sticky mode off", () => {
      const by = paired({ chosen: true });
      expect(wantsVideoStream("s1", by, false)).toBe(true);
    });

    it("stays audio for a track the user explicitly put back to song", () => {
      const by = paired({ selected: "song", chosen: true });
      expect(wantsVideoStream("s1", by, true)).toBe(false);
    });
  });

  describe("sticky mode, no explicit choice yet", () => {
    it("streams video once the counterpart is known", () => {
      // The case that was flashing the artwork on every track change:
      // the record already resolved to the video id, only `chosen` was
      // pending on PlayerBar's effect a tick later.
      expect(wantsVideoStream("s1", paired(), true)).toBe(true);
    });

    it("waits while the counterpart still has to be hunted", () => {
      const by: Sources = { s1: { song: "s1", selected: "video" } };
      expect(wantsVideoStream("s1", by, true)).toBe(false);
    });

    it("does not claim video for a seeded record still on song", () => {
      // resolveStreamId would hand back the SONG id here, so wanting
      // video would ask for a video-only track of the audio file.
      const by = paired({ selected: "song" });
      expect(wantsVideoStream("s1", by, true)).toBe(false);
      expect(resolveStreamId("s1", by)).toBe("s1");
    });

    it("is false when sticky mode is off", () => {
      expect(wantsVideoStream("s1", paired(), false)).toBe(false);
    });

    it("defaults to sticky mode off when the argument is omitted", () => {
      expect(wantsVideoStream("s1", paired())).toBe(false);
    });
  });

  it("agrees with resolveStreamId whenever it wants video", () => {
    // The invariant that keeps the two in step: if this returns true the
    // resolved id must be the video counterpart, or the companion asks
    // for a video track of the wrong file.
    const cases: Sources[] = [paired(), paired({ chosen: true })];
    for (const by of cases) {
      expect(wantsVideoStream("s1", by, true)).toBe(true);
      expect(resolveStreamId("s1", by)).toBe("v1");
    }
  });
});
