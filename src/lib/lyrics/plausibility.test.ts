import { describe, expect, it } from "vitest";
import {
  looksLikeSiteChrome,
  rejectSiteChrome,
} from "@/lib/lyrics/plausibility";

// Verbatim from LRCLIB's four records for "Night Out" / Arjan Dhillon on
// 2026-09-04: a lyrics site's navigation uploaded as the words.
const NIGHT_OUT_JUNK = [
  "Menu",
  "",
  "Home",
  "",
  "News",
  "",
  "Quiz",
  "",
  "Charts",
  "",
  "Stories",
  "",
  "SWITCH SKIN",
  "",
  "You Are Here",
  "",
  "Home",
];

describe("looksLikeSiteChrome", () => {
  it("catches the Night Out menu that LRCLIB served", () => {
    expect(looksLikeSiteChrome(NIGHT_OUT_JUNK)).toBe(true);
  });

  it("lets a real song through even when a line is a chrome word", () => {
    // "Home" and "Stories" as lyric lines: two hits, but sentences around
    // them, so the shape rule does not fire either.
    expect(
      looksLikeSiteChrome([
        "Take me back to where the lights are low",
        "Home",
        "Where the river bends and the cold winds blow",
        "I've been telling all my stories",
        "Stories",
        "To the walls that never answer, oh",
        "And I'm still waiting on the morning",
      ]),
    ).toBe(false);
  });

  it("lets short-lined real lyrics through", () => {
    expect(
      looksLikeSiteChrome([
        "Yeah",
        "Oh",
        "Baby",
        "Uh-huh",
        "Yeah yeah",
        "Come on",
        "Oh oh",
        "Baby baby",
        "Let's go",
        "Yeah",
      ]),
    ).toBe(false);
  });

  it("lets transliterated Punjabi lyrics through", () => {
    expect(
      looksLikeSiteChrome([
        "Raat nu night out te jaana",
        "Yaaran naal gedi laana",
        "Kudiyan de vich charche",
        "Arjan Dhillon da gaana",
      ]),
    ).toBe(false);
  });

  it("needs the shape too when only two chrome words appear", () => {
    // Two chrome lines plus eight short unpunctuated labels: a nav bar.
    expect(
      looksLikeSiteChrome([
        "Home",
        "About",
        "Punjabi",
        "Hindi",
        "English",
        "Albums",
        "Artists",
        "Videos",
        "Latest",
        "Top",
      ]),
    ).toBe(true);
    // The same two chrome lines inside sentences: a song.
    expect(
      looksLikeSiteChrome([
        "Home",
        "About",
        "You said you'd never leave me, darling",
        "But the night is long and the road is cold",
      ]),
    ).toBe(false);
  });

  it("a repeated hook is one word, not three pieces of chrome", () => {
    // Review finding: "Home / Home / Home" counted as three hits.
    expect(
      looksLikeSiteChrome([
        "Home",
        "Home",
        "Home",
        "Take me home tonight",
        "I don't want to let you go till you see the light",
      ]),
    ).toBe(false);
  });

  it("a chant of short lines with one chrome word is a song", () => {
    expect(
      looksLikeSiteChrome([
        "Home",
        "Hey",
        "Ho",
        "Hey",
        "Ho",
        "Hey",
        "Ho",
        "Hey",
        "Ho",
        "Home",
      ]),
    ).toBe(false);
  });

  it("empty input is not chrome", () => {
    expect(looksLikeSiteChrome([])).toBe(false);
    expect(looksLikeSiteChrome(["", "  "])).toBe(false);
  });
});

describe("rejectSiteChrome", () => {
  it("turns a chrome result into no result and passes real lyrics through", () => {
    const gate = rejectSiteChrome("LRCLIB");
    expect(
      gate({
        kind: "plain",
        text: NIGHT_OUT_JUNK.join("\n"),
        source: "LRCLIB",
      }),
    ).toBeNull();
    const timed = {
      kind: "timed" as const,
      lines: NIGHT_OUT_JUNK.filter(Boolean).map((text, i) => ({
        start: i * 2,
        text,
      })),
      source: "LRCLIB",
    };
    expect(gate(timed)).toBeNull();
    const real = {
      kind: "plain" as const,
      text: "Raat nu night out te jaana\nYaaran naal gedi laana",
    };
    expect(gate(real)).toBe(real);
    expect(gate(null)).toBeNull();
  });
});
