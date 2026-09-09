import { safeLocalStorage } from "@/lib/store/safe-storage";
import type { PremiumStatus } from "@/lib/innertube/account";

/** An answer worth keeping. `null` is "unknown", which is not an answer. */
export type PremiumVerdict = "free" | "premium";

type PremiumRecord = {
  accountId: string;
  status: PremiumVerdict;
  checkedAt: number;
};

// Deliberately not the old "ytm-premium" key, which held a user-facing
// override that was removed. Reading that one back would turn a stale
// manual switch into a verdict.
const KEY = "ytm:premium-verdict";

/**
 * How long a stored verdict stands in for a live one.
 *
 * The Premium gate holds playback until the check answers, and that check
 * is a POST to `account/account_menu` with no cap of its own: on a lossy
 * link it has taken 76 s, and nothing plays for the whole of it. Standing
 * in with the last answer makes a bad launch cost nothing.
 *
 * The price runs the other way. Cancel Premium somewhere else and the app
 * keeps its paid behaviour until the next check lands or this window
 * closes. A day is short enough that a cancellation cannot ride along for
 * a billing period, and long enough to cover the run of bad launches this
 * exists for.
 */
const TRUST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The stored verdict for `accountId`, or null if there isn't a usable one.
 *
 * Bound to the account id rather than to the jar: the id is a local read
 * that answers in about a millisecond, so it is the only identity
 * available before `/account_menu` returns, which is exactly the window
 * this covers. A verdict recorded for one account is never handed to
 * another.
 */
export function readPremiumVerdict(
  accountId: string | null | undefined,
  now: number,
): PremiumVerdict | null {
  if (!accountId) return null;
  // `StateStorage` permits a promise; this implementation is synchronous.
  const raw = safeLocalStorage.getItem(KEY) as string | null;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Partial<PremiumRecord>;
  if (rec.accountId !== accountId) return null;
  if (rec.status !== "free" && rec.status !== "premium") return null;
  if (typeof rec.checkedAt !== "number" || !Number.isFinite(rec.checkedAt)) {
    return null;
  }
  const age = now - rec.checkedAt;
  // A clock that moved backwards puts the record in the future, and a
  // negative age would pass a plain upper bound and never expire.
  if (age < 0 || age > TRUST_WINDOW_MS) return null;
  return rec.status;
}

/** Record a verdict the live check actually produced. */
export function writePremiumVerdict(
  accountId: string | null | undefined,
  status: PremiumStatus,
  now: number,
): void {
  if (!accountId) return;
  if (status !== "free" && status !== "premium") return;
  const rec: PremiumRecord = { accountId, status, checkedAt: now };
  safeLocalStorage.setItem(KEY, JSON.stringify(rec));
}

/** Drop the record. Sign-out is the one event that invalidates it outright. */
export function clearPremiumVerdict(): void {
  safeLocalStorage.removeItem(KEY);
}
