import { describe, expect, it } from "vitest";
import {
  accountSlot,
  credentialState,
  liveAccountState,
  type AccountSlotInput,
} from "./auth-presence";

// The signed-in steady state: Rust says the jar is usable, the account
// menu came back authenticated, one account on disk. Every case below
// overrides just the fields it is about.
const healthy: AccountSlotInput = {
  credentials: "authenticated",
  liveAccount: "authenticated",
  accountsPending: false,
  storedCount: 1,
};

const slot = (over: Partial<AccountSlotInput> = {}) =>
  accountSlot({ ...healthy, ...over });

describe("credentialState", () => {
  it("reads true and false as authoritative", () => {
    expect(credentialState(true, false)).toBe("authenticated");
    expect(credentialState(false, false)).toBe("signed-out");
  });

  it("reads a rejected check as unknown, never as signed out", () => {
    expect(credentialState(undefined, true)).toBe("unknown");
  });

  it("reads a check that has not answered as pending", () => {
    expect(credentialState(undefined, false)).toBe("pending");
  });
});

describe("liveAccountState", () => {
  it("treats an account payload as authenticated", () => {
    expect(liveAccountState({ name: "Yuvraj" }, false)).toBe("authenticated");
  });

  // fetchAccountInfo only returns null once Google has answered, so
  // null is the one authoritative sign-out signal in this path.
  it("treats null as an authoritative anonymous answer", () => {
    expect(liveAccountState(null, false)).toBe("signed-out");
  });

  it("treats a rejected fetch as unknown", () => {
    expect(liveAccountState(undefined, true)).toBe("unknown");
  });

  it("treats a disabled or in-flight query as pending", () => {
    expect(liveAccountState(undefined, false)).toBe("pending");
  });
});

describe("accountSlot", () => {
  it("renders the profile for a live session", () => {
    expect(slot()).toBe("profile");
  });

  it("renders the profile from a live session even before the stored list lands", () => {
    expect(slot({ accountsPending: true, storedCount: 0 })).toBe("profile");
  });

  // Every query reports isLoading false with data undefined while
  // PersistQueryClientProvider rehydrates, so a guard on isLoading alone
  // used to paint "Sign in" on every launch before auth was looked at.
  it("waits while the credential check has not answered", () => {
    expect(
      slot({ credentials: "pending", liveAccount: "pending", storedCount: 0 }),
    ).toBe("wait");
  });

  it("waits while the stored account list is still loading", () => {
    expect(slot({ liveAccount: "pending", accountsPending: true })).toBe(
      "wait",
    );
  });

  it("offers sign-in when the jar is authoritatively empty", () => {
    expect(
      slot({
        credentials: "signed-out",
        liveAccount: "pending",
        storedCount: 0,
      }),
    ).toBe("sign-in");
  });

  it("offers sign-in for a single stored account whose session expired", () => {
    expect(slot({ liveAccount: "signed-out", storedCount: 1 })).toBe("sign-in");
  });

  // Collapsing to one button would strand the user away from the
  // accounts that still work: no way to switch, no way to sign the
  // broken one out.
  it("keeps the account menu when several accounts are stored", () => {
    expect(slot({ liveAccount: "signed-out", storedCount: 3 })).toBe("profile");
    expect(
      slot({
        credentials: "signed-out",
        liveAccount: "pending",
        storedCount: 3,
      }),
    ).toBe("profile");
  });

  // The defect this whole path exists to fix: a network blip, a locked
  // keychain or an IPC hiccup must never read as a sign-out.
  it("keeps showing the account when the menu fetch failed", () => {
    expect(slot({ liveAccount: "unknown" })).toBe("profile");
  });

  it("keeps showing the account when the credential check failed", () => {
    expect(slot({ credentials: "unknown", liveAccount: "pending" })).toBe(
      "profile",
    );
  });

  it("keeps showing the account while the menu fetch is still retrying", () => {
    expect(slot({ liveAccount: "pending" })).toBe("profile");
  });

  // An empty account list is not evidence of anything: `useAccounts`
  // reports a failed `list_accounts` as `[]`, which is exactly what a
  // truncated accounts.json produces while the jar on disk is fine. The
  // Sign in button there is a lie, and it used to be a dead end too —
  // the login could not commit over the file it could not parse.
  it("never offers sign-in on a count of zero it cannot trust", () => {
    expect(
      slot({ credentials: "unknown", liveAccount: "pending", storedCount: 0 }),
    ).toBe("wait");
    expect(slot({ liveAccount: "unknown", storedCount: 0 })).toBe("wait");
  });

  // Every genuine sign-out is authoritative, so the button still shows
  // up where it is meant to.
  it("still offers sign-in on an authoritative signed-out", () => {
    expect(
      slot({
        credentials: "signed-out",
        liveAccount: "pending",
        storedCount: 0,
      }),
    ).toBe("sign-in");
    expect(slot({ liveAccount: "signed-out", storedCount: 0 })).toBe("sign-in");
  });

  // A fresh sign-in has usable cookies before its first menu fetch
  // resolves and before any account row exists; flashing "Sign in" at
  // that exact moment is what the wait is for.
  it("waits out the first menu fetch of a fresh sign-in", () => {
    expect(slot({ liveAccount: "pending", storedCount: 0 })).toBe("wait");
  });
});
