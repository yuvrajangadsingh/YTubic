import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const appLog = vi.fn();
const authHeaders = vi.fn();
const captureSetCookies = vi.fn();
const innertubePost = vi.fn();
class InnerTubeHttpError extends Error {
  status = 403;
}
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@/lib/app-log", () => ({ appLog }));
// The playback store, as far as the listen counter uses it.
type Playback = {
  index: number;
  queue: { videoId: string }[];
  position: number;
  duration: number;
  playing: boolean;
  pendingSeek?: number;
};
const subs = new Set<(s: Playback, prev: Playback) => void>();
let playback: Playback;
const setPlayback = (patch: Partial<Playback>) => {
  const prev = playback;
  playback = { ...playback, ...patch };
  subs.forEach((fn) => fn(playback, prev));
};
vi.mock("@/lib/store/accounts", () => ({ useAccounts: vi.fn() }));
vi.mock("@/lib/store/cast", () => ({ useCastStore: vi.fn() }));
vi.mock("@/lib/store/playback", () => ({
  usePlaybackStore: {
    getState: () => playback,
    subscribe: (fn: (s: Playback, prev: Playback) => void) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  },
}));
vi.mock("@/lib/store/track-source", () => ({
  resolveStreamId: vi.fn(),
  useTrackSourceStore: vi.fn(),
}));
vi.mock("@/lib/innertube/shared", () => ({
  BASE_HEADERS: { Origin: "https://music.youtube.com" },
  InnerTubeHttpError,
  authHeaders,
  captureSetCookies,
  innertubePost,
}));

const { heardBetween, newCpn, playbackPingUrl, reportListen, watchListen } =
  await import("./yt-history");

const BASE = "https://s.youtube.com/api/stats/playback?cl=1&docid=abc&fexp=1,2";
const playerWith = (baseUrl: unknown) => ({
  playbackTracking: { videostatsPlaybackUrl: { baseUrl } },
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ status: 204 });
  authHeaders.mockResolvedValue({ Authorization: "SAPISIDHASH x" });
  innertubePost.mockResolvedValue(playerWith(BASE));
});

describe("playbackPingUrl", () => {
  it("appends the client fields and leaves the rest of the url alone", () => {
    expect(playbackPingUrl(BASE, "CPN")).toBe(
      `${BASE}&ver=2&c=WEB_REMIX&cpn=CPN`,
    );
  });

  it("refuses anything that is not a plain https youtube url", () => {
    for (const bad of [
      "http://s.youtube.com/api/stats/playback?x=1",
      "https://s.youtube.com.evil.example/api/stats/playback?x=1",
      "https://youtube.com@evil.example/api/stats/playback?x=1",
      "https://notyoutube.com/api/stats/playback?x=1",
      "https://s.youtube.com/api/stats/playback?x=1#frag",
      "not a url",
      undefined,
    ]) {
      expect(playbackPingUrl(bad, "CPN")).toBeNull();
    }
  });
});

describe("newCpn", () => {
  it("is 16 url-safe characters", () => {
    expect(newCpn()).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});

describe("heardBetween", () => {
  it("counts the progress when the position kept pace with the clock", () => {
    expect(heardBetween(1, 1)).toBe(1);
    // A hidden window, one sample in six seconds.
    expect(heardBetween(6, 6)).toBe(6);
    // A receiver's report running a little ahead of the clock.
    expect(heardBetween(2, 1.9)).toBe(1.9);
  });

  it("counts only the part of a sample that played", () => {
    expect(heardBetween(0.3, 1)).toBe(0.3);
    expect(heardBetween(16, 30)).toBe(16);
  });

  it("counts nothing for a stall, a seek or a track change", () => {
    expect(heardBetween(0, 1)).toBe(0);
    expect(heardBetween(5, 1)).toBe(0);
    expect(heardBetween(85, 1)).toBe(0);
    expect(heardBetween(-94.6, 1)).toBe(0);
  });
});

describe("watchListen", () => {
  const onListen = vi.fn();
  // `count` position samples, `step` seconds of clock and of playback each.
  const play = (count: number, step: number, moved = step) => {
    for (let i = 0; i < count; i++) {
      vi.setSystemTime(Date.now() + step * 1000);
      setPlayback({ position: playback.position + moved });
    }
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    subs.clear();
    playback = {
      index: 0,
      queue: [{ videoId: "a" }, { videoId: "b" }],
      position: 0,
      duration: 200,
      playing: true,
    };
  });
  afterEach(() => vi.useRealTimers());

  it("fires once, after 30 s at the local element's four samples a second", () => {
    watchListen(onListen);
    play(119, 0.25);
    expect(onListen).not.toHaveBeenCalled();
    play(1, 0.25);
    expect(onListen).toHaveBeenCalledTimes(1);
    play(200, 0.25);
    expect(onListen).toHaveBeenCalledTimes(1);
  });

  it("counts a cast receiver's slower samples in full", () => {
    watchListen(onListen);
    play(14, 2);
    expect(onListen).not.toHaveBeenCalled();
    play(1, 2);
    expect(onListen).toHaveBeenCalledTimes(1);
  });

  it("counts half of a track shorter than a minute", () => {
    playback.duration = 20;
    watchListen(onListen);
    play(39, 0.25);
    expect(onListen).not.toHaveBeenCalled();
    play(1, 0.25);
    expect(onListen).toHaveBeenCalledTimes(1);
  });

  it("does not count the stalled part of 30 s", () => {
    watchListen(onListen);
    play(30, 1, 0.5);
    expect(onListen).not.toHaveBeenCalled();
  });

  it("earns nothing from seeks, however small", () => {
    watchListen(onListen);
    for (let i = 0; i < 200; i++) {
      vi.setSystemTime(Date.now() + 250);
      const target = playback.position + 0.75;
      setPlayback({ position: target, pendingSeek: target });
      setPlayback({ pendingSeek: undefined });
    }
    expect(onListen).not.toHaveBeenCalled();
  });

  it("earns nothing from a seek repeated before the first one was applied", () => {
    watchListen(onListen);
    play(119, 0.25);
    setPlayback({ position: 30.5, pendingSeek: 30.5 });
    // The old element reports once more, then the same seek again.
    vi.setSystemTime(Date.now() + 250);
    setPlayback({ position: 29.75 });
    vi.setSystemTime(Date.now() + 250);
    setPlayback({ position: 30.5, pendingSeek: 30.5 });
    expect(onListen).not.toHaveBeenCalled();
  });

  it("earns nothing from a seek that completes after a long stall", () => {
    watchListen(onListen);
    play(4, 0.25);
    setPlayback({ position: 40, pendingSeek: 40 });
    // The old element reports once more before the engine applies the seek.
    vi.setSystemTime(Date.now() + 250);
    setPlayback({ position: 1.25 });
    setPlayback({ pendingSeek: undefined });
    vi.setSystemTime(Date.now() + 40_000);
    setPlayback({ position: 40 });
    expect(onListen).not.toHaveBeenCalled();
    // And the count carries on from there.
    play(115, 0.25);
    expect(onListen).not.toHaveBeenCalled();
    play(1, 0.25);
    expect(onListen).toHaveBeenCalledTimes(1);
  });

  it("never reports the track being left when a short one takes the slot", () => {
    watchListen(onListen);
    play(40, 0.25);
    // next(): one update with the new slot, position 0 and its duration.
    setPlayback({ index: 1, position: 0, duration: 20 });
    play(200, 0.25);
    expect(onListen).not.toHaveBeenCalled();
    expect(subs.size).toBe(0);
  });

  it("gives up when the queue is replaced under the same slot", () => {
    watchListen(onListen);
    play(40, 0.25);
    setPlayback({ queue: [{ videoId: "c" }], position: 0, duration: 20 });
    expect(onListen).not.toHaveBeenCalled();
    expect(subs.size).toBe(0);
  });

  it("earns nothing while paused, and nothing for the pause itself", () => {
    watchListen(onListen);
    play(60, 0.25);
    setPlayback({ playing: false });
    play(100, 1);
    vi.setSystemTime(Date.now() + 3_600_000);
    setPlayback({ playing: true });
    play(59, 0.25);
    expect(onListen).not.toHaveBeenCalled();
    play(1, 0.25);
    expect(onListen).toHaveBeenCalledTimes(1);
  });

  it("stops counting once unsubscribed", () => {
    watchListen(onListen)();
    play(200, 0.25);
    expect(onListen).not.toHaveBeenCalled();
  });
});

describe("reportListen", () => {
  it("sends one signed GET to the url the player response names", async () => {
    const res = { status: 204 };
    fetchMock.mockResolvedValue(res);
    await reportListen("vid1", "acct", null);
    expect(innertubePost).toHaveBeenCalledWith(
      "player",
      expect.objectContaining({ videoId: "vid1" }),
      { auth: "required", forAccount: "acct" },
    );
    expect(authHeaders).toHaveBeenCalledWith("required", "acct");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(
      /^https:\/\/s\.youtube\.com\/api\/stats\/playback\?cl=1&docid=abc&fexp=1,2&ver=2&c=WEB_REMIX&cpn=[A-Za-z0-9_-]{16}$/,
    );
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("SAPISIDHASH x");
    expect(captureSetCookies).toHaveBeenCalledWith(res, "acct");
  });

  it("sends the credentials read after the player call, not the ones before it", async () => {
    authHeaders
      .mockResolvedValueOnce({ Authorization: "SAPISIDHASH old" })
      .mockResolvedValueOnce({ Authorization: "SAPISIDHASH rotated" });
    await reportListen("vid1", "acct", null);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "SAPISIDHASH rotated",
    );
  });

  it("reports as the brand channel that listened", async () => {
    authHeaders.mockResolvedValue({
      Authorization: "a",
      "X-Goog-PageId": "page-1",
    });
    await reportListen("vid1", "acct", "page-1");
    expect(fetchMock.mock.calls[0][1].headers["X-Goog-PageId"]).toBe("page-1");
  });

  it("sends nothing at all as a channel that did not listen", async () => {
    authHeaders.mockResolvedValue({
      Authorization: "a",
      "X-Goog-PageId": "page-2",
    });
    await reportListen("vid1", "acct", "page-1");
    await reportListen("vid1", "acct", null);
    expect(innertubePost).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops before the GET when the brand channel changed under it", async () => {
    authHeaders
      .mockResolvedValueOnce({ Authorization: "a", "X-Goog-PageId": "page-1" })
      .mockResolvedValueOnce({ Authorization: "a", "X-Goog-PageId": "page-2" });
    await reportListen("vid1", "acct", "page-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing at all when the account that listened is not the active one", async () => {
    authHeaders.mockRejectedValue(new Error("identity mismatch"));
    await reportListen("vid1", "acct", null);
    expect(innertubePost).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops before the GET when the account changed under it", async () => {
    authHeaders
      .mockResolvedValueOnce({ Authorization: "a" })
      .mockRejectedValueOnce(new Error("identity mismatch"));
    await reportListen("vid1", "acct", null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends the cookies to a host that is not youtube", async () => {
    innertubePost.mockResolvedValue(playerWith("https://evil.example/p?x=1"));
    await reportListen("vid1", "acct", null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the url out of the log when the request fails", async () => {
    fetchMock.mockRejectedValue(`error sending request for url (${BASE})`);
    await reportListen("vid1", "acct", null);
    expect(appLog).toHaveBeenCalledWith(
      "[history] vid1 failed: request failed",
    );
  });
});
