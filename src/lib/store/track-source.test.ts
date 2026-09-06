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

/** A song row that knows its music-video counterpart. */
const pair = (over: Partial<Sources[string]> = {}): Sources => ({
  s1: { song: "s1", video: "v1", selected: "song", ...over },
});

/** A row queued AS a video: both sides are its own id. */
const videoNative: Sources = {
  vn: { song: "vn", video: "vn", selected: "video" },
};

describe("wantsVideoStream", () => {
  it("is false with no record", () => {
    expect(wantsVideoStream("s1", {}, true)).toBe(false);
  });

  describe("an explicit choice wins over the mode", () => {
    it("streams video for a chosen track with the mode off", () => {
      expect(
        wantsVideoStream(
          "s1",
          pair({ selected: "video", chosen: true }),
          false,
        ),
      ).toBe(true);
    });
    it("stays audio for a track explicitly put back to song", () => {
      expect(wantsVideoStream("s1", pair({ chosen: true }), true)).toBe(false);
    });
  });

  describe("sticky mode, no explicit choice", () => {
    it("streams video once the counterpart is known", () => {
      expect(wantsVideoStream("s1", pair(), true)).toBe(true);
    });
    it("waits while the counterpart is still unknown", () => {
      expect(
        wantsVideoStream("s1", { s1: { song: "s1", selected: "song" } }, true),
      ).toBe(false);
    });
    it("is false with the mode off", () => {
      expect(wantsVideoStream("s1", pair(), false)).toBe(false);
    });
    it("defaults the mode to off", () => {
      expect(wantsVideoStream("s1", pair())).toBe(false);
    });
  });
});

describe("resolveStreamId agrees with wantsVideoStream", () => {
  // The regression this pins: sticky mode used to be written into
  // `selected`, so turning the mode off left resolveStreamId handing back
  // the video id while wantsVideoStream said audio. The master then
  // played the music video's audio track under a UI reading Song, and
  // the toggle could not get back because it already showed Song.
  it("hands back the song id for an unchosen pair with the mode off", () => {
    const by = pair();
    expect(wantsVideoStream("s1", by, false)).toBe(false);
    expect(resolveStreamId("s1", by, false)).toBe("s1");
  });

  it("hands back the video id for an unchosen pair with the mode on", () => {
    const by = pair();
    expect(wantsVideoStream("s1", by, true)).toBe(true);
    expect(resolveStreamId("s1", by, true)).toBe("v1");
  });

  it("does not redirect a song row to the video file with the mode off", () => {
    // One record is aliased under BOTH ids, so a song row can read
    // `selected: "video"` with `video` naming the other file. The repro:
    // turn video on for A, let B pair up, turn video off, advance to B,
    // and B played the video cut's audio under a UI reading Song.
    const by = pair({ selected: "video" });
    expect(wantsVideoStream("s1", by, false)).toBe(false);
    expect(resolveStreamId("s1", by, false)).toBe("s1");
  });

  it("never returns a DIFFERENT id than the row while claiming audio", () => {
    // Redirecting to a file that is not this row's own is only allowed
    // when video is genuinely what we asked for.
    const cases: Array<[Sources, boolean]> = [
      [pair(), false],
      [pair(), true],
      [pair({ selected: "video" }), false],
      [pair({ selected: "video" }), true],
      [pair({ selected: "video", chosen: true }), false],
      [pair({ chosen: true }), true],
      [{ s1: { song: "s1", selected: "song" } }, true],
    ];
    for (const [by, mode] of cases) {
      const id = resolveStreamId("s1", by, mode);
      if (id !== "s1") expect(wantsVideoStream("s1", by, mode)).toBe(true);
    }
  });

  it("keeps a video-native row on its own id with the mode off", () => {
    // `selected: "video"` here is the row's identity, not a mode: both
    // sides are the same id, so this must not be dragged back to a song.
    expect(resolveStreamId("vn", videoNative, false)).toBe("vn");
    expect(resolveStreamId("vn", videoNative, true)).toBe("vn");
  });

  it("passes an unknown id straight through", () => {
    expect(resolveStreamId("nope", {}, true)).toBe("nope");
  });
});
