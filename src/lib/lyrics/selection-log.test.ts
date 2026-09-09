import { describe, expect, it } from "vitest";
import { nextSelectionLine } from "./sources";

const EMPTY = { videoId: "", shown: null };

/**
 * The panel's source can change under the user twice over: once when a
 * slower, higher-priority provider lands and displaces the words already on
 * screen, and again when the user pins a source by hand. Both have to show
 * up in the log, and neither may be written twice.
 */
describe("nextSelectionLine", () => {
  it("says nothing while the race is still running", () => {
    const r = nextSelectionLine(EMPTY, {
      videoId: "aaa",
      shown: "",
      settled: false,
    });
    expect(r.line).toBeNull();
  });

  it("logs the first pick", () => {
    const r = nextSelectionLine(EMPTY, {
      videoId: "aaa",
      shown: "lrclib timed",
      settled: false,
    });
    expect(r.line).toBe("[lyrics] showing lrclib timed for aaa");
  });

  it("logs a displacement as a switch", () => {
    const first = nextSelectionLine(EMPTY, {
      videoId: "aaa",
      shown: "lrclib timed",
      settled: false,
    });
    const second = nextSelectionLine(first.state, {
      videoId: "aaa",
      shown: "ytmusic timed",
      settled: true,
    });
    expect(second.line).toBe("[lyrics] switched to ytmusic timed for aaa");
  });

  it("does not repeat an unchanged pick", () => {
    const first = nextSelectionLine(EMPTY, {
      videoId: "aaa",
      shown: "ytmusic timed",
      settled: true,
    });
    const again = nextSelectionLine(first.state, {
      videoId: "aaa",
      shown: "ytmusic timed",
      settled: true,
    });
    expect(again.line).toBeNull();
  });

  it("reports an empty result only once every source has answered", () => {
    const pending = nextSelectionLine(EMPTY, {
      videoId: "aaa",
      shown: "",
      settled: false,
    });
    expect(pending.line).toBeNull();
    const done = nextSelectionLine(pending.state, {
      videoId: "aaa",
      shown: "",
      settled: true,
    });
    expect(done.line).toBe("[lyrics] no source had aaa");
  });

  // Leaving a track before anything answered used to carry the previous
  // track's pick forward, and a cached hit on the way back matched it and
  // was swallowed.
  it("logs a cached pick after a silent detour to another track", () => {
    const first = nextSelectionLine(EMPTY, {
      videoId: "aaa",
      shown: "ytmusic timed",
      settled: true,
    });
    const detour = nextSelectionLine(first.state, {
      videoId: "bbb",
      shown: "",
      settled: false,
    });
    expect(detour.line).toBeNull();
    const back = nextSelectionLine(detour.state, {
      videoId: "aaa",
      shown: "ytmusic timed",
      settled: true,
    });
    expect(back.line).toBe("[lyrics] showing ytmusic timed for aaa");
  });

  it("logs the user pinning a different source", () => {
    const auto = nextSelectionLine(EMPTY, {
      videoId: "aaa",
      shown: "ytmusic timed",
      settled: true,
    });
    const pinned = nextSelectionLine(auto.state, {
      videoId: "aaa",
      shown: "genius plain",
      settled: true,
    });
    expect(pinned.line).toBe("[lyrics] switched to genius plain for aaa");
  });
});
