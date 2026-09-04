import { appLog } from "@/lib/app-log";
import type { Lyrics } from "@/lib/lyrics/types";

/**
 * Is this "lyrics" text actually a scraped web page's chrome?
 *
 * 2026-09-04, "Night Out" by Arjan Dhillon: every LRCLIB record for the
 * track begins `Menu / Home / News / Quiz / Charts / Stories / SWITCH
 * SKIN / You Are Here / Home`. Someone uploaded a lyrics site's navigation
 * menu as the words, YouTube Music had none for the track, LRCLIB was next
 * in line, and the app showed a menu in the fullscreen player. Community
 * databases will always hold a few of these, so every provider's result
 * passes through here before it can win.
 *
 * Two rules, both deliberately narrow so a real song cannot trip them:
 *   - three or more of the first fifteen lines are, whole, a known piece
 *     of site chrome ("Menu", "Home", "Privacy Policy"...), or
 *   - two are, and at least eight of those lines are the one-or-two-word
 *     unpunctuated labels a navigation bar is made of.
 * A lyric that happens to contain the line "Home" is not enough on its
 * own, and short-lined real lyrics ("Yeah", "Oh", "Baby") carry no chrome
 * words at all.
 */
const CHROME_LINES = new Set([
  "menu",
  "home",
  "news",
  "quiz",
  "charts",
  "stories",
  "switch skin",
  "you are here",
  "login",
  "log in",
  "sign in",
  "sign up",
  "register",
  "search",
  "subscribe",
  "privacy policy",
  "terms",
  "terms of use",
  "terms of service",
  "cookie policy",
  "contact",
  "contact us",
  "about",
  "about us",
  "advertisement",
  "read more",
  "share",
  "download",
  "next",
  "previous",
  "related",
  "popular",
  "trending",
  "categories",
  "tags",
  "comments",
  "copyright",
  "all rights reserved",
]);

const HEAD_LINES = 15;
const CHROME_HITS_ALONE = 3;
const CHROME_HITS_WITH_SHAPE = 2;
const SHORT_LABEL_RUN = 8;

function chromeKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeSiteChrome(lines: string[]): boolean {
  const head = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, HEAD_LINES);
  if (head.length === 0) return false;
  const chromeHits = head.filter((l) => CHROME_LINES.has(chromeKey(l))).length;
  if (chromeHits >= CHROME_HITS_ALONE) return true;
  if (chromeHits < CHROME_HITS_WITH_SHAPE) return false;
  const shortLabels = head.filter(
    (l) => l.split(/\s+/).length <= 2 && !/[.,!?'"…;:()]/.test(l),
  ).length;
  return shortLabels >= SHORT_LABEL_RUN;
}

function linesOf(lyrics: Lyrics): string[] {
  if (lyrics.kind === "timed") return lyrics.lines.map((l) => l.text);
  return lyrics.text.split(/\r?\n/);
}

/**
 * Wrap a provider result: anything that reads as site chrome becomes
 * "no lyrics from this source", logged, so the next source gets its turn
 * instead of a menu winning the display.
 */
export function rejectSiteChrome(source: string) {
  return (lyrics: Lyrics | null): Lyrics | null => {
    if (!lyrics) return null;
    if (!looksLikeSiteChrome(linesOf(lyrics))) return lyrics;
    appLog(
      `lyrics from ${source} rejected: reads as a web page's navigation, not lyrics`,
    );
    return null;
  };
}
