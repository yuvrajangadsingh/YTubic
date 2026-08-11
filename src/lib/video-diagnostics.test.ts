import { describe, expect, it } from "vitest";
import {
  effectiveVideoQuality,
  isQualityCapped,
  mediaErrorFailure,
  watchdogVerdict,
  VIDEO_ABSOLUTE_MS,
  VIDEO_NO_PROGRESS_MS,
  VIDEO_QUALITY_CEILING,
} from "./video-diagnostics";

describe("effectiveVideoQuality", () => {
  it("clamps the tiers WebKit cannot range-stream", () => {
    expect(effectiveVideoQuality(2160)).toBe(VIDEO_QUALITY_CEILING);
    expect(effectiveVideoQuality(1440)).toBe(VIDEO_QUALITY_CEILING);
  });

  it("leaves playable tiers alone", () => {
    expect(effectiveVideoQuality(1080)).toBe(1080);
    expect(effectiveVideoQuality(720)).toBe(720);
    expect(effectiveVideoQuality(360)).toBe(360);
  });

  it("flags only the capped tiers", () => {
    expect(isQualityCapped(2160)).toBe(true);
    expect(isQualityCapped(1440)).toBe(true);
    expect(isQualityCapped(1080)).toBe(false);
    expect(isQualityCapped(480)).toBe(false);
  });
});

describe("mediaErrorFailure", () => {
  it("maps the four standard codes to a phase", () => {
    expect(mediaErrorFailure({ code: 1 }).phase).toBe("transport");
    expect(mediaErrorFailure({ code: 2 }).phase).toBe("transport");
    expect(mediaErrorFailure({ code: 3 }).phase).toBe("decode");
    expect(mediaErrorFailure({ code: 4 }).phase).toBe("decode");
  });

  it("keeps the element's own message", () => {
    const f = mediaErrorFailure({ code: 4, message: "unsupported codec" });
    expect(f.reason).toContain("unsupported codec");
  });

  it("never claims a codec problem when the element reported nothing", () => {
    const f = mediaErrorFailure(null);
    expect(f.reason).toBe(
      "video element failed without reporting an error",
    );
  });

  it("does not invent a message from an empty one", () => {
    expect(mediaErrorFailure({ code: 2, message: "   " }).reason).toBe(
      "network error while fetching the video",
    );
  });
});

describe("watchdogVerdict", () => {
  const base = { startedAtMs: 0, lastProgressMs: 0, phase: "transport" as const };

  it("lets a healthy attempt run", () => {
    expect(
      watchdogVerdict({ ...base, nowMs: 5_000, lastProgressMs: 4_800 }),
    ).toBeNull();
  });

  it("gives up when nothing has moved for the no-progress window", () => {
    const v = watchdogVerdict({
      ...base,
      nowMs: VIDEO_NO_PROGRESS_MS,
      lastProgressMs: 0,
    });
    expect(v?.phase).toBe("transport");
    expect(v?.reason).toContain("no progress");
  });

  it("keeps waiting while progress keeps arriving, up to the hard cap", () => {
    // Steady progress: a long but healthy download is not a failure...
    expect(
      watchdogVerdict({
        ...base,
        nowMs: VIDEO_ABSOLUTE_MS - 1,
        lastProgressMs: VIDEO_ABSOLUTE_MS - 1_000,
      }),
    ).toBeNull();
    // ...until it has simply taken too long overall.
    const v = watchdogVerdict({
      ...base,
      nowMs: VIDEO_ABSOLUTE_MS,
      lastProgressMs: VIDEO_ABSOLUTE_MS - 1_000,
    });
    expect(v?.reason).toContain("gave up after");
  });

  it("names the phase it timed out in, never the decoder", () => {
    const v = watchdogVerdict({
      nowMs: VIDEO_NO_PROGRESS_MS,
      startedAtMs: 0,
      lastProgressMs: 0,
      phase: "transport",
    });
    expect(v?.reason).toContain("downloading");
    expect(v?.reason).not.toContain("decod");
  });

  it("reports the resolve phase when it never got as far as a URL", () => {
    const v = watchdogVerdict({
      nowMs: VIDEO_NO_PROGRESS_MS,
      startedAtMs: 0,
      lastProgressMs: 0,
      phase: "resolving",
    });
    expect(v?.phase).toBe("resolving");
    expect(v?.reason).toContain("resolving the stream");
  });
});
