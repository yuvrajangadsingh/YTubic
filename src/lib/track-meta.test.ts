import { describe, expect, it } from "vitest";
import {
  artistFromSubtitle,
  artistsFromList,
  cleanTrackTitle,
  lyricsArtist,
  reattributedFromTitle,
  stripTopicSuffix,
} from "./track-meta";

describe("cleanTrackTitle", () => {
  it("drops upload furniture that costs the whole result set", () => {
    // Measured: this exact title returns 0 LRCLIB hits, the bare one 20.
    expect(cleanTrackTitle("Blinding Lights (Official Music Video)")).toBe(
      "Blinding Lights",
    );
    expect(cleanTrackTitle("Blinding Lights [Official Video]")).toBe(
      "Blinding Lights",
    );
    expect(cleanTrackTitle("Levitating (Official Audio)")).toBe("Levitating");
    expect(cleanTrackTitle("Something (Visualizer)")).toBe("Something");
    expect(cleanTrackTitle("Something (Lyrics)")).toBe("Something");
    expect(cleanTrackTitle("Something (4K)")).toBe("Something");
  });

  it("handles the CJK bracket families NFKC leaves alone", () => {
    expect(cleanTrackTitle("アイドル【MV】")).toBe("アイドル");
    expect(cleanTrackTitle("アイドル（Official Music Video）")).toBe(
      "アイドル",
    );
    expect(cleanTrackTitle("좋은 날「가사」")).toBe("좋은 날");
  });

  it("drops featuring credits, which the artist field already carries", () => {
    expect(cleanTrackTitle("Die For You (feat. Ariana Grande)")).toBe(
      "Die For You",
    );
    expect(cleanTrackTitle("Industry Baby (ft. Jack Harlow)")).toBe(
      "Industry Baby",
    );
    expect(cleanTrackTitle("Track (prod. by Metro Boomin)")).toBe("Track");
  });

  it("keeps version qualifiers, which identify the recording", () => {
    // Stripping these would make a remix indistinguishable from its
    // original, and they cost nothing at search time (20 hits either way).
    for (const t of [
      "Die For You (Remix)",
      "Faded (Restrung)",
      "Hotel California (Remastered 2013)",
      "Creep (Acoustic Version)",
      "Bohemian Rhapsody (Live at Wembley)",
      "Song (Sped Up)",
    ]) {
      expect(cleanTrackTitle(t)).toBe(t);
    }
  });

  it("does not mistake a parenthetical title for a credit", () => {
    // "with" reads as a credit in "(with Ariana Grande)" and as part of the
    // name here, and losing a real title is the worse error.
    expect(cleanTrackTitle("Stay (With Me)")).toBe("Stay (With Me)");
    expect(cleanTrackTitle("Dancing With A Stranger")).toBe(
      "Dancing With A Stranger",
    );
  });

  it("removes only the noisy bracket when several are present", () => {
    expect(cleanTrackTitle("Song (Official Video) (Remix)")).toBe(
      "Song (Remix)",
    );
    expect(cleanTrackTitle("Song (feat. X) (Live)")).toBe("Song (Live)");
  });

  it("strips trailing hyphen-separated furniture", () => {
    expect(cleanTrackTitle("Blinding Lights - Official Video")).toBe(
      "Blinding Lights",
    );
    expect(cleanTrackTitle("Blinding Lights | Official Audio")).toBe(
      "Blinding Lights",
    );
  });

  it("drops the format tags re-uploads carry", () => {
    expect(cleanTrackTitle("Жить как я живу (flac)")).toBe("Жить как я живу");
    expect(cleanTrackTitle("Song (320kbps)")).toBe("Song");
    expect(cleanTrackTitle("Song [Lossless]")).toBe("Song");
  });

  it("never returns an empty title", () => {
    // A track genuinely called "Audio" must still be looked up.
    expect(cleanTrackTitle("Audio")).toBe("Audio");
    expect(cleanTrackTitle("(Official Video)")).toBe("(Official Video)");
    expect(cleanTrackTitle("")).toBe("");
  });

  it("leaves an unbalanced bracket alone rather than eating the title", () => {
    expect(cleanTrackTitle("Song (Official Video")).toBe(
      "Song (Official Video",
    );
  });

  it("folds fullwidth latin so the query matches", () => {
    expect(cleanTrackTitle("Ｂｌｉｎｄｉｎｇ　Ｌｉｇｈｔｓ")).toBe(
      "Blinding Lights",
    );
  });
});

/**
 * The titles below are verbatim from this library's own play cache (the 73
 * `<videoId>.meta.json` sidecars), so they are exactly what the lyrics query
 * used to send raw. Cleaning rewrites 11 of those 73.
 */
describe("cleanTrackTitle on real played tracks", () => {
  it("drops the feat. credit desi hip-hop puts in the title", () => {
    expect(cleanTrackTitle("Notorious Jatt (feat. P. Gill)")).toBe(
      "Notorious Jatt",
    );
    expect(
      cleanTrackTitle("MAKE YOU MINE (feat. Abdul Hannan & Hasan Raheem)"),
    ).toBe("MAKE YOU MINE");
    expect(cleanTrackTitle("OBVIOUS (feat. Hasan Raheem)")).toBe("OBVIOUS");
    expect(
      cleanTrackTitle("COME THROUGH (feat. Abdullah Maharvi & Talha Anjum)"),
    ).toBe("COME THROUGH");
  });

  it("keeps punctuation inside the surviving title", () => {
    // Case and "$$" both survive: providers are matched case-insensitively
    // and the artist name is part of the title's identity here.
    expect(cleanTrackTitle("Good Ol' Days (feat. Joey Bada$$)")).toBe(
      "Good Ol' Days",
    );
  });

  it("recovers the two tracks that returned zero LRCLIB candidates raw", () => {
    // Measured on this corpus: both go from 0 candidates to a real record.
    expect(cleanTrackTitle("STAY HERE 4 LIFE (Visualizer)")).toBe(
      "STAY HERE 4 LIFE",
    );
    expect(
      cleanTrackTitle(
        "Too Many Nights (ChoppedNotSlopped) (feat. Don Toliver)",
      ),
    ).toBe("Too Many Nights (ChoppedNotSlopped)");
  });

  it("strips the trailing upload tag off a YouTube re-upload title", () => {
    expect(
      cleanTrackTitle(
        "Hasan Raheem - Wife You ft Talha Anjum | Prod by Umair (Official Lyric Video)",
      ),
    ).toBe("Hasan Raheem - Wife You ft Talha Anjum | Prod by Umair");
  });

  it("keeps edition and version brackets, which name the recording", () => {
    // The feat. credit goes, the edition stays: they say different things.
    expect(
      cleanTrackTitle("Mujhko Mila [Bonus Track] (feat. Chaar Diwaari)"),
    ).toBe("Mujhko Mila [Bonus Track]");
    // "(Extended Version)" is a different cut, not upload furniture, so it
    // survives even though this track finds no lyrics either way.
    expect(cleanTrackTitle("Talha Furkaan (Extended Version)")).toBe(
      "Talha Furkaan (Extended Version)",
    );
  });

  it("leaves the film-soundtrack suffix alone, deliberately", () => {
    // `(From "…")` is not in the noise vocabulary. The one track here that
    // carries it already resolves to the right lyrics, so widening the
    // vocabulary would change a working query for no measured gain.
    expect(cleanTrackTitle('Doobey (From "Gehraiyaan")')).toBe(
      'Doobey (From "Gehraiyaan")',
    );
  });

  it("keeps a '(with X)' credit, which is often part of the name", () => {
    expect(cleanTrackTitle("Aarzu (with Asim Azhar)")).toBe(
      "Aarzu (with Asim Azhar)",
    );
    expect(cleanTrackTitle("Pal Pal (with Talwiinder)")).toBe(
      "Pal Pal (with Talwiinder)",
    );
  });
});

describe("stripTopicSuffix", () => {
  it("removes the auto-generated channel suffix", () => {
    // Measured: "The Weeknd - Topic" takes 20 LRCLIB hits down to 1.
    expect(stripTopicSuffix("The Weeknd - Topic")).toBe("The Weeknd");
    expect(stripTopicSuffix("YOASOBI - Topic")).toBe("YOASOBI");
  });

  it("leaves a real name containing a hyphen intact", () => {
    expect(stripTopicSuffix("Jay-Z")).toBe("Jay-Z");
    expect(stripTopicSuffix("Anne-Marie")).toBe("Anne-Marie");
  });
});

describe("artistFromSubtitle", () => {
  it("pulls the name out of the breadcrumb", () => {
    // Measured: the raw breadcrumb scores 1 hit, or 0 with a view count.
    expect(artistFromSubtitle("Song • The Weeknd")).toBe("The Weeknd");
    expect(artistFromSubtitle("Video • The Weeknd • 1B views")).toBe(
      "The Weeknd",
    );
    expect(artistFromSubtitle("Song • Don Toliver • 3:47")).toBe("Don Toliver");
    expect(artistFromSubtitle("Album • The Weeknd")).toBe("The Weeknd");
  });

  it("returns undefined when the line holds no name at all", () => {
    // Better no artist than a decorated string no provider can match.
    expect(
      artistFromSubtitle("Artist • 224M monthly audience"),
    ).toBeUndefined();
    expect(artistFromSubtitle("Song • 3:47")).toBeUndefined();
    expect(artistFromSubtitle(undefined)).toBeUndefined();
    expect(artistFromSubtitle("")).toBeUndefined();
  });

  it("only treats a type word as furniture in the leading position", () => {
    // "Song" is also a band name.
    expect(artistFromSubtitle("Song • Song")).toBe("Song");
  });

  it("strips the Topic suffix it finds in the breadcrumb", () => {
    expect(artistFromSubtitle("Song • The Weeknd - Topic")).toBe("The Weeknd");
  });

  it("keeps the cases utils.artistLineFromSubtitle already handled", () => {
    // This supersedes that helper on the lyrics path only, so its vocabulary
    // has to be a superset: recency stamps and the Explicit badge included.
    expect(artistFromSubtitle("3.4M views • 2 years ago")).toBeUndefined();
    expect(
      artistFromSubtitle("Song • Kendrick Lamar, SZA • luther • 2:57"),
    ).toBe("Kendrick Lamar, SZA");
    expect(artistFromSubtitle("Song • Explicit • Karan Aujla")).toBe(
      "Karan Aujla",
    );
  });
});

describe("lyricsArtist", () => {
  it("prefers the structured list and joins it", () => {
    // Measured: joining costs nothing (20 hits either way), so keeping
    // every credited name is free insurance against the database crediting
    // the one we would have dropped.
    expect(
      lyricsArtist({
        artists: [{ name: "The Weeknd" }, { name: "Ariana Grande" }],
        subtitle: "Song • Whatever",
      }),
    ).toBe("The Weeknd, Ariana Grande");
    // 35 of the 73 played tracks carry a multi-name credit like this one.
    expect(
      lyricsArtist({
        artists: [{ name: "Rithmetic" }, { name: "Anaaz" }, { name: "Hatim" }],
      }),
    ).toBe("Rithmetic, Anaaz, Hatim");
  });

  it("falls back to the subtitle when there is no list", () => {
    expect(lyricsArtist({ subtitle: "Video • Don Toliver • 12M views" })).toBe(
      "Don Toliver",
    );
  });

  it("is undefined when neither source yields a name", () => {
    expect(
      lyricsArtist({ subtitle: "Artist • 3M subscribers" }),
    ).toBeUndefined();
    expect(lyricsArtist({})).toBeUndefined();
    expect(lyricsArtist(undefined)).toBeUndefined();
  });

  it("de-Topics the structured list too", () => {
    expect(artistsFromList([{ name: "YOASOBI - Topic" }])).toBe("YOASOBI");
  });
});

describe("reattributedFromTitle", () => {
  it("recovers a re-upload that hid the artist in the title", () => {
    // Upstream's reported case: "Скриптонит - Жить как я живу (flac)"
    // uploaded by a channel called "Skrypto gramma". As sent, zero results
    // anywhere; as re-attributed, an ordinary track with six records.
    expect(
      reattributedFromTitle("Скриптонит - Жить как я живу", "Skrypto gramma"),
    ).toEqual({ title: "Жить как я живу", artist: "Скриптонит" });
  });

  it("declines when the credited artist is already in the title", () => {
    // Then the ordinary reading was right and there is nothing to recover.
    expect(
      reattributedFromTitle("Marshmello - Alone", "Marshmello"),
    ).toBeNull();
    // Two of this library's four "Artist - Title" rows look like this, so
    // the fallback correctly never fires for them.
    expect(
      reattributedFromTitle(
        "Hasan Raheem - Fana ft Jj47 | Prod by Abdullah Kasumbi",
        "Hasan Raheem",
      ),
    ).toBeNull();
  });

  it("declines on anything that is not a two-part split", () => {
    expect(reattributedFromTitle("Blinding Lights", "The Weeknd")).toBeNull();
    expect(
      reattributedFromTitle("Levels - Avicii - Levels", "Avicii"),
    ).toBeNull();
  });

  it("splits a 'Title - Artist' upload backwards, which is the known limit", () => {
    // Pinning the behaviour rather than claiming it is right. The rule
    // assumes "Artist - Title"; this row is the other way round and is the
    // only one of the 73 the fallback fires on. Harmless because the retry
    // only runs when the ordinary lookup already returned nothing, and the
    // backwards query returns an empty result set.
    expect(
      reattributedFromTitle(
        "RAKHLO TUM CHHUPAKE - Arpit Bala #rakhlotumchhupake #arpitbala",
        "Kevin Yadav",
      ),
    ).toEqual({
      title: "Arpit Bala #rakhlotumchhupake #arpitbala",
      artist: "RAKHLO TUM CHHUPAKE",
    });
  });
});
