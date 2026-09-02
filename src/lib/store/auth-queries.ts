import { invoke } from "@tauri-apps/api/core";
import {
  fetchAccountInfo,
  fetchPremiumStatus,
  type AccountInfo,
  type PremiumStatus,
} from "@/lib/innertube/account";

/**
 * One definition per auth query, shared by every screen that mounts it.
 *
 * They all sit on the same three query keys, and TanStack keeps one
 * cache entry per key: whichever observer mounts first dictates the
 * options for all of them. Nine inline copies of `["auth-logged-in"]`
 * meant the retry and refetch policy of the sidebar depended on whether
 * Settings happened to be open.
 */

/**
 * `refetchOnReconnect: "always"` is the load-bearing option here, not
 * the retry count. A query counts as fresh for its whole staleTime once
 * it resolves, and freshness suppresses the reconnect refetch, so the
 * one moment the app could recover from a dropped connection was the
 * moment it ignored. The backoff is capped at 30 s because a failing
 * auth check usually means the machine is offline, and hammering
 * authenticated reloads is the pattern that gets sessions revoked.
 */
const AUTH_RETRY = {
  retry: 3,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
  refetchOnReconnect: "always",
} as const;

/**
 * Does the stored jar hold credentials this client can sign requests
 * with? A rejection means the jar could not be read (keychain, storage,
 * IPC), which is NOT the same as an empty jar. Consumers must branch on
 * `=== true` / `=== false` and treat `undefined` as "no answer".
 */
export const authLoggedInQuery = {
  queryKey: ["auth-logged-in"],
  queryFn: () => invoke<boolean>("is_logged_in"),
  staleTime: 30_000,
  ...AUTH_RETRY,
};

/**
 * The signed-in identity, straight from `/account_menu`. Gate it on an
 * authoritative `is_logged_in === true`: firing it while the credential
 * check is unknown sends an anonymous probe whose anonymous answer then
 * looks like a real sign-out.
 */
export function accountInfoQuery(enabled: boolean) {
  return {
    queryKey: ["account-info"],
    queryFn: (): Promise<AccountInfo | null> => fetchAccountInfo(),
    enabled,
    staleTime: 5 * 60_000,
    ...AUTH_RETRY,
  };
}

/** Premium membership, from the same menu. Doesn't churn in a session. */
export function premiumStatusQuery(enabled: boolean) {
  return {
    queryKey: ["premium-status"],
    queryFn: (): Promise<PremiumStatus> => fetchPremiumStatus(),
    enabled,
    staleTime: 30 * 60 * 1000,
    ...AUTH_RETRY,
  };
}
