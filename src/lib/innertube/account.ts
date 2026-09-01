import { innertubePost, type YtNode } from "./shared";

export type AccountInfo = {
  name: string;
  email: string;
  photoUrl?: string;
};

/**
 * Tri-state Premium signal:
 *  - null      → user is not signed in
 *  - "free"    → signed in, no Premium subscription detected
 *  - "premium" → signed in, Premium subscription detected
 *
 * A failed check is NOT `null`: it rejects, so the caller can hold the
 * last known status instead of downgrading a paying user to Free.
 */
export type PremiumStatus = null | "free" | "premium";

/**
 * Pull the signed-in user's display name, email and avatar from
 * `account/account_menu`. Anonymous calls return a generic sign-in
 * popup with no `activeAccountHeaderRenderer` — we treat that as
 * "not signed in" and return null.
 *
 * Nothing here is caught on purpose. A transport, IPC or keychain
 * failure has to reach the caller as a rejection: swallowing it into
 * `null` made a dropped connection indistinguishable from Google
 * answering "anonymous", and the sidebar then offered a Sign in button
 * to a user who had been signed in the whole time. `auth: "required"`
 * closes the other half of that hole, where an unreadable jar sends the
 * probe out anonymous and the anonymous menu comes back as proof.
 */
export async function fetchAccountInfo(): Promise<AccountInfo | null> {
  const json: YtNode = await innertubePost(
    "account/account_menu",
    {},
    { auth: "required" },
  );

  const header: YtNode | undefined =
    json?.actions?.[0]?.openPopupAction?.popup?.multiPageMenuRenderer?.header
      ?.activeAccountHeaderRenderer;
  // Past this line `null` carries one meaning: Google answered, and the
  // answer was anonymous.
  if (!header) return null;

  const readText = (node: YtNode | undefined): string =>
    node?.simpleText ??
    (node?.runs ?? [])
      .map((r: YtNode) => r?.text ?? "")
      .join("") ??
    "";

  const name = readText(header.accountName);
  const email = readText(header.email);
  const photos: YtNode[] = header.accountPhoto?.thumbnails ?? [];
  const photoUrl = photos[photos.length - 1]?.url as string | undefined;

  // An active-account header with no readable labels is a parse miss on
  // an authenticated response, not a sign-out. Returning null here used
  // to demote a live session to "anonymous"; hand back what we have and
  // let callers fall back to the stored meta for the empty fields.
  return { name, email, photoUrl };
}

/**
 * Detect YT Music Premium status from `account/account_menu`.
 *
 * Strategy: the menu always contains some "Get / Try / Subscribe to
 * Music Premium" upsell entry for Free users, regardless of locale.
 * For Premium users that entry is absent — instead the menu shows
 * "Manage your Music Premium membership" (or the localized variant).
 * So we collect the visible text of every menu item, then:
 *   - If any item matches an upsell pattern → Free.
 *   - Else if any item matches a manage-membership pattern → Premium.
 *   - Else → Premium (the upsell would be there if the user were Free;
 *     YT shows it unconditionally, including for users who recently
 *     dismissed a related banner). Falling back to Free here would
 *     lock paying users out of caching when our patterns drift.
 *
 * Returns `null` when not signed in so the caller can show the right
 * gate ("sign in" vs "upgrade"). Rejects (rather than returning null)
 * when the call fails: `null` opens the Premium gate on every track, so
 * a dropped connection must not be able to produce it.
 */
export async function fetchPremiumStatus(): Promise<PremiumStatus> {
  const json: YtNode = await innertubePost(
    "account/account_menu",
    {},
    { auth: "required" },
  );

  const popup: YtNode | undefined =
    json?.actions?.[0]?.openPopupAction?.popup?.multiPageMenuRenderer;
  const header: YtNode | undefined = popup?.header?.activeAccountHeaderRenderer;
  // No active-account header ⇒ anonymous sign-in prompt.
  if (!header) return null;

  // Collect text from every renderer in the menu. We walk the popup
  // (not just `sections`) because YT periodically reshuffles where the
  // upsell lives (sometimes nested under a `compactLinkRenderer`,
  // sometimes a `multiPageMenuItemRenderer.text`, occasionally a
  // dedicated promo container).
  const labels: string[] = [];
  const stack: unknown[] = [popup];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    const obj = cur as YtNode;
    if (typeof obj.simpleText === "string") labels.push(obj.simpleText);
    if (Array.isArray(obj.runs)) {
      const text = obj.runs
        .map((r: YtNode) => (typeof r?.text === "string" ? r.text : ""))
        .join("");
      if (text) labels.push(text);
    }
    if (typeof obj.label === "string") labels.push(obj.label);
    for (const k of Object.keys(obj)) stack.push(obj[k]);
  }

  if (import.meta.env.DEV) {
    console.debug(
      "[premium] account_menu labels:",
      labels.filter((s) => /premium|музык|музыка|premium/i.test(s)),
    );
  }

  // Free signals — first verb identifies the upsell shape, the second
  // group catches both "Music Premium" and "YouTube Premium" mentions.
  // 40-char window so localized phrasings ("Hol dir Music Premium",
  // "Получить Music Premium") still hit.
  const upsell =
    /\b(get|try|start|join|upgrade|unlock|subscribe|hol\s*dir|получ|оформ|підписат|попроб)\b[\s\S]{0,40}\b(music\s*)?premium\b/i;
  const upsellSuffix =
    /\b(music\s*)?premium\b[\s\S]{0,40}\b(now|today)\b/i;
  for (const s of labels) {
    if (upsell.test(s) || upsellSuffix.test(s)) return "free";
  }

  // Premium membership signals — "Manage your Music Premium membership"
  // / "Music Premium · monthly" / Russian "Управление подпиской Music
  // Premium" / etc.
  const member =
    /\b(manage|your|cancel|membership|member|управл|подписк|подписк[аи])\b[\s\S]{0,40}\b(music\s*)?premium\b/i;
  for (const s of labels) {
    if (member.test(s)) return "premium";
  }

  // Signed in, no upsell text found anywhere in the menu, no explicit
  // member text either. YT *always* shows an upsell for Free users —
  // the most likely explanation is that the localized phrasing didn't
  // match our patterns. Falling back to "premium" keeps paying users
  // unblocked; the worst-case mistake (a Free user with caching) is
  // less damaging than locking a Premium user out of a paid feature.
  return "premium";
}
