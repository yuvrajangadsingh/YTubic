import { describe, expect, it } from "vitest";
import {
  effectiveVideoQuality,
  isQualityCapped,
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
