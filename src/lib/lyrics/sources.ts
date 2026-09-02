import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchLrclibLyrics } from "@/lib/lyrics/lrclib";
import { fetchMusixmatchLyrics } from "@/lib/lyrics/musixmatch";
import { fetchGeniusLyrics } from "@/lib/lyrics/genius";
import { fetchYtMusicLyrics } from "@/lib/lyrics/ytmusic";
import { shouldRetryLyricsQuery } from "@/lib/lyrics/errors";
import { cleanTrackTitle, lyricsArtist } from "@/lib/track-meta";
import type { Lyrics } from "@/lib/lyrics/types";
import type { QueueTrack } from "@/lib/store/playback";

export type LyricsSource = "ytmusic" | "lrclib" | "musixmatch" | "genius";

/**
 * YouTube Music leads because it is the only source keyed on the videoId
 * rather than on a fuzzy title/artist string: it structurally cannot hand
 * back another song's words, and the words it has are line-synced.
 */
export const SOURCE_ORDER: LyricsSource[] = [
  "ytmusic",
  "lrclib",
  "musixmatch",
  "genius",
];

export const SOURCE_LABELS: Record<LyricsSource, string> = {
  ytmusic: "YouTube Music",
  lrclib: "LRCLIB",
  musixmatch: "Musixmatch",
  genius: "Genius",
};

const ONE_HOUR = 60 * 60 * 1000;

/** Per-provider time budget for one fetch attempt. A single dead
 *  provider (stalled TCP, hung extractor endpoint) used to keep its
 *  query in `isLoading` forever — the fetch never resolved, so
 *  `retry: 1` never fired and the panel sat on "Loading lyrics…"
 *  until a track change. The budget covers a provider's WHOLE call
 *  chain (Musixmatch does up to 4 sequential requests), so it's
 *  deliberately roomier than a single-request timeout would be. */
const PROVIDER_TIMEOUT_MS = 8_000;

/** `AbortSignal.timeout` with a fallback for older WebKit — the
 *  controller+setTimeout pair is semantically identical, it just
 *  leaks a timer for the duration instead of cancelling it. */
function lyricsTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("lyrics fetch timed out")), ms);
  return controller.signal;
}

/**
 * Fire every lyric query in parallel, plus a derived "best" selection.
 * Auto-pick rule: first source (in `SOURCE_ORDER`) that has any lyrics,
 * with timed lyrics ALWAYS winning over plain — i.e. if LRCLIB has plain
 * text but Musixmatch has synced LRC, Musixmatch wins.
 *
 * Every provider runs under `PROVIDER_TIMEOUT_MS`, so all queries are
 * guaranteed to settle (data, null, or error) and the panel always reaches
 * "No lyrics found." instead of hanging on one dead source. An errored
 * source has `data === undefined`, so it is skipped by both passes below
 * and the remaining sources still answer — a YouTube Music outage degrades
 * to the other three rather than blanking the panel.
 */
export function useLyricsSources(track: QueueTrack | undefined, enabled: boolean) {
  // YTM's strings are built for a UI, not for a database query: titles
  // carry "(Official Video)" style upload furniture and tracks played from
  // search cards / next-up rows carry a decorated breadcrumb ("Song • Don
  // Toliver • 3:47") in place of an artist. Both were being sent verbatim,
  // and both cost most or all of a provider's result set. See track-meta.ts
  // for the measurements.
  const artistName = lyricsArtist(track);
  const title = track ? cleanTrackTitle(track.title) : undefined;

  // A bare title is not identity: with no artist line at all, any provider
  // match would rest on the title alone, and popular titles are shared by
  // a dozen unrelated songs (the wrong-Bittersweet bug). Don't query at
  // all — no lyrics beats confidently-wrong lyrics. The providers keep
  // their own artist-less duration gates as a second layer for any other
  // caller.
  //
  // Deliberately NOT applied to YouTube Music: that lookup is keyed on the
  // videoId, so there is no title to be ambiguous about. One track here
  // proves the difference — "Aarzu (with Asim Azhar)" carries no artist at
  // all, so all three text providers stay disabled, and YTM returns 47
  // line-synced lines for it.
  const verifiable = !!artistName?.trim();

  // Keyed on the videoId alone. No title, no artist, nothing to normalise.
  const ytmusic = useQuery({
    queryKey: ["lyrics", "ytmusic-v1", track?.videoId],
    queryFn: () =>
      fetchYtMusicLyrics(
        track!.videoId,
        lyricsTimeoutSignal(PROVIDER_TIMEOUT_MS),
      ),
    enabled: !!track?.videoId && enabled,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  // v2: matching semantics changed (artist-less tracks are no longer
  // looked up), so bump the keys to orphan persisted v1 entries that may
  // hold a wrong-song match.
  // lrclib-v3: synced records now outrank /get's plain-only duplicates
  // and one endpoint failing no longer drops the other's hit — orphan
  // v2 entries that cached a plain result while a synced row existed.
  // lrclib-v4: version-qualified titles (remix/live) now outrank
  // duration closeness — orphan v3 entries that cached the wrong
  // edit's timings (original lyrics on the remix upload).
  // lrclib-v5: timestamps now rescale to the track's listed length
  // (sped-up/slowed re-uploads) — orphan v4 entries holding unscaled
  // timings.
  // v6/v3: the title and artist sent to every provider are now cleaned
  // lookup metadata rather than YTM's display strings, and a failed lookup
  // no longer resolves to a cached "no lyrics" — orphan every entry keyed
  // on a raw title, and every one holding a swallowed failure.
  const lrclib = useQuery({
    queryKey: [
      "lyrics",
      "lrclib-v6",
      title,
      artistName,
      track?.album,
      track?.duration,
    ],
    queryFn: () =>
      fetchLrclibLyrics(
        {
          title: title!,
          artist: artistName,
          album: track?.album,
          duration: track?.duration,
        },
        lyricsTimeoutSignal(PROVIDER_TIMEOUT_MS),
      ),
    enabled: !!track && enabled && verifiable,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const musixmatch = useQuery({
    queryKey: ["lyrics", "musixmatch-v3", title, artistName, track?.duration],
    queryFn: () =>
      fetchMusixmatchLyrics(
        {
          title: title!,
          artist: artistName,
          duration: track?.duration,
        },
        lyricsTimeoutSignal(PROVIDER_TIMEOUT_MS),
      ),
    enabled: !!track && enabled && verifiable,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const genius = useQuery({
    queryKey: ["lyrics", "genius-v3", title, artistName],
    queryFn: () =>
      fetchGeniusLyrics(
        {
          title: title!,
          artist: artistName,
        },
        lyricsTimeoutSignal(PROVIDER_TIMEOUT_MS),
      ),
    enabled: !!track && enabled && verifiable,
    staleTime: ONE_HOUR,
    retry: shouldRetryLyricsQuery,
  });

  const queries: Record<LyricsSource, UseQueryResult<Lyrics | null>> = {
    ytmusic,
    lrclib,
    musixmatch,
    genius,
  };

  let best: LyricsSource | null = null;
  for (const s of SOURCE_ORDER) {
    if (queries[s].data?.kind === "timed") {
      best = s;
      break;
    }
  }
  if (!best) {
    for (const s of SOURCE_ORDER) {
      if (queries[s].data?.kind === "plain") {
        best = s;
        break;
      }
    }
  }

  const isLoading = SOURCE_ORDER.some((s) => queries[s].isLoading);

  return { queries, best, isLoading };
}
