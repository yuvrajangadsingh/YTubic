import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-log", () => ({ appLog: vi.fn() }));
vi.mock("@/lib/player-info", () => ({ playerInfo: vi.fn() }));
vi.mock("@/lib/store/accounts", () => ({ useAccounts: vi.fn() }));
vi.mock("@/lib/store/settings", () => ({ useSettingsStore: vi.fn() }));

const { loudnessGain } = await import("./loudness");

describe("loudnessGain", () => {
  // The values YouTube returned on Nov 6 for these tracks.
  it("turns a loud track down to the target", () => {
    const loon = { loudnessDb: -2.5100002, loudnessTargetLkfs: -7 };
    expect(loudnessGain(loon)).toBeCloseTo(10 ** (-4.49 / 20), 3);
    expect(loudnessGain({ loudnessDb: -0.58 })).toBeCloseTo(
      10 ** (-6.42 / 20),
      3,
    );
  });

  it("leaves a track at or below the target alone", () => {
    expect(loudnessGain({ loudnessDb: -7.22, loudnessTargetLkfs: -7 })).toBe(1);
  });

  it("is 1 when YouTube gave no measurement", () => {
    expect(loudnessGain(undefined)).toBe(1);
    expect(loudnessGain({})).toBe(1);
    expect(loudnessGain({ loudnessDb: "loud" })).toBe(1);
  });
});
