import { describe, expect, it } from "vitest";
import { videoQualityTier } from "@/lib/video-quality-tier";

describe("videoQualityTier", () => {
  it("labels 16:9 frames by their height", () => {
    expect(videoQualityTier(1920, 1080)).toBe(1080);
    expect(videoQualityTier(3840, 2160)).toBe(2160);
    expect(videoQualityTier(854, 480)).toBe(480);
  });

  it("files a 1.9:1 4K frame under 2160p, not 2026p (W65IefaK_E0)", () => {
    expect(videoQualityTier(3840, 2026)).toBe(2160);
    expect(videoQualityTier(2560, 1350)).toBe(1440);
    expect(videoQualityTier(1920, 1012)).toBe(1080);
  });

  it("labels vertical and 4:3 frames by the box they fill", () => {
    expect(videoQualityTier(1080, 1920)).toBe(1080);
    expect(videoQualityTier(640, 480)).toBe(480);
    expect(videoQualityTier(3840, 1634)).toBe(2160);
  });

  it("keeps heights well below the ladder as they are", () => {
    expect(videoQualityTier(256, 144)).toBe(144);
    expect(videoQualityTier(426, 240)).toBe(240);
  });

  it("returns null before the frame has a size", () => {
    expect(videoQualityTier(0, 0)).toBeNull();
    expect(videoQualityTier(NaN, 1080)).toBeNull();
  });
});
