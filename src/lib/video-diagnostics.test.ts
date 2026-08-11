import { describe, expect, it } from "vitest";
import {
  effectiveVideoQuality,
  isQualityCapped,
  mediaErrorFailure,
  watchdogVerdict,
  VIDEO_PHASE_BUDGET,
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
  const transport = VIDEO_PHASE_BUDGET.transport;
  const decode = VIDEO_PHASE_BUDGET.decode;

  it("lets a healthy attempt run", () => {
    expect(
      watchdogVerdict({
        nowMs: 5_000,
        phaseStartedAtMs: 0,
        lastProgressMs: 4_800,
        phase: "transport",
      }),
    ).toBeNull();
  });

  // The server withholds the whole HTTP response until the file has
  // finished downloading, so during transport the frontend observes no
  // buffered growth, no readyState change and no byte events. Silence is
  // the NORMAL case here, not evidence of death — a stall rule on this
  // phase would cancel every cold download that ran long.
  it("never fails transport for silence alone", () => {
    expect(transport.noProgressMs).toBeUndefined();
    expect(
      watchdogVerdict({
        nowMs: transport.absoluteMs - 1,
        phaseStartedAtMs: 0,
        lastProgressMs: 0, // nothing has moved since the very beginning
        phase: "transport",
      }),
    ).toBeNull();
  });

  it("gives transport up only at its deadline, and names the phase", () => {
    const v = watchdogVerdict({
      nowMs: transport.absoluteMs,
      phaseStartedAtMs: 0,
      lastProgressMs: 0,
      phase: "transport",
    });
    expect(v?.phase).toBe("transport");
    expect(v?.reason).toContain("gave up after");
    expect(v?.reason).toContain("downloading");
    expect(v?.reason).not.toContain("decod");
  });

  // Decode is the one phase where media events genuinely fire, so here
  // silence really is evidence.
  it("does fail decode for silence, before its deadline", () => {
    expect(decode.noProgressMs).toBeDefined();
    const v = watchdogVerdict({
      nowMs: decode.noProgressMs!,
      phaseStartedAtMs: 0,
      lastProgressMs: 0,
      phase: "decode",
    });
    expect(v?.phase).toBe("decode");
    expect(v?.reason).toContain("stalled");
  });

  it("keeps waiting in decode while progress keeps arriving", () => {
    expect(
      watchdogVerdict({
        nowMs: decode.absoluteMs - 1,
        phaseStartedAtMs: 0,
        lastProgressMs: decode.absoluteMs - 1_000,
        phase: "decode",
      }),
    ).toBeNull();
  });

  it("reports the resolve phase when no URL was ever produced", () => {
    const v = watchdogVerdict({
      nowMs: VIDEO_PHASE_BUDGET.resolving.absoluteMs,
      phaseStartedAtMs: 0,
      lastProgressMs: 0,
      phase: "resolving",
    });
    expect(v?.phase).toBe("resolving");
    expect(v?.reason).toContain("resolving the stream");
  });
});
