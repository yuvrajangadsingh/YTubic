import { describe, expect, it } from "vitest";
import {
  mapShelfWrapper,
  readMenuNavigation,
  splitSetCookieHeader,
  type YtNode,
} from "./shared";

// Fallback splitter for runtimes without Headers.getSetCookie. The
// tricky part is NOT splitting on the comma inside an Expires date.
describe("splitSetCookieHeader", () => {
  it("returns [] for an empty header", () => {
    expect(splitSetCookieHeader("")).toEqual([]);
  });

  it("keeps a single cookie with an Expires date intact", () => {
    const raw =
      "SIDCC=AKEy_abc123; Expires=Tue, 07 Jul 2027 18:24:08 GMT; Path=/; Domain=.youtube.com; Secure";
    expect(splitSetCookieHeader(raw)).toEqual([raw]);
  });

  it("splits two cookies joined with a comma", () => {
    const a =
      "SIDCC=AKEy_abc; Expires=Tue, 07 Jul 2027 18:24:08 GMT; Domain=.youtube.com; Path=/";
    const b =
      "LOGIN_INFO=AFmmF2s:QUQ3; Expires=Thu, 06 Jul 2028 18:24:08 GMT; Domain=.youtube.com; Path=/; Secure; HttpOnly";
    expect(splitSetCookieHeader(`${a}, ${b}`)).toEqual([a, b]);
  });

  it("handles __Secure- prefixed names after the comma", () => {
    const a = "SIDCC=v1; Domain=.youtube.com; Path=/";
    const b = "__Secure-3PSIDCC=v2; Domain=.youtube.com; Path=/; Secure";
    expect(splitSetCookieHeader(`${a}, ${b}`)).toEqual([a, b]);
  });
});

// Shelf "More" endpoint extraction — shapes observed live on artist
// pages 2026-07-12: carousels carry it in the header's moreContentButton,
// the Top-songs musicShelfRenderer in bottomEndpoint / the title run.
describe("mapShelfWrapper more endpoint", () => {
  const browse = (browseId: string, params?: string, pageType?: string) => ({
    browseEndpoint: {
      browseId,
      params,
      browseEndpointContextSupportedConfigs: {
        browseEndpointContextMusicConfig: { pageType },
      },
    },
  });

  const twoRowItem: YtNode = {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: "Album X" }] },
      navigationEndpoint: {
        browseEndpoint: {
          browseId: "MPREb_x",
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: {
              pageType: "MUSIC_PAGE_TYPE_ALBUM",
            },
          },
        },
      },
    },
  };

  it("reads moreContentButton off a carousel header", () => {
    const wrapper: YtNode = {
      musicCarouselShelfRenderer: {
        header: {
          musicCarouselShelfBasicHeaderRenderer: {
            title: { runs: [{ text: "Albums" }] },
            moreContentButton: {
              buttonRenderer: {
                navigationEndpoint: browse(
                  "MPADUC_a",
                  "ggMI",
                  "MUSIC_PAGE_TYPE_ARTIST_DISCOGRAPHY",
                ),
              },
            },
          },
        },
        contents: [twoRowItem],
      },
    };
    const { more } = mapShelfWrapper(wrapper, 0);
    expect(more).toEqual({
      browseId: "MPADUC_a",
      params: "ggMI",
      pageType: "MUSIC_PAGE_TYPE_ARTIST_DISCOGRAPHY",
    });
  });

  it("falls back to the title run's navigationEndpoint on a musicShelfRenderer", () => {
    const wrapper: YtNode = {
      musicShelfRenderer: {
        title: {
          runs: [
            {
              text: "Top songs",
              navigationEndpoint: browse(
                "VLOLAK_top",
                "ggMCCAI%3D",
                "MUSIC_PAGE_TYPE_PLAYLIST",
              ),
            },
          ],
        },
        contents: [twoRowItem],
      },
    };
    const { more } = mapShelfWrapper(wrapper, 0);
    expect(more?.browseId).toBe("VLOLAK_top");
    expect(more?.pageType).toBe("MUSIC_PAGE_TYPE_PLAYLIST");
  });

  it("returns undefined when the shelf has no more endpoint", () => {
    const wrapper: YtNode = {
      musicCarouselShelfRenderer: {
        header: {
          musicCarouselShelfBasicHeaderRenderer: {
            title: { runs: [{ text: "Fans might also like" }] },
          },
        },
        contents: [twoRowItem],
      },
    };
    expect(mapShelfWrapper(wrapper, 0).more).toBeUndefined();
  });
});

// "Go to album" lives in a row's own overflow menu, not its byline.
// Shapes below are from a live WEB_REMIX /search response (2026-08-13):
// search song rows carry ALBUM + ARTIST menu entries, while song cards on
// an artist page ship a menu with no navigation entries at all.
describe("readMenuNavigation", () => {
  const navItem = (pageType: string, browseId: string): YtNode => ({
    menuNavigationItemRenderer: {
      text: { runs: [{ text: "Go to something" }] },
      navigationEndpoint: {
        browseEndpoint: {
          browseId,
          browseEndpointContextSupportedConfigs: {
            browseEndpointContextMusicConfig: { pageType },
          },
        },
      },
    },
  });

  it("pulls the album and artist browse ids out of a row menu", () => {
    const raw: YtNode = {
      menu: {
        menuRenderer: {
          items: [
            { menuServiceItemRenderer: { text: { runs: [{ text: "Play next" }] } } },
            navItem("MUSIC_PAGE_TYPE_ALBUM", "MPREb_vun6H0AZwAa"),
            navItem("MUSIC_PAGE_TYPE_ARTIST", "UCwu0WWz0qynUrZilwyu0G5w"),
          ],
        },
      },
    };
    expect(readMenuNavigation(raw)).toEqual({
      albumId: "MPREb_vun6H0AZwAa",
      artistId: "UCwu0WWz0qynUrZilwyu0G5w",
    });
  });

  it("ignores non-album/artist navigation entries", () => {
    const raw: YtNode = {
      menu: {
        menuRenderer: {
          items: [navItem("MUSIC_PAGE_TYPE_TRACK_CREDITS", "MPTCHaSuADL62l0")],
        },
      },
    };
    expect(readMenuNavigation(raw)).toEqual({});
  });

  it("returns nothing for a menu with no navigation entries", () => {
    const raw: YtNode = {
      menu: {
        menuRenderer: {
          items: [{ menuServiceItemRenderer: { text: { runs: [{ text: "Share" }] } } }],
        },
      },
    };
    expect(readMenuNavigation(raw)).toEqual({});
  });

  it("returns nothing when the item has no menu at all", () => {
    expect(readMenuNavigation({})).toEqual({});
  });

  it("keeps the first album id when a menu somehow lists two", () => {
    const raw: YtNode = {
      menu: {
        menuRenderer: {
          items: [
            navItem("MUSIC_PAGE_TYPE_ALBUM", "MPREb_first"),
            navItem("MUSIC_PAGE_TYPE_ALBUM", "MPREb_second"),
          ],
        },
      },
    };
    expect(readMenuNavigation(raw).albumId).toBe("MPREb_first");
  });
});
