import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { appLog } from "@/lib/app-log";
import type { PremiumStatus } from "@/lib/innertube/account";
import {
  activeAccountIdQuery,
  authLoggedInQuery,
  describeAuthError,
  premiumStatusQuery,
} from "@/lib/store/auth-queries";
import {
  clearPremiumVerdict,
  standInVerdict,
  writePremiumVerdict,
} from "@/lib/store/premium-record";

type State = {
  /**
   * Last known Premium status from auto-detection. `null` while we
   * haven't checked yet *or* when the user is not signed in.
   */
  status: PremiumStatus;
  /**
   * When a stood-in `status` stops counting, or null when the status came
   * from a live check. Checking the record's age at read time is not
   * enough on its own: once seeded, a status with nothing to expire it
   * outlives its window on a machine that stays offline or asleep.
   */
  standInUntil: number | null;
  setStatus: (status: PremiumStatus) => void;
};

/**
 * Premium-status state shared across React and non-React code. The
 * `audio-engine` + `stream.ts` modules consult this synchronously via
 * `usePremiumStore.getState()` to decide whether playback is allowed
 * and whether to fire prefetches.
 *
 * The actual fetching/refresh is owned by the `usePremiumStatusSync`
 * hook mounted in AppShell. Keeping the store dumb means anyone with a
 * cached value (e.g. a freshly opened floating-player window) starts
 * from the conservative `null` and only flips to "premium" once the
 * authoritative check completes.
 *
 * The store itself holds nothing across launches. What survives is the
 * last verdict the live check produced, in `premium-record`, and it is
 * only ever read to stand in while a fresh check is in flight: a launch
 * used to sit on the gate for as long as `/account_menu` took, and that
 * has been 76 s on a bad link. The record is bound to the active account
 * id and expires after a day, so a downgrade made elsewhere takes effect
 * on the next check that lands rather than never.
 *
 * There is still deliberately NO user-facing override: playback itself
 * is Premium-gated, so a manual "I have Premium" switch would be a
 * one-click bypass of the gate. Misdetection is covered by
 * fetchPremiumStatus failing open to "premium" when its patterns
 * don't match, plus the Re-check button on the Storage tab. (An
 * override used to exist and was persisted under the "ytm-premium"
 * localStorage key; that key is now simply ignored.)
 */
export const usePremiumStore = create<State>()((set) => ({
  status: null,
  standInUntil: null,
  // A live answer always clears the stand-in deadline with it.
  setStatus: (status) => set({ status, standInUntil: null }),
}));

/** Synchronous read for non-React callers (stream.ts, audio-engine). */
export function isPremium(): boolean {
  const { status, standInUntil } = usePremiumStore.getState();
  if (status !== "premium") return false;
  // The timer below normally clears this first. It cannot be relied on
  // across sleep, so the deadline is enforced here as well, at the moment
  // the answer is actually used.
  return standInUntil === null || Date.now() <= standInUntil;
}

/**
 * Mount once near the app root (AppShell). Watches the login state
 * and, when authenticated, fetches Premium status from YT Music, then
 * mirrors it into the Zustand store. Signed-out users get `null`
 * immediately so stream URLs flip to ephemeral mode without waiting on
 * a network round-trip.
 */
export function usePremiumStatusSync(): void {
  const loggedIn = useQuery(authLoggedInQuery);
  const activeId = useQuery(activeAccountIdQuery);
  const premium = useQuery(premiumStatusQuery(loggedIn.data === true));

  // Declared FIRST. On the render where the id flips, the old account's
  // answer has to be gone before the mirror and the seeding below look,
  // and the mirror re-runs on the same change (it lists the id as a
  // dependency), so a live answer that landed ahead of its id is put back
  // rather than lost. With the mirror ahead of this, the clear ran last
  // and the store sat on `null` until the next recheck, half an hour on.
  //
  // Signing in to a second account resets the premium QUERY but leaves the
  // store holding the previous account's answer, and the full reset only
  // arrives once the metadata backfill completes. In between, a slow or
  // failed check for the new account left the old verdict standing, and
  // the seeding guard below reads a non-null status as "already answered".
  const seenAccount = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (activeId.data === undefined) return;
    const previous = seenAccount.current;
    seenAccount.current = activeId.data;
    if (previous === undefined || previous === activeId.data) return;
    appLog("[premium] active account changed, dropping the held status");
    usePremiumStore.setState({ status: null, standInUntil: null });
  }, [activeId.data]);

  useEffect(() => {
    // Only an authoritative "signed out" clears the status. `undefined`
    // covers both "still checking" and "the check failed", and a failed
    // check must not downgrade a paying user: `null` here shuts off
    // caching and arms the Premium gate on every track.
    //
    // `activeId.data` is a dependency so this re-applies the live answer
    // after the account-change clear above, which can run in the same
    // commit as, or after, the answer it clears.
    if (loggedIn.data === false) {
      appLog("[premium] signed out");
      // The one event that settles the question. Anything else, a failed
      // check included, leaves the record to stand its day out.
      clearPremiumVerdict();
      usePremiumStore.setState({ status: null, standInUntil: null });
      return;
    }
    if (premium.data === undefined) return;
    appLog(`[premium] status=${premium.data}`);
    usePremiumStore.getState().setStatus(premium.data);
  }, [loggedIn.data, activeId.data, premium.data]);

  // Record every live answer against the account it was asked about, at
  // the time the answer actually landed. Keyed on `dataUpdatedAt` and not
  // on the value: a recheck that confirms the same verdict has to push the
  // record's age out, or a long session expires a verdict it just
  // reconfirmed. Its own effect so a late-arriving account id doesn't
  // re-run the logging above.
  useEffect(() => {
    if (premium.data === undefined) return;
    writePremiumVerdict(
      activeId.data,
      premium.data,
      premium.dataUpdatedAt || Date.now(),
    );
  }, [activeId.data, premium.data, premium.dataUpdatedAt]);

  // Stand in with the recorded verdict until the live one lands. Runs
  // only while the store is still `null`, so it can neither overwrite an
  // answer nor fire twice, and a live answer always wins the moment it
  // arrives.
  useEffect(() => {
    if (loggedIn.data !== true) return;
    if (premium.data !== undefined) return;
    if (usePremiumStore.getState().status !== null) return;
    const now = Date.now();
    const stood = standInVerdict(activeId.data, now);
    if (!stood) return;
    appLog(
      `[premium] standing in with stored ${stood.status} until the check lands`,
    );
    usePremiumStore.setState({
      status: stood.status,
      standInUntil: stood.until,
    });
    // Follow the deadline in the UI too. `isPremium` enforces it on read
    // for the case this timer sleeps through.
    const timer = window.setTimeout(
      () => {
        if (usePremiumStore.getState().standInUntil === null) return;
        appLog("[premium] stored verdict expired, back to unknown");
        usePremiumStore.setState({ status: null, standInUntil: null });
      },
      Math.max(0, stood.until - now),
    );
    return () => window.clearTimeout(timer);
  }, [loggedIn.data, activeId.data, premium.data]);

  // A failed check leaves the store alone on purpose, so the log is the
  // only place it can show. The query logs each attempt itself; these
  // are the gave-up lines. Sep 7 2026: a launch landed on the gate with
  // nothing in the log to say whether the login probe or the menu fetch
  // had failed, or what the menu had answered.
  useEffect(() => {
    if (loggedIn.error) {
      appLog(
        `[premium] login check gave up: ${describeAuthError(loggedIn.error)}`,
      );
    }
  }, [loggedIn.error]);
  useEffect(() => {
    if (premium.error) {
      appLog(`[premium] check gave up: ${describeAuthError(premium.error)}`);
    }
  }, [premium.error]);
}
