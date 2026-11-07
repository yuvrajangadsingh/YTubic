import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { pickBest, type LyricsSource } from "./sources";
import { useLyricsSkip } from "./skip";
import type { Lyrics } from "./types";

const timed: Lyrics = { kind: "timed", lines: [{ start: 0, text: "a" }] };
const plain: Lyrics = { kind: "plain", text: "a" };

describe("pickBest", () => {
  const data: Partial<Record<LyricsSource, Lyrics | null>> = {
    ytmusic: plain,
    lrclib: timed,
    genius: timed,
  };
  const get = (s: LyricsSource) => data[s];

  it("prefers timed, then source order", () => {
    expect(pickBest(get, [])).toBe("lrclib");
  });

  it("passes over skipped sources, timed first", () => {
    expect(pickBest(get, ["lrclib"])).toBe("genius");
    expect(pickBest(get, ["lrclib", "genius"])).toBe("ytmusic");
    expect(pickBest(get, ["ytmusic", "lrclib", "genius"])).toBe(
      null,
    );
  });
});

describe("useLyricsSkip", () => {
  it("keeps the 200 most recently touched tracks", () => {
    const { skip } = useLyricsSkip.getState();
    for (let i = 0; i < 205; i++) skip(`v${i}`, "lrclib");
    skip("v0", "genius");
    const byVideo = useLyricsSkip.getState().byVideo;
    expect(Object.keys(byVideo)).toHaveLength(200);
    // v0..v5 fell off; v0 came back as the newest.
    expect(byVideo.v5).toBeUndefined();
    expect(byVideo.v6).toEqual(["lrclib"]);
    expect(byVideo.v0).toEqual(["genius"]);
    expect(byVideo.v204).toEqual(["lrclib"]);
    skip("v204", "genius");
    expect(useLyricsSkip.getState().byVideo.v204).toEqual([
      "lrclib",
      "genius",
    ]);
    useLyricsSkip.getState().reset("v204");
    expect(useLyricsSkip.getState().byVideo.v204).toBeUndefined();
  });
});
