import { useEffect } from "react";
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
  readPremiumVerdict,
  writePremiumVerdict,
} from "@/lib/store/premium-record";

type State = {
  /**
   * Last known Premium status from auto-detection. `null` while we
   * haven't checked yet *or* when the user is not signed in.
   */
  status: PremiumStatus;
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
  setStatus: (status) => set({ status }),
}));

/** Synchronous read for non-React callers (stream.ts, audio-engine). */
export function isPremium(): boolean {
  return usePremiumStore.getState().status === "premium";
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

  useEffect(() => {
    // Only an authoritative "signed out" clears the status. `undefined`
    // covers both "still checking" and "the check failed", and a failed
    // check must not downgrade a paying user: `null` here shuts off
    // caching and arms the Premium gate on every track.
    if (loggedIn.data === false) {
      appLog("[premium] signed out");
      // The one event that settles the question. Anything else, a failed
      // check included, leaves the record to stand its day out.
      clearPremiumVerdict();
      usePremiumStore.setState({ status: null });
      return;
    }
    if (premium.data === undefined) return;
    appLog(`[premium] status=${premium.data}`);
    usePremiumStore.getState().setStatus(premium.data);
  }, [loggedIn.data, premium.data]);

  // Record every live answer against the account it was asked about. Its
  // own effect so a late-arriving account id doesn't re-run the logging
  // above; `login-success` resets the premium query, so the id and the
  // verdict here always belong to the same account.
  useEffect(() => {
    if (premium.data === undefined) return;
    writePremiumVerdict(activeId.data, premium.data, Date.now());
  }, [activeId.data, premium.data]);

  // Stand in with the recorded verdict until the live one lands. Runs
  // only while the store is still `null`, so it can neither overwrite an
  // answer nor fire twice, and a live answer always wins the moment it
  // arrives.
  useEffect(() => {
    if (loggedIn.data !== true) return;
    if (premium.data !== undefined) return;
    if (usePremiumStore.getState().status !== null) return;
    const stored = readPremiumVerdict(activeId.data, Date.now());
    if (!stored) return;
    appLog(`[premium] standing in with stored ${stored} until the check lands`);
    usePremiumStore.setState({ status: stored });
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
