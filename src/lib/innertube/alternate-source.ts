import { fetchSearch } from "./search";
import { fetchRadio } from "./radio";
import { normalizeForMatch, normalizeKeepingQualifiers, tokenOverlap } from "@/lib/lyrics/match";
import type { SourceKind } from "@/lib/store/track-source";
import type { MinimalArtist, ShelfItemKind } from "./types";

/**
 * The artist names for a track, falling back to its subtitle when the
 * InnerTube row didn't carry a parsed `artists` array.
 *
 * Only subtitle runs that link to an artist page become `artists`, so plenty
 * of rows arrive with the names present but unparsed — a search result reads
 * `subtitle: "Song • Nanku • 0:38"` with `artists: undefined`. That used to
 * silently blank the artist half of the identity check AND drop the artist
 * from the search query, which is how a 0:38 Nanku track toggled into a
 * completely unrelated upload: the bare query "Babe" returns nursery rhymes
 * and Spanish regional, and with no artist to compare against, the first
 * title collision won.
 *
 * The kind prefix ("Song"/"Video"/…), the view count and the trailing
 * duration are structural, not names, so they are stripped.
 */
export function artistSignal(track: {
  artists?: MinimalArtist[];
  subtitle?: string;
}): string {
  const parsed = track.artists?.map((a) => a.name).join(" ").trim();
  if (parsed) return parsed;
  const subtitle = track.subtitle?.trim();
  if (!subtitle) return "";
  return subtitle
    .split("•")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        !/^(song|video|album|single|ep|playlist|artist)$/i.test(part) &&
        !/^\d+(\.\d+)?[kmb]?\s+views?$/i.test(part) &&
        !/^\d+:\d{2}(:\d{2})?$/.test(part),
    )
    .join(" ")
    .trim();
}

/**
 * Find the alternate-source videoId for a track by searching YT Music
 * with the opposite kind filter. Every candidate must pass identity
 * gates before we accept it — trusting YT's relevance ranking alone
 * played completely unrelated clips for title collisions (a 2:49
 * "Dilbar" remix toggled into the 15:54 Bollywood "Dilbar"). Same
 * discipline as the lyrics matcher and the clean-audio hunt: the title
 * must actually match, the artists must overlap, and the duration must
 * be in the plausible window for a song<->video counterpart. No match
 * beats a wrong match — the toggle shows "No video version found" on
 * null.
 *
 * Also used to play the uncensored / original audio when YT Music's
 * "song" version is the censored one (common for Russian artists
 * working around the local lyric ban).
 */
export async function findAlternateVideoId(
  track: {
    videoId: string;
    title: string;
    artists?: MinimalArtist[];
    subtitle?: string;
    duration?: number;
  },
  targetKind: SourceKind,
): Promise<string | null> {
  const artistsLine = artistSignal(track);
  // A title-only search is not an identity, it's a coin flip: "Babe" alone
  // returns nursery rhymes, Spanish regional and Khasi pop before anything
  // by the actual artist. Without a name to search for AND compare against,
  // no swap is the only safe answer.
  if (!artistsLine) return null;
  const query = `${track.title} ${artistsLine}`.trim();
  if (!query) return null;
  const filter = targetKind === "video" ? "videos" : "songs";
  const results = await fetchSearch(query, filter);

  for (const shelf of results.shelves) {
    for (const item of shelf.items) {
      if (alternateCandidateOk(track, item, targetKind)) return item.id;
    }
  }
  return null;
}

/**
 * Identity gate for one song<->video counterpart candidate. Exported so the
 * rules are testable without a live InnerTube search.
 *
 * Every signal is REQUIRED, because each one alone has been fooled in the
 * wild: title alone matched a different artist's song of the same name,
 * artist alone matched any track on the record, duration alone matched any
 * three-minute upload. A candidate that cannot prove all three is not a
 * counterpart, and no swap beats a wrong swap.
 */
export function alternateCandidateOk(
  track: {
    videoId: string;
    title: string;
    artists?: MinimalArtist[];
    subtitle?: string;
    duration?: number;
  },
  item: {
    kind: ShelfItemKind;
    id: string;
    title: string;
    artists?: MinimalArtist[];
    subtitle?: string;
    duration?: number;
  },
  targetKind: SourceKind,
): boolean {
  if (item.kind !== "song" && item.kind !== "video") return false;
  if (item.id === track.videoId) return false;

  const reqTitle = normalizeForMatch(track.title);
  const hitTitle = normalizeForMatch(item.title ?? "");
  let titleExact = hitTitle === reqTitle;
  if (titleExact) {
    // normalizeForMatch strips parenthetical qualifiers, so "Song (Remix)"
    // and "Song" look identical to it. The qualifier-preserving form must
    // agree too, or the "exact" match is a different version of the song.
    titleExact =
      normalizeKeepingQualifiers(item.title ?? "") ===
      normalizeKeepingQualifiers(track.title);
  }
  // Symmetric overlap alone punishes the dominant real-world shape: the
  // official upload titled "Song X (Official Video) | Artist | Album |
  // 2024". One shared token against ten of packaging scores ~0.1 and a
  // genuine video is rejected ("Zaalma" scored 0.08 against its own
  // video). The song's title appearing whole inside the upload's title
  // is equally strong evidence, so accept phrase containment too —
  // length-guarded so a two-letter title can't match everything, and
  // with the duration window below still doing the real gatekeeping.
  const titleContained =
    reqTitle.length >= 5 && ` ${hitTitle} `.includes(` ${reqTitle} `);
  if (!titleExact && !titleContained && tokenOverlap(reqTitle, hitTitle) < 0.6)
    return false;

  // The artist has to be named on BOTH sides. Treating an unnamed artist
  // as "nothing to disagree with" is what let a title collision through —
  // silence is not agreement.
  const reqArtists = normalizeForMatch(artistSignal(track));
  if (!reqArtists) return false;
  const hitArtists = normalizeForMatch(artistSignal(item));
  const bylineAgrees =
    !!hitArtists && tokenOverlap(reqArtists, hitArtists) > 0;
  // Label and fan channels put the artist in the TITLE, not the byline:
  // the byline is the uploading channel ("Troll Punjabi"), which never
  // overlaps the artist and used to fail every such upload. When the
  // byline disagrees or is missing, accept the artist named whole inside
  // the video's title instead — per artist, so one credited name is
  // enough ("Pukhraj Bhalla" inside "Zaalma (Full Song) | Pukhraj
  // Bhalla ft JT Bhatti…").
  const namedInTitle = (track.artists ?? [])
    .map((a) => normalizeForMatch(a.name))
    .concat(reqArtists)
    .some((name) => name.length >= 3 && ` ${hitTitle} `.includes(` ${name} `));
  if (!bylineAgrees && !namedInTitle) return false;

  // Duration window: a music video runs a little longer than the album
  // audio (intro/outro), the song side a little shorter. Never accept a
  // counterpart in a different league (compilations, hour loops, clips).
  // A candidate with no duration cannot be checked, so it cannot be taken —
  // that escape hatch is exactly how a 0:38 song reached a 6:56 upload.
  if (!track.duration || !item.duration) return false;
  const delta = item.duration - track.duration;
  if (targetKind === "video") {
    if (delta < -45 || delta > 240) return false;
  } else {
    if (delta < -240 || delta > 45) return false;
  }
  return true;
}

/**
 * Duration sanity for the automatic clean-audio hunt. The manual Song/
 * Video toggle trusts YT's ranking because the user asked for the swap;
 * the AUTO hunt swaps silently, so it must never trade the queued track
 * for something that isn't obviously the same song in its album form.
 *
 * - video uploads: the song version is normally a little shorter (no
 *   intro/outro padding), so accept anything up to slightly longer.
 * - song/unknown rows: only rescue clearly-extended uploads (slowed,
 *   looped, "extended mix" re-uploads) — the album version must be at
 *   least a minute shorter, otherwise leave the queued version alone.
 */
export function cleanAudioSwapOk(
  currentKind: ShelfItemKind | undefined,
  currentDurationSec: number | undefined,
  altDurationSec: number | undefined,
): boolean {
  if (!currentDurationSec || !altDurationSec) return false;
  if (altDurationSec < 60) return false;
  if (currentKind === "video") {
    return altDurationSec <= currentDurationSec + 30;
  }
  return altDurationSec <= currentDurationSec - 60;
}

/**
 * Automatic-hunt variant of `findAlternateVideoId`: find the clean album
 * ("song") version of a queued track, with the title verified against the
 * request and the duration gated by `cleanAudioSwapOk`. Returns null when
 * nothing passes — no swap is always safer than a wrong swap.
 */
export async function findCleanAudioAlternate(track: {
  videoId: string;
  title: string;
  artists?: MinimalArtist[];
  kind?: ShelfItemKind;
  duration?: number;
}): Promise<string | null> {
  const artistsLine = artistSignal(track);
  if (!artistsLine.trim() || !track.title.trim()) return null;
  const results = await fetchSearch(
    `${track.title} ${artistsLine}`.trim(),
    "songs",
  );
  const reqTitle = normalizeForMatch(track.title);
  const reqArtists = normalizeForMatch(artistsLine);
  const passes = (item: {
    kind: ShelfItemKind;
    id: string;
    title: string;
    artists?: MinimalArtist[];
    duration?: number;
  }): boolean => {
    if (item.kind !== "song") return false;
    if (item.id === track.videoId) return false;
    const hitTitle = normalizeForMatch(item.title ?? "");
    if (hitTitle !== reqTitle && tokenOverlap(reqTitle, hitTitle) < 0.6) {
      return false;
    }
    // This hunt swaps silently, so an unnamed artist on the candidate is a
    // reason to skip it, never a free pass.
    const hitArtists = normalizeForMatch(artistSignal(item));
    if (!hitArtists) return false;
    if (tokenOverlap(reqArtists, hitArtists) === 0) return false;
    return cleanAudioSwapOk(track.kind, track.duration, item.duration);
  };
  for (const shelf of results.shelves) {
    for (const item of shelf.items) {
      if (passes(item)) return item.id;
    }
  }
  // Search often surfaces only the canonical entry (which for some songs
  // IS the extended album cut). The track's own radio reliably lists the
  // other uploads of the same song — the shorter album/single version
  // shows up there when search hides it. Same gates apply.
  try {
    const radio = await fetchRadio(track.videoId);
    for (const item of radio) {
      if (passes(item)) return item.id;
    }
  } catch {
    /* radio is best-effort — no swap is fine */
  }
  return null;
}
