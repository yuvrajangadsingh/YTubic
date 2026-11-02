import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { appLog } from "@/lib/app-log";
import {
  fetchAccountInfo,
  fetchPremiumStatus,
  type AccountInfo,
  type PremiumStatus,
} from "@/lib/innertube/account";
import { AuthIdentityMismatchError } from "@/lib/innertube/shared";

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
 *
 * `refetchOnWindowFocus` is on here against the app-wide default. A
 * settled failure holds no data, so it counts as stale and a focus
 * re-asks; a good answer stays fresh for its staleTime and is left
 * alone. Without it the only ways back from a failed check were a
 * reconnect event or the periodic cookie refresh.
 */
const AUTH_RETRY = {
  retry: 3,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
  refetchOnReconnect: "always",
  refetchOnWindowFocus: true,
} as const;

/**
 * What a failed auth check may put in the app log. InnerTube errors
 * embed up to 300 chars of the response body, and a body is whatever
 * the server or something in between chose to send, so keep the
 * endpoint and status and drop the rest. Headers never reach an error
 * message; this is about not trusting what does.
 */
export function describeAuthError(e: unknown): string {
  // A parse error quotes the offending text, so a 200 that is not JSON
  // (a captive portal, a proxy error page) would put its body here.
  if (e instanceof SyntaxError) return "response was not JSON";
  const msg = e instanceof Error ? e.message : String(e);
  if (
    /JSON Parse error|in JSON at position|Unexpected (token|identifier)/.test(
      msg,
    )
  ) {
    return "response was not JSON";
  }
  return msg
    .replace(/(HTTP \d{3}):[\s\S]*$/, "$1")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/**
 * A request refused for naming a different account than the credentials
 * on hand will not pass on retry: the id query is about to re-key the
 * observer (or is re-read on the refusal, see
 * `useRereadActiveIdOnMismatch`), and the backoff only delays that.
 */
function retryUnlessMismatch(failureCount: number, error: unknown): boolean {
  return (
    !(error instanceof AuthIdentityMismatchError) &&
    failureCount < AUTH_RETRY.retry
  );
}

function secondsSince(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}

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
  // Reading the jar is IPC to our own process. The default online-only
  // policy pauses a query the moment the browser reports offline, without
  // ever calling Rust, and offline is exactly when the answer matters:
  // it is what tells the Premium gate it may stand in with the last
  // verdict instead of holding playback.
  networkMode: "always",
  ...AUTH_RETRY,
} as const;

/**
 * Which stored account is active, read straight off disk. A local invoke,
 * so it answers in about a millisecond even with no network at all, and it
 * is the only account identity available before `/account_menu` returns.
 */
export const activeAccountIdQuery = {
  queryKey: ["active-account-id"],
  queryFn: () => invoke<string | null>("get_active_account_id"),
  staleTime: 30_000,
  // Local read, same reason as above. `networkMode: "always"` also turns
  // the reconnect refetch off by default, so it is put back here along
  // with focus, and both as "always": a read that fails answers `null`,
  // which is a fresh success as far as the cache knows, so a stale-only
  // refetch a second later would skip it and it would stand until the
  // next mount. Each trigger costs one disk read.
  networkMode: "always",
  refetchOnReconnect: "always",
  refetchOnWindowFocus: "always",
} as const;

/**
 * A request refused for naming a different account than the jar's means
 * the key's id is behind the jar's. Usually the id query is already
 * re-reading (a switch, a sign-in); the exception is the startup dedup,
 * which remaps ids on disk without an accounts-changed event, and a key
 * read before it stayed wrong until the next focus or reconnect. Re-read
 * on the refusal itself; the observers re-key from there.
 */
export function useRereadActiveIdOnMismatch(error: unknown): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!(error instanceof AuthIdentityMismatchError)) return;
    void qc.invalidateQueries({ queryKey: ["active-account-id"] });
  }, [error, qc]);
}

/**
 * The signed-in identity, straight from `/account_menu`. Gate it on an
 * authoritative `is_logged_in === true`: firing it while the credential
 * check is unknown sends an anonymous probe whose anonymous answer then
 * looks like a real sign-out.
 *
 * Keyed by, and bound to, the account id, same as `premiumStatusQuery`.
 * The meta backfill pairs this answer with the active id and hands the
 * pair to `update_account_meta`, which merges accounts by identity: an
 * answer fetched for the previous account under the new id was that
 * command's way of folding the new account into the old one, jar and
 * all. `undefined` is "not read yet" and holds the query until it is.
 */
export function accountInfoQuery(
  enabled: boolean,
  accountId: string | null | undefined,
) {
  return {
    queryKey: ["account-info", accountId ?? null],
    queryFn: (): Promise<AccountInfo | null> =>
      fetchAccountInfo(accountId ?? null),
    enabled: enabled && accountId !== undefined,
    staleTime: 5 * 60_000,
    ...AUTH_RETRY,
    retry: retryUnlessMismatch,
  };
}

/**
 * Premium membership, from the same menu. Doesn't churn in a session.
 *
 * Only enabled once `is_logged_in` is an authoritative `true`. That is
 * a local read of the jar, not a word from Google, so an anonymous menu
 * here means the credentials were not honoured this time: a rotated
 * cookie, an expired session, or a layout change that moved the header.
 * None of those is a verdict. Returning `null` for it cached an
 * unusable answer as a fresh success for the whole staleTime, with no
 * retry and nothing to refetch on. That is the most likely reading of
 * the Sep 7 2026 launch that sat on "Checking…" until a cookie refresh
 * re-asked, though the log of that build could not say what the first
 * check answered, which is what the lines below are for. Throwing puts
 * it on the retry, focus and session-refreshed paths, same as an HTTP
 * failure.
 *
 * One line per attempt, with elapsed time: a start with no finish is a
 * hang, and a same-value re-check still leaves a trace.
 */
export function premiumStatusQuery(
  enabled: boolean,
  accountId: string | null | undefined,
) {
  return {
    // Keyed by the account the answer is for. Without the id in the key,
    // an account switch left the previous account's verdict in the cache
    // under the new id until the full reset landed, and the record on
    // disk was written from that pairing. `undefined` is "not read yet"
    // and holds the query until it is. The key alone does not bind the
    // request, though: the credentials come from one shared cache, and
    // in the gap after a switch a refetch under the old key went out
    // with the new jar. So the fetch is told the account too, and
    // refuses any other.
    queryKey: ["premium-status", accountId ?? null],
    queryFn: async (): Promise<PremiumStatus> => {
      const t0 = Date.now();
      appLog("[premium] check start");
      let status: PremiumStatus;
      try {
        status = await fetchPremiumStatus(accountId ?? null);
      } catch (e) {
        appLog(
          `[premium] check failed in ${secondsSince(t0)}: ${describeAuthError(e)}`,
        );
        throw e;
      }
      if (status === null) {
        appLog(`[premium] check failed in ${secondsSince(t0)}: anonymous menu`);
        throw new Error(
          "account menu answered signed out with a signed-in jar",
        );
      }
      appLog(`[premium] check done in ${secondsSince(t0)}: ${status}`);
      return status;
    },
    enabled: enabled && accountId !== undefined,
    staleTime: 30 * 60 * 1000,
    ...AUTH_RETRY,
    retry: retryUnlessMismatch,
  };
}
