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

/**
 * What a failed lyrics fetch may put in the app log.
 *
 * A whitelist, not a scrub. Everything an error carries past its own class
 * was written by somebody else: a slice of response body, the URL the
 * transport was handed (which holds the search terms and, on Musixmatch,
 * the signed token), whatever a library decided to quote. Redacting that
 * is a losing game; credentials in a URL authority, IPv6 hosts, data:
 * payloads and bare tokens all walked through an earlier version of this.
 *
 * So the output vocabulary is fixed and nothing from the message is ever
 * copied into it. The provider's name is already on the log line the
 * caller writes, so all this has to add is what went wrong.
 */
export function describeLyricsError(e: unknown): string {
  if (e instanceof LyricsRateLimitError) return "rate limited";
  if (e instanceof SyntaxError) return "response was not JSON";
  // Bound the input before any pattern touches it. An error can carry a
  // whole error page, and this runs on the renderer thread.
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  if (
    /JSON Parse error|in JSON at position|Unexpected (token|identifier)|not valid JSON/i.test(
      msg,
    )
  ) {
    return "response was not JSON";
  }
  if (/abort|timed?\s?out/i.test(msg)) return "timed out";
  // Our own throws end in the status ("LRCLIB /get 404"); anything else
  // has to say HTTP for it to count, so a three-digit number inside a
  // body cannot be mistaken for one.
  const trailing = /\b([45]\d{2})\s*$/.exec(msg);
  if (trailing) return `HTTP ${trailing[1]}`;
  const labelled = /\bHTTP\s+([1-5]\d{2})\b/i.exec(msg);
  if (labelled) return `HTTP ${labelled[1]}`;
  if (/error sending request|failed to fetch|network|connect/i.test(msg)) {
    return "network error";
  }
  // The class name is written by our code or a runtime, never by a
  // server. Still bounded, in case something exotic sets its own.
  const name = e instanceof Error ? e.name : "";
  return /^[A-Za-z]{1,40}$/.test(name) && name !== "Error" ? name : "failed";
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
