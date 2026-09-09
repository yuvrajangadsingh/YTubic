import { describe, expect, it } from "vitest";
import { nextSelectionLine } from "./sources";

const EMPTY = { videoId: "", shown: null };
const at = (videoId: string, shown: string, settled = true) => ({
  videoId,
  shown,
  settled,
});

/**
 * The panel's source changes under the user twice over: when a slower,
 * higher-priority provider lands and displaces the words already on
 * screen, and when the user pins a source by hand. Both belong in the
 * log, and neither may be written twice.
 */
describe("nextSelectionLine", () => {
  it("says nothing while the race is still running", () => {
    expect(nextSelectionLine(EMPTY, at("aaa", "", false)).event).toBeNull();
  });

  it("announces the first pick", () => {
    expect(nextSelectionLine(EMPTY, at("aaa", "lrclib timed")).event).toBe(
      "first",
    );
  });

  it("announces a displacement as a switch", () => {
    const first = nextSelectionLine(EMPTY, at("aaa", "lrclib timed"));
    expect(
      nextSelectionLine(first.state, at("aaa", "ytmusic timed")).event,
    ).toBe("switch");
  });

  it("does not repeat an unchanged pick", () => {
    const first = nextSelectionLine(EMPTY, at("aaa", "ytmusic timed"));
    expect(
      nextSelectionLine(first.state, at("aaa", "ytmusic timed")).event,
    ).toBeNull();
  });

  it("reports an empty result only once every source has answered", () => {
    const pending = nextSelectionLine(EMPTY, at("aaa", "", false));
    expect(pending.event).toBeNull();
    const done = nextSelectionLine(pending.state, at("aaa", ""));
    expect(done.event).toBe("none");
    expect(nextSelectionLine(done.state, at("aaa", "")).event).toBeNull();
  });

  it("announces a source that lands after the empty result", () => {
    const empty = nextSelectionLine(EMPTY, at("aaa", ""));
    expect(
      nextSelectionLine(empty.state, at("aaa", "genius plain")).event,
    ).toBe("switch");
  });

  // Leaving a track before anything answered used to carry the previous
  // track's pick forward, and a cached hit on the way back matched it and
  // was swallowed.
  it("announces a cached pick after a silent detour to another track", () => {
    const first = nextSelectionLine(EMPTY, at("aaa", "ytmusic timed"));
    const detour = nextSelectionLine(first.state, at("bbb", "", false));
    expect(detour.event).toBeNull();
    expect(
      nextSelectionLine(detour.state, at("aaa", "ytmusic timed")).event,
    ).toBe("first");
  });

  it("announces the user pinning a different source", () => {
    const auto = nextSelectionLine(EMPTY, at("aaa", "ytmusic timed"));
    expect(nextSelectionLine(auto.state, at("aaa", "genius plain")).event).toBe(
      "switch",
    );
  });

  // A pinned source with no words is not the same event as no provider
  // having the track, so the two must not share a key.
  it("keeps a pinned source's miss apart from nobody having it", () => {
    const auto = nextSelectionLine(EMPTY, at("aaa", "ytmusic timed"));
    const pinnedMiss = nextSelectionLine(auto.state, at("aaa", "genius none"));
    expect(pinnedMiss.event).toBe("switch");
    expect(nextSelectionLine(pinnedMiss.state, at("aaa", "")).event).toBe(
      "none",
    );
  });

  it("keeps ids apart when one is a prefix of another", () => {
    const first = nextSelectionLine(EMPTY, at("aaa", "ytmusic timed"));
    expect(
      nextSelectionLine(first.state, at("aaab", "ytmusic timed")).event,
    ).toBe("first");
  });
});
