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
 * The requests a `LyricsHttpError` can name, in our own words. The
 * describer prints the entry from this list, never the value it was
 * handed, so an object wearing the class's prototype cannot get a string
 * of its own into the log.
 */
export const LYRICS_OPS = [
  "Genius search",
  "Genius page",
  "Musixmatch token.get",
  "Musixmatch track.search",
  "Musixmatch track.subtitle.get",
  "Musixmatch track.lyrics.get",
  "LRCLIB /get",
  "LRCLIB /search",
  "YouTube Music browse",
] as const;
export type LyricsOp = (typeof LYRICS_OPS)[number];

/**
 * A response status the caller decided is a failure, carrying the number
 * itself rather than a sentence containing it.
 *
 * `op` names the request, from the list above. Between them they are
 * everything the log needs, and neither is written by a server, which is
 * the point: reading a status back out of an error message meant reading
 * whatever else the message happened to contain.
 */
export class LyricsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly op: LyricsOp,
  ) {
    super(`${op} ${status}`);
    this.name = "LyricsHttpError";
  }
}

/** The provider chain ran past its budget. */
export class LyricsTimeoutError extends Error {
  constructor() {
    super("lyrics fetch timed out");
    this.name = "LyricsTimeoutError";
  }
}

/**
 * What a failed lyrics fetch may put in the app log.
 *
 * Classification only. Nothing here reads a message, a URL or an error
 * name, because all three are written by somebody else: a slice of
 * response body, the address the transport was handed (which holds the
 * search terms and, on Musixmatch, the signed token), a `name` any object
 * can set. Two earlier versions of this tried to redact the dangerous
 * parts and both leaked, the second through a trailing three-digit number
 * it read as a status and through the error's own name.
 *
 * So the facts come from types we throw ourselves. A provider we do not
 * recognise is "failed", and that is the honest answer: we do not know
 * what it said and we are not going to quote it to find out.
 */
export function describeLyricsError(e: unknown): string {
  if (e instanceof LyricsRateLimitError) return "rate limited";
  if (e instanceof LyricsHttpError) {
    // Each property is read once. A getter can answer differently on the
    // second read, and the value checked has to be the value printed.
    const { status, op } = e;
    if (!isHttpStatus(status)) return "http error";
    const known = LYRICS_OPS.find((ours) => ours === op);
    return known ? `${known} HTTP ${status}` : `HTTP ${status}`;
  }
  if (e instanceof LyricsTimeoutError) return "timed out";
  if (e instanceof SyntaxError) return "response was not JSON";
  // AbortSignal.timeout rejects with a DOMException whose name is
  // spec-defined and read-only. Comparing it copies nothing.
  if (
    typeof DOMException !== "undefined" &&
    e instanceof DOMException &&
    (e.name === "TimeoutError" || e.name === "AbortError")
  ) {
    return "timed out";
  }
  return "failed";
}

function isHttpStatus(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599;
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
