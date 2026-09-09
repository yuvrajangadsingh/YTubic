import { beforeEach, describe, expect, it } from "vitest";

// `safeLocalStorage` reaches for `window.localStorage`; the node test env
// has neither. Same stubbing trick as playback.test.ts.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const { standInVerdict, writePremiumVerdict, clearPremiumVerdict } =
  await import("@/lib/store/premium-record");

const KEY = "ytm:premium-verdict";
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

beforeEach(() => store.clear());

/**
 * The record stands in for a live Premium check while that check is in
 * flight, which is the one window where nothing else can contradict it.
 * Every way it could be wrong has to end as "no record".
 */
describe("premium verdict record", () => {
  it("reads back what was written for the same account", () => {
    writePremiumVerdict("acct-1", "premium", T0);
    expect(standInVerdict("acct-1", T0 + 60_000)?.status).toBe("premium");
  });

  it("keeps a free verdict too", () => {
    writePremiumVerdict("acct-1", "free", T0);
    expect(standInVerdict("acct-1", T0)?.status).toBe("free");
  });

  it("never hands one account's verdict to another", () => {
    writePremiumVerdict("acct-1", "premium", T0);
    expect(standInVerdict("acct-2", T0)).toBeNull();
  });

  it("expires after a day", () => {
    writePremiumVerdict("acct-1", "premium", T0);
    expect(standInVerdict("acct-1", T0 + DAY - 1)?.status).toBe("premium");
    expect(standInVerdict("acct-1", T0 + DAY + 1)).toBeNull();
  });

  // A negative age passes any plain upper bound, so a machine whose clock
  // ran backwards would have trusted the record for good.
  it("refuses a record dated in the future", () => {
    writePremiumVerdict("acct-1", "premium", T0);
    expect(standInVerdict("acct-1", T0 - 1)).toBeNull();
  });

  it("has nothing to say without an account id", () => {
    writePremiumVerdict("acct-1", "premium", T0);
    expect(standInVerdict(null, T0)).toBeNull();
    expect(standInVerdict(undefined, T0)).toBeNull();
  });

  it("records nothing when the account id is unknown", () => {
    writePremiumVerdict(null, "premium", T0);
    expect(store.get(KEY)).toBeUndefined();
  });

  it("records nothing for a non-answer", () => {
    writePremiumVerdict("acct-1", null, T0);
    expect(store.get(KEY)).toBeUndefined();
  });

  it("survives junk in the slot", () => {
    store.set(KEY, "not json");
    expect(standInVerdict("acct-1", T0)).toBeNull();
    store.set(KEY, "null");
    expect(standInVerdict("acct-1", T0)).toBeNull();
    store.set(KEY, JSON.stringify({ accountId: "acct-1" }));
    expect(standInVerdict("acct-1", T0)).toBeNull();
  });

  // The old "ytm-premium" key held a user-facing override, and its shape
  // would otherwise read as a verdict.
  it("refuses a status it did not write", () => {
    store.set(
      KEY,
      JSON.stringify({ accountId: "acct-1", status: true, checkedAt: T0 }),
    );
    expect(standInVerdict("acct-1", T0)).toBeNull();
  });

  it("refuses a record with no usable timestamp", () => {
    store.set(
      KEY,
      JSON.stringify({
        accountId: "acct-1",
        status: "premium",
        checkedAt: "yesterday",
      }),
    );
    expect(standInVerdict("acct-1", T0)).toBeNull();
  });

  // The deadline has to ride along with the verdict: an applied stand-in
  // has nothing else to expire it on a machine that stays offline.
  it("hands back the moment the verdict stops counting", () => {
    writePremiumVerdict("acct-1", "premium", T0);
    expect(standInVerdict("acct-1", T0 + 60_000)?.until).toBe(T0 + DAY);
  });

  it("clears on sign-out", () => {
    writePremiumVerdict("acct-1", "premium", T0);
    clearPremiumVerdict();
    expect(standInVerdict("acct-1", T0)).toBeNull();
  });
});
