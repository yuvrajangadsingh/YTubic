import { describe, expect, it } from "vitest";
import {
  alternateCandidateOk,
  artistSignal,
  cleanAudioSwapOk,
} from "@/lib/innertube/alternate-source";

describe("artistSignal", () => {
  it("prefers the parsed artists array", () => {
    expect(
      artistSignal({
        artists: [{ name: "Nanku" }, { name: "Lambo Drive" }],
        subtitle: "Song • Someone Else • 0:38",
      }),
    ).toBe("Nanku Lambo Drive");
  });

  it("recovers the name from a subtitle when artists are unparsed", () => {
    // Only artist-linked runs become `artists`, so search rows routinely
    // arrive with the name present but unparsed.
    expect(artistSignal({ subtitle: "Song • Nanku • 0:38" })).toBe("Nanku");
    expect(
      artistSignal({ subtitle: "Lambo Drive & Nanku • 349K views • 6:15" }),
    ).toBe("Lambo Drive & Nanku");
  });

  it("returns nothing when the subtitle is all structure", () => {
    expect(artistSignal({ subtitle: "Song • 0:38" })).toBe("");
    expect(artistSignal({})).toBe("");
    expect(artistSignal({ artists: [], subtitle: "" })).toBe("");
  });
});

describe("alternateCandidateOk", () => {
  const babe = {
    videoId: "babe-song",
    title: "Babe",
    subtitle: "Song • Nanku • 0:38",
    duration: 38,
  };

  it("rejects a same-title upload from a different artist", () => {
    // The bug: "Babe" alone ranks nursery rhymes and Spanish regional above
    // anything by Nanku, and the wrong one played.
    expect(
      alternateCandidateOk(
        babe,
        {
          kind: "video",
          id: "other",
          title: "Babe",
          subtitle: "Fuerza Regida • 533M views • 4:30",
          duration: 270,
        },
        "video",
      ),
    ).toBe(false);
  });

  it("rejects a candidate with no duration to vouch for it", () => {
    // This escape hatch is how a 0:38 song reached a 6:56 upload.
    expect(
      alternateCandidateOk(
        babe,
        { kind: "video", id: "other", title: "Babe", subtitle: "Nanku" },
        "video",
      ),
    ).toBe(false);
  });

  it("rejects when either side has no artist named", () => {
    expect(
      alternateCandidateOk(
        { videoId: "a", title: "Babe", duration: 38 },
        {
          kind: "video",
          id: "b",
          title: "Babe",
          subtitle: "Nanku • 1K views • 1:00",
          duration: 60,
        },
        "video",
      ),
    ).toBe(false);
    expect(
      alternateCandidateOk(
        babe,
        { kind: "video", id: "b", title: "Babe", duration: 60 },
        "video",
      ),
    ).toBe(false);
  });

  it("takes a genuine counterpart", () => {
    expect(
      alternateCandidateOk(
        { videoId: "song-id", title: "Yezdi", subtitle: "Nanku", duration: 147 },
        {
          kind: "video",
          id: "video-id",
          title: "Yezdi",
          subtitle: "Nanku • 991K views • 2:35",
          duration: 155,
        },
        "video",
      ),
    ).toBe(true);
  });

  it("still refuses a counterpart in a different league", () => {
    expect(
      alternateCandidateOk(
        { videoId: "song-id", title: "Yezdi", subtitle: "Nanku", duration: 147 },
        {
          kind: "video",
          id: "mix-id",
          title: "Yezdi",
          subtitle: "Nanku • 1M views • 60:00",
          duration: 3600,
        },
        "video",
      ),
    ).toBe(false);
  });

  it("never returns the track itself", () => {
    expect(
      alternateCandidateOk(
        babe,
        {
          kind: "video",
          id: "babe-song",
          title: "Babe",
          subtitle: "Nanku",
          duration: 38,
        },
        "video",
      ),
    ).toBe(false);
  });
});

describe("cleanAudioSwapOk", () => {
  it("rescues a clearly-extended song row (the 7:45 remix case)", () => {
    // 465s extended upload vs the 232s album version
    expect(cleanAudioSwapOk("song", 465, 232)).toBe(true);
    expect(cleanAudioSwapOk(undefined, 465, 232)).toBe(true);
  });

  it("leaves near-equal song rows alone (no version ping-pong)", () => {
    expect(cleanAudioSwapOk("song", 240, 232)).toBe(false);
    expect(cleanAudioSwapOk("song", 232, 240)).toBe(false);
  });

  it("video rows accept the album version even when near-equal", () => {
    expect(cleanAudioSwapOk("video", 245, 232)).toBe(true);
    expect(cleanAudioSwapOk("video", 232, 245)).toBe(true);
    // but not a much longer 'song'
    expect(cleanAudioSwapOk("video", 232, 465)).toBe(false);
  });

  it("never swaps without duration data or onto a stub", () => {
    expect(cleanAudioSwapOk("song", undefined, 232)).toBe(false);
    expect(cleanAudioSwapOk("song", 465, undefined)).toBe(false);
    expect(cleanAudioSwapOk("song", 465, 45)).toBe(false);
  });
});
