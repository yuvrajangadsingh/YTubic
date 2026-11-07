import { beforeEach, describe, expect, it, vi } from "vitest";

const innertubePost = vi.fn();
vi.mock("@/lib/innertube/shared", () => ({ innertubePost }));
const { clearPlayerInfo, playerInfo } = await import("./player-info");

describe("playerInfo", () => {
  beforeEach(() => {
    clearPlayerInfo();
    innertubePost.mockReset();
    innertubePost.mockResolvedValue({ ok: true });
    vi.useRealTimers();
  });

  it("asks once per track and account", async () => {
    await playerInfo("a", "acct");
    await playerInfo("a", "acct");
    expect(innertubePost).toHaveBeenCalledTimes(1);
    await playerInfo("a", "other");
    await playerInfo("b", "acct");
    expect(innertubePost).toHaveBeenCalledTimes(3);
    expect(innertubePost.mock.calls[0][2]).toEqual({
      auth: "required",
      forAccount: "acct",
    });
  });

  it("asks again after a minute and after a failure", async () => {
    vi.useFakeTimers();
    await playerInfo("a", "acct");
    vi.advanceTimersByTime(60_000);
    await playerInfo("a", "acct");
    expect(innertubePost).toHaveBeenCalledTimes(2);

    innertubePost.mockRejectedValueOnce(new Error("nope"));
    await expect(playerInfo("c", "acct")).rejects.toThrow("nope");
    await playerInfo("c", "acct");
    expect(innertubePost).toHaveBeenCalledTimes(4);
  });
});
