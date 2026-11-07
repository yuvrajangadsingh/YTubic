import { beforeEach, describe, expect, it, vi } from "vitest";
import { InnerTubeHttpError } from "@/lib/innertube/shared";
import {
  LYRICS_OPS,
  describeLyricsError,
  LyricsHttpError,
  LyricsRateLimitError,
  LyricsTimeoutError,
  shouldRetryLyricsQuery,
  type LyricsOp,
  shouldRefetchLyricsOnFocus,
} from "./errors";

// `vi.resetModules()` gives the providers a fresh copy of ./errors, so the
// class they throw is not the one imported above. `setup` hands back the
// copy they actually use; that is what the instanceof assertions compare to.

/**
 * One rule, checked for every provider: a failure to look lyrics up must
 * NOT arrive as the same `null` a genuinely lyric-less track produces.
 *
 * React Query stores `null` as a success, App.tsx dehydrates successes into
 * IndexedDB and query-client.ts keeps them for a day, so a swallowed 503 was
 * being written to disk and replayed as an authoritative "No lyrics found."
 * Genius (since removed) did this, on transport errors AND on plain HTTP errors. LRCLIB already had the right contract and is the control here.
 *
 * The other half of the rule matters just as much: a 404 and an empty result
 * set are real answers and must stay `null`, or every track without lyrics
 * would retry forever.
 */

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
// The InnerTube transport asks the Rust side for the auth context before
// a request and hands Set-Cookie lines back after; an empty jar is fine.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ cookie: null, pageId: null })),
}));

type Route = (url: string) => { status?: number; body?: unknown } | "reject";

/** Fresh module registry per case, so no provider's module state carries over. */
async function setup(route: Route) {
  vi.resetModules();
  const http = await import("@tauri-apps/plugin-http");
  const fetchMock = vi.mocked(http.fetch);
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: unknown) => {
    const url = String(input);
    const r = route(url);
    if (r === "reject") {
      return Promise.reject(new TypeError("Network request failed"));
    }
    const body =
      typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return Promise.resolve(new Response(body, { status: r.status ?? 200 }));
  });
  const lrclib = await import("./lrclib");
  const errors = await import("./errors");
  return {
    ...lrclib,
    RateLimit: errors.LyricsRateLimitError,
  };
}

const TRACK = { title: "Bohemian Rhapsody", artist: "Queen" };

beforeEach(() => vi.clearAllMocks());

describe("a transport failure is not 'no lyrics'", () => {
  it("LRCLIB already did (the control)", async () => {
    const { fetchLrclibLyrics } = await setup(() => "reject");
    await expect(fetchLrclibLyrics(TRACK)).rejects.toThrow(/Network request/);
  });
});

describe("an HTTP error is not 'no lyrics' either", () => {
  it("LRCLIB throws on a 503", async () => {
    const { fetchLrclibLyrics } = await setup(() => ({ status: 503 }));
    await expect(fetchLrclibLyrics(TRACK)).rejects.toThrow(/LRCLIB/);
  });
});

describe("a refusal is not 'no lyrics', and must not be retried at once", () => {
  it("a 429 is a rate limit, not a plain error", async () => {
    const { fetchLrclibLyrics, RateLimit } = await setup(() => ({
      status: 429,
    }));
    await expect(fetchLrclibLyrics(TRACK)).rejects.toBeInstanceOf(RateLimit);
  });

  it("a rate limit wins when the other LRCLIB endpoint failed too", async () => {
    const { fetchLrclibLyrics, RateLimit } = await setup((url) =>
      url.includes("/api/get") ? { status: 503 } : { status: 429 },
    );
    await expect(fetchLrclibLyrics(TRACK)).rejects.toBeInstanceOf(RateLimit);
  });

  it("refetches on focus after a network or server failure only", () => {
    const failed = (error: unknown) => ({
      state: { status: "error", data: undefined, error },
    });
    expect(shouldRefetchLyricsOnFocus(failed(new Error("offline")))).toBe(true);
    expect(
      shouldRefetchLyricsOnFocus(
        failed(new LyricsHttpError(503, "LRCLIB /get")),
      ),
    ).toBe(true);
    expect(
      shouldRefetchLyricsOnFocus(
        failed(new LyricsHttpError(403, "LRCLIB /get")),
      ),
    ).toBe(false);
    expect(
      shouldRefetchLyricsOnFocus(failed(new LyricsRateLimitError("gated"))),
    ).toBe(false);
    expect(
      shouldRefetchLyricsOnFocus(
        failed(new InnerTubeHttpError("next", 403, "")),
      ),
    ).toBe(false);
    expect(
      shouldRefetchLyricsOnFocus(
        failed(new InnerTubeHttpError("next", 503, "")),
      ),
    ).toBe(true);
    expect(
      shouldRefetchLyricsOnFocus({
        state: { status: "success", data: null, error: null },
      }),
    ).toBe(false);
  });

  it("shouldRetryLyricsQuery refuses to re-run a rate limit", () => {
    // Answering "too many requests" with one more request is how a short
    // gate becomes a long one.
    expect(shouldRetryLyricsQuery(0, new LyricsRateLimitError("gated"))).toBe(
      false,
    );
    expect(shouldRetryLyricsQuery(0, new Error("boom"))).toBe(true);
    expect(shouldRetryLyricsQuery(1, new Error("boom"))).toBe(false);
  });
});

describe("a real answer is still an answer", () => {
  it("LRCLIB returns null for a 404 plus an empty search", async () => {
    const { fetchLrclibLyrics } = await setup((url) =>
      url.includes("/api/get") ? { status: 404 } : { body: [] },
    );
    await expect(fetchLrclibLyrics(TRACK)).resolves.toBeNull();
  });
});

/**
 * The log line a failed provider produces. Provider errors quote response
 * bodies, and the app log is a file on disk, so the body has to go.
 */
describe("describeLyricsError", () => {
  it("names the request and the status from our own typed error", () => {
    expect(
      describeLyricsError(new LyricsHttpError(503, "LRCLIB /search")),
    ).toBe("LRCLIB /search HTTP 503");
    expect(describeLyricsError(new LyricsHttpError(404, "LRCLIB /get"))).toBe(
      "LRCLIB /get HTTP 404",
    );
  });

  // The old scrubber read a status back out of message text, and with it
  // whatever else the text held. A plain Error is now opaque on purpose.
  it("does not read a status out of a plain message", () => {
    expect(
      describeLyricsError(
        new Error("LRCLIB HTTP 503: <html>upstream said no</html>"),
      ),
    ).toBe("failed");
  });

  it("names a rate limit without quoting the message", () => {
    expect(
      describeLyricsError(new LyricsRateLimitError("gated for token abc123")),
    ).toBe("rate limited");
  });

  it("names a timeout from our own type and from AbortSignal.timeout", () => {
    expect(describeLyricsError(new LyricsTimeoutError())).toBe("timed out");
    expect(
      describeLyricsError(new DOMException("took too long", "TimeoutError")),
    ).toBe("timed out");
  });

  it("never quotes the body a JSON parse choked on", () => {
    const parsed = (() => {
      try {
        JSON.parse("sessionToken_abc123");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(describeLyricsError(parsed)).toBe("response was not JSON");
  });

  /**
   * Why this is a classifier and not a scrubber. Every one of these walked
   * through a redact-the-bad-parts version: credentials in a URL authority,
   * an IPv6 host, a data: payload, a body quoted before the status, a bare
   * token, an address, and a message that merely looked like a parse error.
   * None of them is a type we throw, so none of them is described.
   */
  it.each([
    [
      "credentials in the authority",
      "sending request for url (https://user:secret@127.0.0.1/x)",
    ],
    [
      "an IPv6 host",
      "sending request for url (https://[::1]:8080/ws?usertoken=secret)",
    ],
    ["a data payload", "failed on data:text/plain;base64,c2VjcmV0VG9rZW4="],
    ["a blob url", "failed on blob:null/9f8e-secretToken"],
    [
      "a body before the status",
      'server said {"key":"secretToken"} then HTTP 503',
    ],
    ["a bare token", "rejected token sk_live_secretToken0123456789"],
    ["an address", "LRCLIB rejected signup for nobody@example.com"],
    [
      "a parse-shaped message",
      "Unexpected token 's', \"secretToken\" is not valid JSON",
    ],
  ])("says only 'failed' for %s", (_what, message) => {
    expect(describeLyricsError(new Error(message))).toBe("failed");
  });

  it("copies nothing from an error's own name or class", () => {
    class ProviderGone extends Error {
      override name = "SecretToken";
    }
    expect(describeLyricsError(new ProviderGone("host down at 10.0.0.4"))).toBe(
      "failed",
    );
    const lying = new LyricsHttpError(
      500,
      "https://x/?usertoken=secret" as LyricsOp,
    );
    expect(describeLyricsError(lying)).toBe("HTTP 500");
  });

  it("reads status and op once and prints the list's copy of the name", () => {
    let reads = 0;
    const hostile = Object.create(LyricsHttpError.prototype) as LyricsHttpError;
    Object.defineProperty(hostile, "status", {
      get: () => (reads++ === 0 ? 503 : "secretToken@example.com"),
    });
    Object.defineProperty(hostile, "op", {
      get: () => (reads++ === 1 ? "LRCLIB /get" : "secretToken@example.com"),
    });
    expect(describeLyricsError(hostile)).toBe("LRCLIB /get HTTP 503");
    expect(reads).toBe(2);
  });

  it("prints no name that is not on the list, however plain it looks", () => {
    // The old shape check took any token-shaped string. A name from the
    // list is the only thing that reaches the log now.
    const plain = new LyricsHttpError(500, "secretToken" as LyricsOp);
    expect(describeLyricsError(plain)).toBe("HTTP 500");
  });

  it("gives a getter that rewrites the list nothing for its trouble", () => {
    const hostile = Object.create(LyricsHttpError.prototype) as LyricsHttpError;
    Object.defineProperty(hostile, "status", { get: () => 503 });
    Object.defineProperty(hostile, "op", {
      get: () => {
        Reflect.set(LYRICS_OPS, "0", "secretToken");
        return "secretToken";
      },
    });
    expect(describeLyricsError(hostile)).toBe("HTTP 503");
    expect(LYRICS_OPS[0]).toBe("LRCLIB /get");
  });

  it("does not consult an Array.prototype.find a getter swapped in", () => {
    // Freezing the list protects its entries, not the methods it inherits.
    const original = Array.prototype.find;
    const hostile = Object.create(LyricsHttpError.prototype) as LyricsHttpError;
    Object.defineProperty(hostile, "status", { get: () => 503 });
    Object.defineProperty(hostile, "op", {
      get: () => {
        Reflect.set(Array.prototype, "find", () => "secretToken");
        return "secretToken";
      },
    });
    try {
      expect(describeLyricsError(hostile)).toBe("HTTP 503");
    } finally {
      Reflect.set(Array.prototype, "find", original);
    }
  });

  it("names the status of a failed YouTube Music hop, nothing else", () => {
    const e = new InnerTubeHttpError("next", 503, "secretToken in the body");
    expect(describeLyricsError(e)).toBe("YouTube Music HTTP 503");
    expect(e.message).toContain("HTTP 503");
  });

  it("refuses a status that is not a real one", () => {
    expect(describeLyricsError(new LyricsHttpError(1e15, "LRCLIB /get"))).toBe(
      "http error",
    );
    expect(describeLyricsError(new LyricsHttpError(7, "LRCLIB /get"))).toBe(
      "http error",
    );
  });

  it("stays cheap on a long message", () => {
    const started = Date.now();
    describeLyricsError(new Error("x".repeat(64 * 1024)));
    expect(Date.now() - started).toBeLessThan(50);
  });
});

/**
 * The first hop of the YouTube Music lookup does not go through a lyrics
 * module at all; it is the shared InnerTube transport, so its failure has
 * to be typed at the source for the describer to name it.
 */
describe("the YouTube Music transport", () => {
  it("throws its typed error from the shared post, and the describer names it", async () => {
    await setup(() => ({ status: 503, body: "secretToken in the body" }));
    const shared = await import("@/lib/innertube/shared");
    const errors = await import("./errors");
    const err: unknown = await shared.rawNext({ videoId: "x" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(shared.InnerTubeHttpError);
    expect(errors.describeLyricsError(err)).toBe("YouTube Music HTTP 503");
    expect(errors.describeLyricsError(err)).not.toContain("secret");
  });
});
