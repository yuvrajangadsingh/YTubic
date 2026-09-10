import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/app-log", () => ({ appLog: vi.fn() }));
vi.mock("@/lib/innertube/account", () => ({
  fetchAccountInfo: vi.fn(),
  fetchPremiumStatus: vi.fn(),
}));

import { fetchAccountInfo, fetchPremiumStatus } from "@/lib/innertube/account";
import { AuthIdentityMismatchError } from "@/lib/innertube/shared";
import {
  accountInfoQuery,
  describeAuthError,
  premiumStatusQuery,
} from "@/lib/store/auth-queries";

describe("accountInfoQuery", () => {
  it("is keyed by the account, waits for the id, and binds the request", async () => {
    expect(accountInfoQuery(true, "acct").queryKey).toEqual([
      "account-info",
      "acct",
    ]);
    expect(accountInfoQuery(true, undefined).enabled).toBe(false);
    vi.mocked(fetchAccountInfo).mockResolvedValueOnce(null);
    await accountInfoQuery(true, "acct").queryFn();
    expect(fetchAccountInfo).toHaveBeenLastCalledWith("acct");
    const { retry } = accountInfoQuery(true, "acct");
    expect(retry(0, new AuthIdentityMismatchError())).toBe(false);
    expect(retry(0, new Error("HTTP 503"))).toBe(true);
  });
});

describe("premiumStatusQuery", () => {
  it("is keyed by the account and waits for the id to be read", () => {
    expect(premiumStatusQuery(true, "acct").queryKey).toEqual([
      "premium-status",
      "acct",
    ]);
    expect(premiumStatusQuery(true, null).queryKey).toEqual([
      "premium-status",
      null,
    ]);
    expect(premiumStatusQuery(true, undefined).enabled).toBe(false);
    expect(premiumStatusQuery(true, null).enabled).toBe(true);
    expect(premiumStatusQuery(false, "acct").enabled).toBe(false);
  });

  it("asks for the answer bound to the account in its key", async () => {
    vi.mocked(fetchPremiumStatus).mockResolvedValueOnce("premium");
    await premiumStatusQuery(true, "acct").queryFn();
    expect(fetchPremiumStatus).toHaveBeenLastCalledWith("acct");
    vi.mocked(fetchPremiumStatus).mockResolvedValueOnce("premium");
    await premiumStatusQuery(true, null).queryFn();
    expect(fetchPremiumStatus).toHaveBeenLastCalledWith(null);
  });

  it("does not retry a request refused for naming another account", () => {
    const { retry } = premiumStatusQuery(true, "acct");
    expect(retry(0, new AuthIdentityMismatchError())).toBe(false);
    expect(retry(0, new Error("HTTP 503"))).toBe(true);
    expect(retry(3, new Error("HTTP 503"))).toBe(false);
  });

  it("passes a real verdict through", async () => {
    vi.mocked(fetchPremiumStatus).mockResolvedValueOnce("premium");
    await expect(premiumStatusQuery(true, "acct").queryFn()).resolves.toBe(
      "premium",
    );
    vi.mocked(fetchPremiumStatus).mockResolvedValueOnce("free");
    await expect(premiumStatusQuery(true, "acct").queryFn()).resolves.toBe(
      "free",
    );
  });

  // The query only runs once the jar is known to be signed in, so an
  // anonymous menu is a request that was not honoured, not a verdict.
  // Caching it as a success is what kept the gate on "Checking…" for a
  // check that had already finished.
  it("treats a signed-out answer as a failed check, not a verdict", async () => {
    vi.mocked(fetchPremiumStatus).mockResolvedValueOnce(null);
    await expect(premiumStatusQuery(true, "acct").queryFn()).rejects.toThrow(
      /signed out/,
    );
  });
});

describe("describeAuthError", () => {
  it("keeps the endpoint and status and drops the response body", () => {
    const e = new Error(
      'InnerTube account/account_menu → HTTP 401: {"error":{"message":"token=abc\\nmore"}}',
    );
    expect(describeAuthError(e)).toBe(
      "InnerTube account/account_menu → HTTP 401",
    );
  });

  // A 200 that is not JSON (captive portal, proxy error page) fails in
  // res.json(), and both engines quote the offending text in that error.
  it("never quotes a body that failed to parse", () => {
    const body = "secretToken123";
    let native: unknown;
    try {
      JSON.parse(body);
    } catch (e) {
      native = e;
    }
    expect(describeAuthError(native)).toBe("response was not JSON");
    // Same message shape from another realm, no SyntaxError identity.
    const webkit = new Error(
      `JSON Parse error: Unexpected identifier "${body}"`,
    );
    expect(describeAuthError(webkit)).toBe("response was not JSON");
    expect(describeAuthError(webkit)).not.toContain(body);
  });

  it("flattens and bounds anything else", () => {
    const e = new Error(`auth context unavailable:\n${"x".repeat(500)}`);
    const out = describeAuthError(e);
    expect(out).not.toContain("\n");
    expect(out.length).toBe(200);
    expect(describeAuthError("plain string")).toBe("plain string");
  });
});
