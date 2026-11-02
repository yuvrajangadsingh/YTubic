import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { pushNotchEnabled } from "@/lib/notch";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("pushNotchEnabled", () => {
  it("names the command and the flag Rust expects", () => {
    pushNotchEnabled(true);
    expect(invoke).toHaveBeenLastCalledWith("notch_set_enabled", {
      enabled: true,
    });
    pushNotchEnabled(false);
    expect(invoke).toHaveBeenLastCalledWith("notch_set_enabled", {
      enabled: false,
    });
  });

  it("swallows a rejected push instead of leaving it unhandled", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("no backend"));
    expect(() => pushNotchEnabled(true)).not.toThrow();
    await Promise.resolve();
  });
});
