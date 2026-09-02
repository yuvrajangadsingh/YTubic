import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fixtures mirror responses captured from the live InnerTube API, not
 * invented shapes: the timed rows, the string-typed millisecond fields, the
 * bare-note interlude and the cueRange-less attribution row are all as YTM
 * actually sends them.
 *
 * Hop 1 (`/next`) goes through the app's shared InnerTube client and hop 2
 * (`/browse`) is a direct anonymous POST, so the two are mocked separately —
 * which is also how the tests below pin that split in place.
 */

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/innertube/shared", () => ({ rawNext: vi.fn() }));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { rawNext } from "@/lib/innertube/shared";
import { fetchYtMusicLyrics } from "./ytmusic";

const fetchMock = vi.mocked(tauriFetch);
const nextMock = vi.mocked(rawNext);

const LYRICS_BROWSE_ID = "MPLYt_4U7yfKKFZLv-1";

function tab(opts: {
  pageType?: string;
  title?: string;
  browseId?: string;
  unselectable?: boolean;
}) {
  return {
    tabRenderer: {
      title: opts.title ?? "Lyrics",
      ...(opts.unselectable === undefined
        ? {}
        : { unselectable: opts.unselectable }),
      endpoint: {
        browseEndpoint: {
          browseId: opts.browseId ?? LYRICS_BROWSE_ID,
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: {
              pageType: opts.pageType ?? "MUSIC_PAGE_TYPE_TRACK_LYRICS",
            },
          },
        },
      },
    },
  };
}

function nextResponse(tabs: unknown[]) {
  return {
    contents: {
      singleColumnMusicWatchNextResultsRenderer: {
        tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs } },
      },
    },
  };
}

const TIMED_ROWS = [
  {
    lyricLine: "♪",
    cueRange: {
      startTimeMilliseconds: "0",
      endTimeMilliseconds: "13570",
      metadata: { id: "0" },
    },
  },
  {
    lyricLine: "I've been tryna call",
    cueRange: {
      startTimeMilliseconds: "13570",
      endTimeMilliseconds: "16110",
      metadata: { id: "1" },
    },
  },
  {
    lyricLine: "I've been on my own for long enough",
    cueRange: {
      startTimeMilliseconds: "16110",
      endTimeMilliseconds: "19200",
      metadata: { id: "2" },
    },
  },
  // Attribution rides along with no cueRange.
  { lyricLine: "Source: Musixmatch" },
];

const timedBrowse = {
  contents: {
    elementRenderer: {
      newElement: {
        type: {
          componentType: {
            model: {
              timedLyricsModel: { lyricsData: { timedLyricsData: TIMED_ROWS } },
            },
          },
        },
      },
    },
  },
};

/**
 * The third shape, measured on 9 of this library's 73 tracks: a full
 * timedLyricsData block where every row carries text and NO row carries a
 * cueRange, with no description shelf anywhere in the response.
 */
const untimedBrowse = {
  contents: {
    elementRenderer: {
      newElement: {
        type: {
          componentType: {
            model: {
              timedLyricsModel: {
                lyricsData: {
                  timedLyricsData: [
                    { lyricLine: "Betha raat se" },
                    { lyricLine: "Magan mai yun gehri soch mei" },
                    { lyricLine: "♪" },
                    { lyricLine: "Kinaaray" },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
};

const plainBrowse = {
  contents: {
    sectionListRenderer: {
      contents: [
        {
          musicDescriptionShelfRenderer: {
            description: { runs: [{ text: "Yeah\n\nI've been tryna call" }] },
            footer: { runs: [{ text: "Source: Musixmatch" }] },
          },
        },
      ],
    },
  },
};

const noLyricsBrowse = {
  contents: {
    messageRenderer: { text: { runs: [{ text: "Lyrics not available" }] } },
  },
};

type BrowseCall = { url: string; body: Record<string, unknown> };
let browseCalls: BrowseCall[] = [];

function browseReturns(body: unknown, status = 200) {
  fetchMock.mockImplementation((input: unknown, init?: unknown) => {
    const raw = (init as { body?: string } | undefined)?.body;
    browseCalls.push({ url: String(input), body: raw ? JSON.parse(raw) : {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  browseCalls = [];
});

describe("YouTube Music lyrics", () => {
  it("returns line-synced lyrics with seconds, not milliseconds", async () => {
    nextMock.mockResolvedValue(nextResponse([tab({})]));
    browseReturns(timedBrowse);
    const res = await fetchYtMusicLyrics("J7p4bzqLvCw");
    expect(res).toMatchObject({ kind: "timed", source: "YouTube Music" });
    const lines = (res as { lines: { start: number; text: string }[] }).lines;
    // The attribution row has no cueRange and must not become a line at t=0.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({
      start: 13.57,
      end: 16.11,
      text: "I've been tryna call",
    });
  });

  it("blanks the bare-note interlude rather than printing it twice", async () => {
    // The view already draws its own marker for an empty line.
    nextMock.mockResolvedValue(nextResponse([tab({})]));
    browseReturns(timedBrowse);
    const res = await fetchYtMusicLyrics("J7p4bzqLvCw");
    const lines = (res as { lines: { text: string }[] }).lines;
    expect(lines[0].text).toBe("");
  });

  it("sends the mobile client on the browse hop, which unlocks the timings", async () => {
    // Load-bearing: on WEB_REMIX the very same browseId returns plain text.
    // Anyone "tidying" this into innertubePost would silently lose every
    // timing (and attach the user's cookies to a mobile client context).
    nextMock.mockResolvedValue(nextResponse([tab({})]));
    browseReturns(timedBrowse);
    await fetchYtMusicLyrics("J7p4bzqLvCw");
    expect(browseCalls).toHaveLength(1);
    expect(browseCalls[0].url).toContain("/browse");
    const client = (
      browseCalls[0].body.context as { client: { clientName: string } }
    ).client;
    expect(client.clientName).toBe("ANDROID_MUSIC");
    expect(browseCalls[0].body.browseId).toBe(LYRICS_BROWSE_ID);
  });

  it("takes the /next hop through the app's shared client", async () => {
    // Measured: WEB_REMIX and ANDROID_MUSIC return the identical browseId
    // and unselectable flag here, in ~20 KB against ~2.75 MB. So hop 1 is
    // the request the app already makes and only hop 2 is a new one.
    nextMock.mockResolvedValue(nextResponse([tab({})]));
    browseReturns(timedBrowse);
    await fetchYtMusicLyrics("J7p4bzqLvCw");
    expect(nextMock).toHaveBeenCalledWith({ videoId: "J7p4bzqLvCw" });
    expect(browseCalls.every((c) => !c.url.includes("/next"))).toBe(true);
  });

  it("stops after one request when YTM marks the tab unselectable", async () => {
    // That flag means "no lyrics for this track", so the browse hop is waste.
    nextMock.mockResolvedValue(nextResponse([tab({ unselectable: true })]));
    browseReturns(timedBrowse);
    await expect(fetchYtMusicLyrics("4NRXx6U8ABQ")).resolves.toBeNull();
    expect(browseCalls).toHaveLength(0);
  });

  it("finds the tab by page type, not by position or title", async () => {
    // Tab order and titles are layout- and locale-dependent.
    nextMock.mockResolvedValue(
      nextResponse([
        tab({ pageType: "MUSIC_PAGE_TYPE_TRACK_RELATED", title: "Up next" }),
        tab({ pageType: "MUSIC_PAGE_TYPE_TRACK_RELATED", title: "Related" }),
        tab({ title: "歌詞" }),
      ]),
    );
    browseReturns(timedBrowse);
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toMatchObject({
      kind: "timed",
    });
  });

  it("joins untimed rows instead of reporting no lyrics", async () => {
    // 9 of 73 tracks come back this way, always all-or-nothing. Dropping the
    // rows for want of a cueRange and then finding no description shelf
    // reported "no lyrics" for tracks holding complete ones.
    nextMock.mockResolvedValue(nextResponse([tab({})]));
    browseReturns(untimedBrowse);
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toEqual({
      kind: "plain",
      text: "Betha raat se\nMagan mai yun gehri soch mei\nKinaaray",
      source: "YouTube Music",
    });
  });

  it("falls back to plain text when there are no timings", async () => {
    nextMock.mockResolvedValue(nextResponse([tab({})]));
    browseReturns(plainBrowse);
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toMatchObject({
      kind: "plain",
      text: "Yeah\n\nI've been tryna call",
      source: "YouTube Music",
    });
  });

  it("treats an explicit 'not available' as an answer", async () => {
    nextMock.mockResolvedValue(nextResponse([tab({})]));
    browseReturns(noLyricsBrowse);
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toBeNull();
  });

  it("returns null when the watch page has no lyrics tab at all", async () => {
    nextMock.mockResolvedValue(
      nextResponse([tab({ pageType: "MUSIC_PAGE_TYPE_TRACK_RELATED" })]),
    );
    browseReturns(timedBrowse);
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).resolves.toBeNull();
    expect(browseCalls).toHaveLength(0);
  });

  it("asks nothing when there is no videoId", async () => {
    browseReturns(timedBrowse);
    await expect(fetchYtMusicLyrics(undefined)).resolves.toBeNull();
    expect(nextMock).not.toHaveBeenCalled();
    expect(browseCalls).toHaveLength(0);
  });

  it("throws on a server error rather than reporting no lyrics", async () => {
    // Same contract as the other three providers: a failure to look up is
    // not evidence of absence, and must not be cached as one.
    nextMock.mockResolvedValue(nextResponse([tab({})]));
    browseReturns({}, 503);
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).rejects.toThrow(
      /YouTube Music browse 503/,
    );
  });

  it("propagates a failure on the first hop too", async () => {
    nextMock.mockRejectedValue(new Error("InnerTube next → HTTP 500"));
    browseReturns(timedBrowse);
    await expect(fetchYtMusicLyrics("J7p4bzqLvCw")).rejects.toThrow(/HTTP 500/);
  });

  it("stops waiting on a stalled /next when the signal aborts", async () => {
    // rawNext takes no signal of its own, so without this a dead first hop
    // would pin the panel on "Loading lyrics…" until the track changed.
    nextMock.mockReturnValue(new Promise(() => {}));
    browseReturns(timedBrowse);
    const controller = new AbortController();
    const pending = fetchYtMusicLyrics("J7p4bzqLvCw", controller.signal);
    controller.abort(new Error("lyrics fetch timed out"));
    await expect(pending).rejects.toThrow(/timed out/);
  });
});
