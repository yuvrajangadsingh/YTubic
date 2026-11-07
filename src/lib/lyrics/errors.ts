import { InnerTubeHttpError } from "@/lib/innertube/shared";

/**
 * The one distinction every lyrics provider has to keep intact: "this track
 * has no lyrics" and "we could not find out" are different answers.
 *
 * They used to collapse. A provider (Genius, since removed) wrapped every
 * request in `catch { return null }` and returned null for any non-OK status,
 * so a DNS blip and a 403 both arrived as the same `null` a genuinely
 * lyric-less track produces. React Query stores `null` as
 * a SUCCESS, `App.tsx` dehydrates successes into IndexedDB and
 * `query-client.ts` keeps them for 24h (staleTime an hour), so one dropped
 * packet was written to disk and replayed as an authoritative "No lyrics
 * found." with no way to ask again. Confirmed end to end, including on a
 * plain HTTP 503.
 *
 * The rule, which `lrclib.ts` already followed: throw for anything that
 * might succeed on a retry, return a value only for a real answer. A 404 and
 * an empty result set stay genuine misses. Errored queries are neither
 * cached nor dehydrated, so they retry on their own.
 */

/**
 * Raised when a provider refuses to serve us for now, as opposed to failing.
 * The lyrics panel fires on every track change whether or not anyone is
 * looking at it, so a 429 can arrive at any time.
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
 * of its own into the log. Frozen, because `as const` is a type and a
 * getter on such an object runs before the lookup and could rewrite the
 * entry it is about to match.
 */
export const LYRICS_OPS = Object.freeze([
  "LRCLIB /get",
  "LRCLIB /search",
  "YouTube Music browse",
] as const);
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
 * search terms), a `name` any object
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
    // An indexed loop, not `find`: the list is frozen, but a getter that
    // ran during the read above could have swapped Array.prototype.find,
    // and a frozen array still inherits its methods.
    let known: LyricsOp | undefined;
    for (let i = 0; i < LYRICS_OPS.length; i++) {
      if (LYRICS_OPS[i] === op) known = LYRICS_OPS[i];
    }
    return known ? `${known} HTTP ${status}` : `HTTP ${status}`;
  }
  if (e instanceof LyricsTimeoutError) return "timed out";
  // The first hop of the YouTube Music lookup goes through the shared
  // InnerTube transport, which throws its own typed error.
  if (e instanceof InnerTubeHttpError) {
    const { status } = e;
    return isHttpStatus(status) ? `YouTube Music HTTP ${status}` : "http error";
  }
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
/** Focus refetch for a lyrics query that failed with nothing to show: worth
 *  it after a network or server failure (an offline launch), not after a
 *  refusal or a 4xx, which the next focus would only repeat. */
export function shouldRefetchLyricsOnFocus(query: {
  state: { status: string; data: unknown; error: unknown };
}): boolean {
  const { status, data, error } = query.state;
  if (status !== "error" || data !== undefined) return false;
  if (error instanceof LyricsRateLimitError) return false;
  // Both our providers' HTTP errors and YouTube Music's own (the ytmusic
  // source goes through InnerTube).
  const httpStatus =
    error instanceof LyricsHttpError || error instanceof InnerTubeHttpError
      ? error.status
      : undefined;
  return !(httpStatus !== undefined && httpStatus < 500);
}

export function shouldRetryLyricsQuery(
  failureCount: number,
  error: Error,
): boolean {
  if (error instanceof LyricsRateLimitError) return false;
  return failureCount < AUTO_RETRIES;
}
