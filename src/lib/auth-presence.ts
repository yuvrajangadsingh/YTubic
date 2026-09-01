/**
 * Auth is not a boolean here.
 *
 * Three separate things answer "is this user signed in": Rust's
 * `is_logged_in` (does the jar hold credentials this client can sign
 * with), YouTube's `/account_menu` (does the session still
 * authenticate), and the account rows stored on disk. Every one of them
 * can also fail to answer at all, and on macOS that happens routinely:
 * the AES key lives in the login keychain, so a jar read during a dark
 * wake fails the same way a dropped connection does.
 *
 * Folding "no answer" into "signed out" is what put a Sign in button in
 * front of users who were signed in the whole time. So a failure gets
 * its own state, and the rules in `accountSlot` only ever offer that
 * button on an authoritative answer, or when there is no stored
 * identity left to show.
 */
export type SessionState =
  /** Authoritative yes: usable credentials, or an authenticated menu. */
  | "authenticated"
  /** Authoritative no: an anonymous answer, or an explicit sign-out. */
  | "signed-out"
  /** Asked, no usable answer: transport, keychain, storage or parse. */
  | "unknown"
  /** Not asked yet, in flight, or gated off behind an earlier check. */
  | "pending";

/**
 * Collapse the `is_logged_in` query into a session answer.
 *
 * `true` and `false` are both authoritative: the hardened command
 * rejects rather than answering `false` for a jar it could not read, so
 * a rejected query is the unknown case and never the signed-out one.
 */
export function credentialState(
  data: boolean | undefined,
  isError: boolean,
): SessionState {
  if (data === true) return "authenticated";
  if (data === false) return "signed-out";
  return isError ? "unknown" : "pending";
}

/**
 * Collapse the `/account_menu` query into a session answer.
 *
 * `fetchAccountInfo` rejects on transport failure, so `null` carries
 * one meaning only: Google answered, and the answer was anonymous. A
 * disabled query reports neither data nor an error and so lands on
 * "pending", which is right: a check that never ran has said nothing.
 */
export function liveAccountState(
  data: object | null | undefined,
  isError: boolean,
): SessionState {
  if (data) return "authenticated";
  if (data === null) return "signed-out";
  return isError ? "unknown" : "pending";
}

export type AccountSlotInput = {
  /** What Rust says about the jar. */
  credentials: SessionState;
  /** What `/account_menu` says about the live session. */
  liveAccount: SessionState;
  /** The stored account list has not resolved yet. */
  accountsPending: boolean;
  /**
   * How many accounts are on disk. Zero is ambiguous on purpose:
   * `useAccounts` maps a failed `list_accounts` to an empty array, so
   * "no accounts" and "the list could not be read" arrive identically.
   * Nothing below lets a zero decide the Sign in button on its own.
   */
  storedCount: number;
};

/** What the sidebar footer should render. */
export type AccountSlot =
  /** Nothing yet; too early to claim either way. */
  | "wait"
  /** The primary Sign in button. */
  | "sign-in"
  /** The account row and its menu, live data or stored meta. */
  | "profile";

/**
 * Decide the sidebar footer from the two auth answers plus what is on
 * disk. Pure so the rules can be tested without a renderer.
 *
 * The ordering is the point:
 *
 *  1. An authenticated menu outranks everything, including a stored
 *     list that has not loaded.
 *  2. A check still in flight renders nothing rather than guessing.
 *  3. Only an authoritative "signed out" reaches the Sign in button,
 *     and even then not with several accounts stored: collapsing to one
 *     button would strand the user away from the healthy ones, with no
 *     way to switch and no way to sign the broken one out.
 *  4. Anything left is unknown or pending. Keep the stored identity on
 *     screen; live data upgrades the row in place when it lands.
 *  5. With nothing stored there is nothing to draw. The button does not
 *     belong here: every genuine sign-out is authoritative and left at
 *     rule 3, so the only states that reach this line are "the jar is
 *     signable but the menu fetch failed" and "we could not read the
 *     jar at all" — and an empty `storedCount` cannot tell an empty
 *     list from one that failed to load. Both are transient or repair
 *     themselves, so draw nothing and let the retry, or the
 *     `session-refreshed` event, settle it. Offering the button here
 *     was worse than useless: it could not commit its own result over
 *     an accounts.json it could not read, so it deleted the account it
 *     had just created and left the user exactly where they started.
 */
export function accountSlot(input: AccountSlotInput): AccountSlot {
  const { credentials, liveAccount, accountsPending, storedCount } = input;

  if (liveAccount === "authenticated") return "profile";
  if (credentials === "pending" || accountsPending) return "wait";

  if (credentials === "signed-out" || liveAccount === "signed-out") {
    return storedCount < 2 ? "sign-in" : "profile";
  }

  if (storedCount > 0) return "profile";

  return "wait";
}
