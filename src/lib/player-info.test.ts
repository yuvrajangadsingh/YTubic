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
    await playerInfo("a", "acct", null);
    await playerInfo("a", "acct", null);
    expect(innertubePost).toHaveBeenCalledTimes(1);
    await playerInfo("a", "other", null);
    await playerInfo("b", "acct", null);
    expect(innertubePost).toHaveBeenCalledTimes(3);
    expect(innertubePost.mock.calls[0][2]).toEqual({
      auth: "required",
      forAccount: "acct",
    });
  });

  it("keeps a brand channel's answer to itself", async () => {
    await playerInfo("a", "acct", "page-1");
    await playerInfo("a", "acct", "page-2");
    expect(innertubePost).toHaveBeenCalledTimes(2);
  });

  it("doesn't let a late failure evict the request that replaced it", async () => {
    vi.useFakeTimers();
    let fail = (_: Error) => {};
    innertubePost.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const first = playerInfo("a", "acct", null);
    vi.advanceTimersByTime(60_000);
    await playerInfo("a", "acct", null);
    fail(new Error("late"));
    await expect(first).rejects.toThrow("late");
    await playerInfo("a", "acct", null);
    expect(innertubePost).toHaveBeenCalledTimes(2);
  });

  it("asks again after a minute and after a failure", async () => {
    vi.useFakeTimers();
    await playerInfo("a", "acct", null);
    vi.advanceTimersByTime(60_000);
    await playerInfo("a", "acct", null);
    expect(innertubePost).toHaveBeenCalledTimes(2);

    innertubePost.mockRejectedValueOnce(new Error("nope"));
    await expect(playerInfo("c", "acct", null)).rejects.toThrow("nope");
    await playerInfo("c", "acct", null);
    expect(innertubePost).toHaveBeenCalledTimes(4);
  });
});
