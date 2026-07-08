import { invoke } from "@tauri-apps/api/core";
import { isPremium } from "@/lib/store/premium";

/**
 * The Rust side runs a tiny axum server on a random localhost port that
 * streams yt-dlp output progressively. We query the port once and build
 * stream URLs from it.
 *
 * Non-Premium / signed-out users append `?ephemeral=1` to every stream
 * URL. The Rust handler reads that as "serve playback but write to a
 * session-only cache directory that gets wiped on every app startup" —
 * a persistent on-disk library of tracks is a Premium-only feature.
 */

let baseUrlPromise: Promise<string> | null = null;

async function fetchBaseUrl(): Promise<string> {
  // Up to ~2s of retries — the server starts asynchronously from Tauri
  // setup() and may not be listening yet when the first track plays.
  for (let i = 0; i < 20; i++) {
    try {
      return await invoke<string>("get_stream_base_url");
    } catch (e) {
      if (i === 19) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("unreachable");
}

export function getStreamBaseUrl(): Promise<string> {
  if (!baseUrlPromise) {
    baseUrlPromise = fetchBaseUrl().catch((e) => {
      baseUrlPromise = null; // retry next call
      throw e;
    });
  }
  return baseUrlPromise;
}

export type StreamOptions = {
  /** Request the music-video stream (progressive h264/mp4) instead of
   *  the audio-only one. Cached independently on the Rust side. */
  video?: boolean;
};

function streamQuery(opts?: StreamOptions): string {
  const params = new URLSearchParams();
  // Non-Premium / signed-out sessions stream via the session-only pool.
  if (!isPremium()) params.set("ephemeral", "1");
  if (opts?.video) params.set("video", "1");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function streamUrlFor(
  videoId: string,
  opts?: StreamOptions,
): Promise<string> {
  const base = await getStreamBaseUrl();
  return `${base}/stream/${encodeURIComponent(videoId)}${streamQuery(opts)}`;
}

const prefetched = new Set<string>();

/**
 * Warm the disk cache for a videoId in the background. No-ops if we
 * already fired a prefetch for this id in this session, or if the user
 * isn't on Premium — pre-warming a session-only cache doesn't help once
 * the user advances past the prefetched track (the next app launch
 * wipes it anyway).
 *
 * The server itself is idempotent on a per-file basis (checks .part /
 * .webm existence), so re-firing is cheap but still skippable.
 */
export async function prefetchStream(
  videoId: string,
  opts?: StreamOptions,
): Promise<void> {
  if (!isPremium()) return;
  // Audio and video variants cache separately, so warm them separately.
  const memoKey = opts?.video ? `v:${videoId}` : videoId;
  if (prefetched.has(memoKey)) return;
  prefetched.add(memoKey);
  try {
    const base = await getStreamBaseUrl();
    // Fire-and-forget — server returns 200/202 immediately and caches
    // bytes in the background. fetch() only rejects on network errors, so an
    // HTTP 4xx/5xx (yt-dlp spawn/extractor failure) resolves normally — drop
    // the warm mark on an error status so the id is retried later.
    const res = await fetch(
      `${base}/prefetch/${encodeURIComponent(videoId)}${streamQuery(opts)}`,
    );
    if (!res.ok) prefetched.delete(memoKey);
  } catch {
    // If it fails we'll just fall through to on-demand fetch later.
    prefetched.delete(memoKey);
  }
}

/**
 * Drop the in-memory "already prefetched" log. Call after the user
 * clears the disk cache via Settings — otherwise we'd never re-prefetch
 * tracks that are gone from disk but still remembered as "warm" here.
 */
export function clearPrefetchMemo(): void {
  prefetched.clear();
}
