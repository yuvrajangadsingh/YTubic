import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import {
  AuthIdentityMismatchError,
  innertubePost,
  resetAuthCache,
} from "./shared";

/**
 * The auth context is one shared cache, so a query keyed by account id
 * does not by itself send that account's cookies: in the gap after an
 * account switch, a refetch under the old key goes out with the new jar.
 * A caller that names the account gets refused instead, before the
 * request exists.
 */
describe("innertubePost bound to an account", () => {
  const context = (accountId: string | null) => ({
    cookie: accountId ? "SID=s; SAPISID=p" : "",
    pageId: null,
    accountId,
  });

  beforeEach(() => {
    resetAuthCache();
    vi.mocked(tauriFetch).mockReset();
    vi.mocked(invoke).mockReset();
  });

  it("refuses to send when the credentials are another account's", async () => {
    vi.mocked(invoke).mockResolvedValue(context("A"));
    await expect(
      innertubePost("account/account_menu", {}, {
        auth: "required",
        forAccount: "B",
      }),
    ).rejects.toBeInstanceOf(AuthIdentityMismatchError);
    expect(tauriFetch).not.toHaveBeenCalled();
  });

  it("refuses an anonymous context for a request bound to an account", async () => {
    vi.mocked(invoke).mockResolvedValue(context(null));
    await expect(
      innertubePost("account/account_menu", {}, { forAccount: "A" }),
    ).rejects.toBeInstanceOf(AuthIdentityMismatchError);
    expect(tauriFetch).not.toHaveBeenCalled();
  });

  it("hands the account to the cookie merge, so a late response cannot land in another jar", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "get_auth_context" ? context("A") : false,
    );
    vi.mocked(tauriFetch).mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://music.youtube.com/youtubei/v1/browse",
      headers: { getSetCookie: () => ["SIDCC=x; Domain=.youtube.com"] },
      json: async () => ({}),
    } as unknown as Response);
    await innertubePost("browse", {}, { auth: "required", forAccount: "A" });
    expect(invoke).toHaveBeenCalledWith(
      "merge_response_cookies",
      expect.objectContaining({ forAccount: "A" }),
    );
  });

  it("keeps the cookies of a request bound to no account out of every jar", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "get_auth_context" ? context(null) : false,
    );
    vi.mocked(tauriFetch).mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://music.youtube.com/youtubei/v1/browse",
      headers: { getSetCookie: () => ["YSC=x; Domain=.youtube.com"] },
      json: async () => ({}),
    } as unknown as Response);
    await innertubePost("browse", {}, { forAccount: null });
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "merge_response_cookies",
      expect.anything(),
    );
  });

  it("sends when the credentials are that account's", async () => {
    vi.mocked(invoke).mockResolvedValue(context("A"));
    vi.mocked(tauriFetch).mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      innertubePost("account/account_menu", {}, {
        auth: "required",
        forAccount: "A",
      }),
    ).resolves.toEqual({});
    expect(tauriFetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads the context once before refusing", async () => {
    // The startup dedup can remap ids without an accounts-changed event,
    // leaving a cached context older than the key that asks.
    vi.mocked(invoke)
      .mockResolvedValueOnce(context("A"))
      .mockResolvedValueOnce(context("B"));
    vi.mocked(tauriFetch).mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      innertubePost("account/account_menu", {}, {
        auth: "required",
        forAccount: "B",
      }),
    ).resolves.toEqual({});
    expect(tauriFetch).toHaveBeenCalledTimes(1);
  });

  it("does not send a bound request anonymously when the read fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("keychain locked"));
    await expect(
      innertubePost("browse", {}, { forAccount: "A" }),
    ).rejects.toThrow(/auth context unavailable/);
    expect(tauriFetch).not.toHaveBeenCalled();
  });

  it("binds to nothing when no account is named", async () => {
    vi.mocked(invoke).mockResolvedValue(context("A"));
    vi.mocked(tauriFetch).mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(innertubePost("browse", {})).resolves.toEqual({});
  });
});
