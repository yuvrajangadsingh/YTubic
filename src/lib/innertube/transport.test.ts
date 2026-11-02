import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The transport half of `innertubePost`: what it tells the log when a
 * call is slow, and what it hands the HTTP plugin. Both exist because a
 * Premium check took 76.3s on 2026-09-09 and the only record of it was
 * one elapsed number with no phase breakdown.
 */

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/app-log", () => ({ appLog: vi.fn() }));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { appLog } from "@/lib/app-log";
import { innertubePost, resetAuthCache } from "./shared";
import { fetchAccountInfo } from "./account";

const fetchMock = vi.mocked(tauriFetch);
const invokeMock = vi.mocked(invoke);
const logMock = vi.mocked(appLog);

/** A JSON response the parser will accept. */
function ok(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

/** Resolves after moving the fake clock forward, as a slow phase would. */
function afterMs<T>(ms: number, value: T) {
  return async () => {
    vi.advanceTimersByTime(ms);
    return value;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAuthCache();
  fetchMock.mockReset();
  invokeMock.mockReset();
  logMock.mockReset();
  // No jar: authHeaders returns {} and the call goes out anonymous.
  invokeMock.mockResolvedValue({ cookie: "", pageId: null });
  fetchMock.mockResolvedValue(ok());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("innertubePost connect cap", () => {
  it("hands the cap to the HTTP plugin", async () => {
    await innertubePost("account/account_menu", {}, { connectTimeoutMs: 5000 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ connectTimeout: 5000 });
  });

  it("leaves an ordinary browse uncapped", async () => {
    await innertubePost("browse", { browseId: "FEmusic_home" });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("connectTimeout");
  });

  it("caps the real account-menu caller, not just a hand-passed option", async () => {
    await fetchAccountInfo();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ connectTimeout: 5000 });
  });

  it("still caps the second call after the plugin strips the field", async () => {
    // The plugin really does `delete init.connectTimeout` before building
    // its Request, so a hoisted literal would lose the cap after one use.
    const capsSeen: unknown[] = [];
    const inits: unknown[] = [];
    fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
      const bag = init as Record<string, unknown>;
      capsSeen.push(bag.connectTimeout);
      inits.push(init);
      delete bag.connectTimeout;
      return ok();
    });
    await fetchAccountInfo();
    await fetchAccountInfo();
    expect(capsSeen).toEqual([5000, 5000]);
    expect(inits[0]).not.toBe(inits[1]);
  });
});

describe("innertubePost phase timings", () => {
  it("says nothing about a fast call", async () => {
    await innertubePost("browse", { browseId: "FEmusic_home" });
    expect(logMock).not.toHaveBeenCalled();
  });

  it("breaks a slow call into its phases", async () => {
    fetchMock.mockImplementation(afterMs(76_300, ok()));
    await innertubePost("account/account_menu", {});
    expect(logMock).toHaveBeenCalledTimes(1);
    const line = logMock.mock.calls[0][0];
    expect(line).toContain("[innertube] account/account_menu ok in 76.3s");
    expect(line).toContain("auth 0.0s fetch 76.3s");
  });

  it("blames the phase that was running when the fetch rejects", async () => {
    invokeMock.mockImplementation(afterMs(1_000, { cookie: "", pageId: null }));
    fetchMock.mockImplementation(async () => {
      vi.advanceTimersByTime(5_000);
      throw new Error("Request canceled");
    });
    await expect(innertubePost("account/account_menu", {})).rejects.toThrow(
      "Request canceled",
    );
    const line = logMock.mock.calls[0][0];
    expect(line).toContain("failed in 6.0s: auth 1.0s fetch 5.0s");
    // The bug this replaced put the whole elapsed on `body` and a
    // negative number on the phase that threw.
    expect(line).not.toMatch(/-\d/);
    expect(line).not.toContain("body");
  });

  it("blames auth when the jar read is what hangs", async () => {
    invokeMock.mockImplementation(async () => {
      vi.advanceTimersByTime(40_000);
      throw new Error("auth unavailable: keychain");
    });
    await expect(
      innertubePost("account/account_menu", {}, { auth: "required" }),
    ).rejects.toThrow();
    const line = logMock.mock.calls[0][0];
    expect(line).toContain("failed in 40.0s: auth 40.0s");
    expect(line).not.toContain("fetch");
  });

  it("reports a slow call that ended in an HTTP error", async () => {
    fetchMock.mockImplementation(async () => {
      vi.advanceTimersByTime(5_000);
      return {
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => "nope",
      } as unknown as Response;
    });
    await expect(innertubePost("account/account_menu", {})).rejects.toThrow(
      "HTTP 500",
    );
    const line = logMock.mock.calls[0][0];
    expect(line).toContain("account/account_menu failed in 5.0s");
    expect(line).toContain("fetch 5.0s");
  });
});
