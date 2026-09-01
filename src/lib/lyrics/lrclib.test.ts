import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The LRCLIB fallback for re-uploads that hide the artist in the title.
 * These tests are about WHEN it fires, which is the part that can do harm:
 * as a primary reading it would send "Numb - Encore" by Jay-Z looking for
 * "Encore" by "Numb", and LRCLIB really does hold rows credited to "Numb".
 */

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { fetchLrclibLyrics } from "./lrclib";

const fetchMock = vi.mocked(tauriFetch);

type Query = { endpoint: "get" | "search"; track: string; artist: string };
let queries: Query[] = [];

const SYNCED = "[00:12.34]Жить как я живу\n[00:16.00]Второй куплет";

/** Answers /search with `records` and 404s every /get. */
function searchReturns(records: (q: Query) => unknown[]) {
  fetchMock.mockImplementation((input: unknown) => {
    const url = new URL(String(input));
    const q: Query = {
      endpoint: url.pathname.endsWith("/get") ? "get" : "search",
      track: url.searchParams.get("track_name") ?? "",
      artist: url.searchParams.get("artist_name") ?? "",
    };
    queries.push(q);
    if (q.endpoint === "get") {
      return Promise.resolve(new Response("", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(records(q)), { status: 200 }),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queries = [];
});

describe("re-upload re-attribution", () => {
  it("never runs when the ordinary reading already answered", async () => {
    // "Numb - Encore" by Jay-Z is the case that makes this a fallback and
    // not a rule: the split is available (Jay-Z is nowhere in the title) and
    // taking it would go looking for "Encore" by "Numb", which LRCLIB really
    // does hold rows for. The first reading answers, so it never gets asked.
    searchReturns(() => [
      {
        id: 1,
        trackName: "Numb - Encore",
        artistName: "Jay-Z",
        duration: 205,
        syncedLyrics: "[00:10.00]Can you feel that",
      },
    ]);
    const res = await fetchLrclibLyrics({
      title: "Numb - Encore",
      artist: "Jay-Z",
    });
    expect(res).toMatchObject({ kind: "timed" });
    expect(queries.filter((q) => q.endpoint === "search")).toHaveLength(1);
  });

  it("retries with the swapped pair once the ordinary one comes back empty", async () => {
    searchReturns((q) =>
      q.artist === "Скриптонит"
        ? [
            {
              id: 2,
              trackName: "Жить как я живу",
              artistName: "Скриптонит",
              duration: 180,
              syncedLyrics: SYNCED,
            },
          ]
        : [],
    );
    const res = await fetchLrclibLyrics({
      title: "Скриптонит - Жить как я живу",
      artist: "Skrypto gramma",
    });
    expect(res).toMatchObject({ kind: "timed", source: "LRCLIB" });

    const searches = queries.filter((q) => q.endpoint === "search");
    expect(searches).toHaveLength(2);
    // First the reading we were handed, then the inverted one.
    expect(searches[0]).toMatchObject({
      track: "Скриптонит - Жить как я живу",
      artist: "Skrypto gramma",
    });
    expect(searches[1]).toMatchObject({
      track: "Жить как я живу",
      artist: "Скриптонит",
    });
  });

  it("does not retry when the credited artist is already in the title", async () => {
    // Two of this library's four "Artist - Title" rows look like this.
    searchReturns(() => []);
    await expect(
      fetchLrclibLyrics({
        title: "Hasan Raheem - Fana ft Jj47 | Prod by Abdullah Kasumbi",
        artist: "Hasan Raheem",
      }),
    ).resolves.toBeNull();
    expect(queries.filter((q) => q.endpoint === "search")).toHaveLength(1);
  });

  it("does not retry a title that is not a two-part split", async () => {
    searchReturns(() => []);
    await expect(
      fetchLrclibLyrics({ title: "Blinding Lights", artist: "The Weeknd" }),
    ).resolves.toBeNull();
    expect(queries.filter((q) => q.endpoint === "search")).toHaveLength(1);
  });

  it("propagates a transport failure instead of retrying around it", async () => {
    // A failed lookup is not an empty one; retrying with a guessed split
    // would turn one outage into two requests and a cached miss.
    fetchMock.mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    await expect(
      fetchLrclibLyrics({
        title: "Скриптонит - Жить как я живу",
        artist: "Skrypto gramma",
      }),
    ).rejects.toThrow(/Network request/);
  });
});
