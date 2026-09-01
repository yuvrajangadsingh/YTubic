/**
 * The one distinction every lyrics provider has to keep intact: "this track
 * has no lyrics" and "we could not find out" are different answers.
 *
 * They used to collapse. Genius and Musixmatch wrapped every request in
 * `catch { return null }` and returned null for any non-OK status, so a DNS
 * blip, a Musixmatch captcha gate and a Genius 403 all arrived as the same
 * `null` a genuinely lyric-less track produces. React Query stores `null` as
 * a SUCCESS, `App.tsx` dehydrates successes into IndexedDB and
 * `query-client.ts` keeps them for 24h (staleTime an hour), so one dropped
 * packet was written to disk and replayed as an authoritative "No lyrics
 * found." with no way to ask again. Confirmed end to end for both providers,
 * including on a plain HTTP 503.
 *
 * The rule, which `lrclib.ts` already followed: throw for anything that
 * might succeed on a retry, return a value only for a real answer. A 404 and
 * an empty result set stay genuine misses. Errored queries are neither
 * cached nor dehydrated, so they retry on their own.
 */

/**
 * Raised when a provider refuses to serve us for now, as opposed to failing.
 * Musixmatch gates hard (its token endpoint hands back a literal
 * "UpgradeOnly…" token when the IP is flagged) and the lyrics panel fires on
 * every track change whether or not anyone is looking at it.
 *
 * Kept separate from the others for one reason: an immediate retry is the
 * exact wrong response to being told "too often", so `shouldRetryLyricsQuery`
 * refuses to re-run these.
 */
export class LyricsRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LyricsRateLimitError";
  }
}

/** How many times React Query re-runs a failed lyrics query on its own. */
const AUTO_RETRIES = 1;

/**
 * React Query's `retry` predicate for every lyrics source. Lives here rather
 * than in the hook so it can be tested without mounting anything.
 *
 * `error` is typed as `Error`, not `unknown`: React Query infers a query's
 * `TError` from this predicate, and widening it here would widen every
 * consumer of `queries[s].error` along with it.
 */
export function shouldRetryLyricsQuery(
  failureCount: number,
  error: Error,
): boolean {
  if (error instanceof LyricsRateLimitError) return false;
  return failureCount < AUTO_RETRIES;
}
