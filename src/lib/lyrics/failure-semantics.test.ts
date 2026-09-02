import { beforeEach, describe, expect, it, vi } from "vitest";
import { LyricsRateLimitError, shouldRetryLyricsQuery } from "./errors";

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
 * Genius and Musixmatch both did this, on transport errors AND on plain HTTP
 * errors. LRCLIB already had the right contract and is the control here.
 *
 * The other half of the rule matters just as much: a 404 and an empty result
 * set are real answers and must stay `null`, or every track without lyrics
 * would retry forever.
 */

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

type Route = (url: string) => { status?: number; body?: unknown } | "reject";

/**
 * Fresh module registry per case: Musixmatch caches its session token in
 * module state, so without this the second test in a file would silently
 * skip token.get and stop exercising the path under test.
 */
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
  const genius = await import("./genius");
  const musixmatch = await import("./musixmatch");
  const lrclib = await import("./lrclib");
  const errors = await import("./errors");
  return {
    ...genius,
    ...musixmatch,
    ...lrclib,
    RateLimit: errors.LyricsRateLimitError,
  };
}

const TRACK = { title: "Bohemian Rhapsody", artist: "Queen" };

const geniusHit = {
  response: {
    hits: [
      {
        type: "song",
        result: {
          url: "https://genius.com/Queen-bohemian-rhapsody-lyrics",
          title: "Bohemian Rhapsody",
          primary_artist: { name: "Queen" },
          lyrics_state: "complete",
        },
      },
    ],
  },
};

const mxmToken = { message: { body: { user_token: "a-real-looking-token" } } };

beforeEach(() => vi.clearAllMocks());

describe("a transport failure is not 'no lyrics'", () => {
  it("Genius throws instead of resolving null", async () => {
    const { fetchGeniusLyrics } = await setup(() => "reject");
    await expect(fetchGeniusLyrics(TRACK)).rejects.toThrow(/Network request/);
  });

  it("Musixmatch throws instead of resolving null", async () => {
    const { fetchMusixmatchLyrics } = await setup(() => "reject");
    await expect(fetchMusixmatchLyrics(TRACK)).rejects.toThrow(
      /Network request/,
    );
  });

  it("LRCLIB already did (the control)", async () => {
    const { fetchLrclibLyrics } = await setup(() => "reject");
    await expect(fetchLrclibLyrics(TRACK)).rejects.toThrow(/Network request/);
  });
});

describe("an HTTP error is not 'no lyrics' either", () => {
  it("Genius throws on a 503 from the search endpoint", async () => {
    const { fetchGeniusLyrics } = await setup(() => ({ status: 503 }));
    await expect(fetchGeniusLyrics(TRACK)).rejects.toThrow(/Genius search 503/);
  });

  it("Genius throws on a 503 from the song page", async () => {
    const { fetchGeniusLyrics } = await setup((url) =>
      url.includes("/api/search")
        ? { body: geniusHit }
        : { status: 503, body: "" },
    );
    await expect(fetchGeniusLyrics(TRACK)).rejects.toThrow(/Genius page 503/);
  });

  it("Musixmatch throws on a 503 from token.get", async () => {
    const { fetchMusixmatchLyrics } = await setup(() => ({ status: 503 }));
    await expect(fetchMusixmatchLyrics(TRACK)).rejects.toThrow(
      /Musixmatch token\.get 503/,
    );
  });

  it("Musixmatch throws on a 503 from track.search", async () => {
    const { fetchMusixmatchLyrics } = await setup((url) =>
      url.includes("token.get") ? { body: mxmToken } : { status: 503 },
    );
    await expect(fetchMusixmatchLyrics(TRACK)).rejects.toThrow(
      /Musixmatch track\.search 503/,
    );
  });
});

describe("a refusal is not 'no lyrics', and must not be retried at once", () => {
  it("Musixmatch's UpgradeOnly token is a rate limit", async () => {
    // The token shape looks valid but every later call 401s. Returning null
    // wrote a gated IP to disk as a permanent absence of lyrics.
    const { fetchMusixmatchLyrics, RateLimit } = await setup(() => ({
      body: { message: { body: { user_token: "UpgradeOnlyUpgradeOnly" } } },
    }));
    await expect(fetchMusixmatchLyrics(TRACK)).rejects.toBeInstanceOf(
      RateLimit,
    );
  });

  it("Musixmatch rejecting a fresh token twice is a rate limit", async () => {
    const { fetchMusixmatchLyrics, RateLimit } = await setup((url) =>
      url.includes("token.get") ? { body: mxmToken } : { status: 401 },
    );
    await expect(fetchMusixmatchLyrics(TRACK)).rejects.toBeInstanceOf(
      RateLimit,
    );
  });

  it("a 429 is a rate limit, not a plain error", async () => {
    const { fetchGeniusLyrics, RateLimit } = await setup(() => ({
      status: 429,
    }));
    await expect(fetchGeniusLyrics(TRACK)).rejects.toBeInstanceOf(RateLimit);
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
  it("Genius returns null when no hit matches the request", async () => {
    const { fetchGeniusLyrics } = await setup(() => ({
      body: { response: { hits: [] } },
    }));
    await expect(fetchGeniusLyrics(TRACK)).resolves.toBeNull();
  });

  it("Genius returns null when the song page is gone (404)", async () => {
    const { fetchGeniusLyrics } = await setup((url) =>
      url.includes("/api/search")
        ? { body: geniusHit }
        : { status: 404, body: "" },
    );
    await expect(fetchGeniusLyrics(TRACK)).resolves.toBeNull();
  });

  it("Musixmatch returns null for an empty result set", async () => {
    const { fetchMusixmatchLyrics } = await setup((url) =>
      url.includes("token.get")
        ? { body: mxmToken }
        : { body: { message: { body: { track_list: [] } } } },
    );
    await expect(fetchMusixmatchLyrics(TRACK)).resolves.toBeNull();
  });

  it("LRCLIB returns null for a 404 plus an empty search", async () => {
    const { fetchLrclibLyrics } = await setup((url) =>
      url.includes("/api/get") ? { status: 404 } : { body: [] },
    );
    await expect(fetchLrclibLyrics(TRACK)).resolves.toBeNull();
  });
});
