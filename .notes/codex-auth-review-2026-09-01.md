## Verdict

Cherry-pick both upstream commits in order, resolve the conflicts deliberately, then audit the merged result against your local invariants. Your tree is close enough to the upstream parent that preserving the original patch structure is safer than recreating four apparently independent fixes.

The defects are coupled. Persistence errors become false logout signals, refresh timing determines cookie validity, and frontend error handling decides whether either condition is shown as logout. A manual rewrite makes it easy to fix the visible symptoms while missing the domain validation, protected-cookie handling, cache semantics, or platform wake integration that upstream added around them.

I would approve the plan with three changes:

1. Use a success-based refresh deadline plus a short polling fallback and full-wake signals.
2. Serialize every mutation of a given account's cookie jar. Atomic replacement alone is not enough.
3. Split authentication into `present`, `usable`, and `unknown`. A Boolean cannot represent the failure cases you have.

## A. Cherry-pick or reimplement

Cherry-pick `2f3f6df` first and `03d2065` second on an integration branch. A no-commit cherry-pick is reasonable if you want to inspect the combined Rust conflict before committing, but keep the two upstream changes traceable as separate logical patches.

The same-file divergences are not a reason to rewrite the fix. They are a reason to inspect these areas during conflict resolution:

- `identity::migrate()` must remain the literal first statement in `setup()`.
- stderr redirection must remain early enough that spawned tasks cannot log before it is installed.
- The Safari login user agent must also apply to any refresh WKWebView that needs the same Google compatibility behavior.
- `ytdlp_cookie_file()` must read only a successfully committed jar and must preserve the plaintext file's `0600` handling.
- The range proxy should be kept outside the auth merge unless an upstream hunk genuinely overlaps it.
- Any power observer must be registered after required migration and runtime initialization, but before the background refresh task starts.

Take the RFC 6265 domain validation. It prevents a response from assigning a cookie to an unrelated Google or YouTube domain. Current upstream checks that the response host equals the cookie domain or has the cookie domain as a dotted suffix, which is the right shape for this filter. See the [current upstream Rust implementation](https://github.com/NUber-dev/YTubic/blob/main/src-tauri/src/lib.rs).

One issue to audit in that merger is cookie identity. Under RFC 6265, a stored cookie is keyed by name, domain, and path. If the upstream merge locates cookies only by name and domain, two same-name cookies on different paths can collide. This may be harmless if your import path normalizes every relevant Google cookie to `/`, but that assumption should be made explicit and tested.

Keep the Windows power support if the fork still claims Windows support. If this is intentionally a macOS-only fork, omitting `power.rs` is defensible, but document that as an intentional deviation rather than accidentally dropping it during conflict resolution.

The protected-cookie deletion rule needs one correction in how it is interpreted. Refusing to commit an identity-cookie deletion is useful when a replayed HTTP snapshot is subordinate to the WKWebView cookie store. It is dangerous if the app then continues replaying the preserved cookie indefinitely. A deletion of `SID`, `SAPISID`, or a `PSID` cookie could also represent a real revocation or logout.

On a protected deletion, I would:

- Preserve the last known-good jar on disk.
- Mark the account as `suspect`, not authenticated.
- Stop anonymous fallback and repeated replay of the questionable credentials.
- Request one singleflight keeper refresh.
- Replace the jar only after the keeper produces a complete valid snapshot.
- Remain `unknown` if the keeper cannot run, rather than claiming either signed in or signed out.

This preserves recoverability without turning protected cookies into immortal credentials.

## B. Refresh timing, dark wake, and full wake

A short monotonic timer plus a wall-clock deadline is a good correctness fallback, but it is not sufficient as the entire macOS design.

The refresh state needs two separate times:

- `due_at`, based only on the last successful committed refresh.
- `next_attempt_at`, used for retry backoff after environmental failures.

Do not advance `due_at` when an attempt starts. Do not advance it when keychain access, WKWebView creation, navigation, cookie enumeration, encryption, or persistence fails.

A refresh should count as successful only after all of these have happened:

1. The keeper WKWebView loaded successfully.
2. Cookie enumeration completed.
3. The captured set passed a basic liveness and continuity check.
4. Encryption succeeded.
5. The new jar was atomically committed.
6. Any associated index or generation metadata was committed consistently.

On a dark-wake keychain failure, leave the existing jar and `last_success` untouched. Set `next_attempt_at` using bounded exponential backoff with jitter. This prevents a 30-second tick from hammering the keychain, WebKit, or Google. A later confirmed full-wake event should override that backoff after a short network and keychain settling delay, perhaps 5 to 15 seconds.

`NSWorkspace.didWakeNotification` is useful as a prompt signal, but it should not replace polling. Apple's documented contract only says that it is posted when the device wakes, and it carries no field saying whether this was a dark wake or a user-visible wake. Apple does not document whether every dark wake produces this notification for ordinary applications. I would therefore treat it as potentially firing during dark wake and not use its arrival as proof that UI and keychain access are available. See [NSWorkspace didWakeNotification](https://developer.apple.com/documentation/appkit/nsworkspace/didwakenotification) and [Apple QA1340](https://developer.apple.com/library/archive/qa/qa1340/_index.html).

A practical macOS design is:

- Listen for `didWakeNotification` and mark the refresh due.
- Treat screen wake, session activation, or application activation as evidence that a user session is usable.
- After such an event, wait briefly and request a refresh.
- Retain a 15 to 60 second wall-clock polling fallback in case notifications are missed.
- Use a per-account singleflight guard so all signals converge on one attempt.
- Keep bounded backoff for network, keychain, and WebKit failures.

If you need a real in-process full-wake distinction, AppKit does not give you a high-level Boolean. The lower-level public route is IOKit power capability notifications. `IOPMSystemCapabilityChangeParameters` exposes the old and new capabilities, so you can gate the attempt on graphics capability becoming available rather than merely CPU or network capability. See Apple's [IOPMSystemCapabilityChangeParameters documentation](https://developer.apple.com/documentation/iokit/iopmsystemcapabilitychangeparameters).

Using IOKit is more plumbing. For this application, screen and session activation signals plus the polling fallback may be simpler and sufficiently reliable. The important property is that `didWake` marks work due, while UI readiness controls when the expensive attempt is allowed.

Do not cache the AES key in memory solely to make dark-wake refresh work. That extends the key's lifetime and still does not guarantee that WKWebView can operate during dark wake. Do not prevent sleep with a power assertion for a periodic cookie refresh.

Also account for clock changes. Sleep should count toward the deadline, so the deadline must ultimately use wall time or a persisted successful-refresh timestamp. A large backward clock adjustment should conservatively mark the refresh due rather than postponing it indefinitely.

Your current loop refreshes only the active account. That leaves another defect around account switching: an inactive account may have a very old snapshot when selected. Either refresh the target account before making it active, or refresh inactive accounts on a staggered low-frequency schedule. Do not begin authenticated requests from an inactive account's stale jar while its keeper refresh is still running.

## C. Atomicity and durability on APFS

There are two guarantees here, and they should not be confused.

For process crashes and concurrent readers, sibling temp file, complete write, file `fsync`, and atomic rename gives the important old-or-new property. Readers do not see a half-written destination.

For OS crashes or sudden power loss where you require the new directory entry itself to survive, sync the parent directory after the rename. POSIX explicitly distinguishes atomic directory operations from durable directory operations. Its rationale says directory synchronization is required when an application needs to guarantee that the new file contents survive a crash, rather than merely accepting either the old or new version. See the [POSIX filesystem synchronization rationale](https://pubs.opengroup.org/onlinepubs/9799919799/xrat/V4_xbd_chap01.html) and [rename specification](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html).

Therefore:

- If the contract is “never torn, and either old or new is acceptable,” temp, file sync, and rename is enough.
- If the contract is “a reported successful update must survive a machine crash,” sync the parent directory after rename.
- APFS journaling and copy-on-write make the practical result better, but they do not replace the API-level durability contract.

The current upstream helper appears to use a fixed `filename.tmp`. That is unsafe if two writers can overlap. One writer can truncate or modify the same temp inode while another is syncing or renaming it. In the worst ordering, a file descriptor opened before the rename can continue writing to the inode after it has become the destination, defeating atomic visibility.

Use both:

- A unique sibling temp created exclusively with `O_CREAT | O_EXCL` or the Rust equivalent.
- A per-account mutation queue or mutex that serializes refresh snapshots, response `Set-Cookie` merges, login completion, metadata backfill, logout, and yt-dlp export.

Unique temp files prevent temp-name collisions. Serialization or generation checks prevent an older completed operation from replacing a newer jar. Apple's secure coding guidance also recommends exclusive creation where attacker or concurrent-process races matter. See [Apple's open documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html).

On macOS, ordinary `fsync` asks the OS to send buffered writes to the device, but the device may still retain data in volatile caches or reorder it. `F_FULLFSYNC` asks for the stronger cache flush. Apple documents that it is more expensive and that devices may not implement the guarantee perfectly. See [Apple's fsync manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html) and [fcntl manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html).

For this workload, I would use ordinary file sync, rename, and parent-directory sync. That is a reasonable balance for a cookie snapshot updated regularly. `F_FULLFSYNC` on every response-driven cookie rotation is probably excessive. It could be reserved for rare account creation, explicit account switching, or login completion if losing that exact update has a high recovery cost.

Any synchronization error must fail the update. Keep the old file, do not update the success deadline, and do not translate the error into signed out. Stale temp files can be cleaned on startup after verifying they are not active.

The temp file must have restrictive permissions before secret content is written. `cookies.enc` is encrypted, but `ytdlp_cookie_file()` produces plaintext and must never have a briefly permissive creation mode.

## D. Correct cookie predicate

The immediate fix at `src-tauri/src/lib.rs:1405` is exact name matching. Never search the serialized `Cookie` header with `contains`.

Parse structured cookie records if possible. If only the header is available, split cookie pairs, extract the exact name before `=`, and compare exact names. Also respect domain, path, expiry, and nonempty values.

The relevant families are:

- Account and identity cookies: `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `__Secure-1PAPISID`, and `__Secure-3PAPISID`.
- Request-signing secrets used by YouTube clients: `SAPISID`, `__Secure-1PAPISID`, and `__Secure-3PAPISID`.
- Rotating freshness or session-state cookies: `SIDCC`, `__Secure-1PSIDCC`, `__Secure-3PSIDCC`, `__Secure-1PSIDTS`, `__Secure-3PSIDTS`, and `LOGIN_INFO`.

`__Secure-1PSIDTS` is a rotating token. It is not proof of a usable session and must never satisfy an exact check for `__Secure-1PSID`.

Current upstream frontend signing logic extracts `__Secure-3PAPISID`, falling back to `SAPISID`, to build `SAPISIDHASH`. See [upstream shared.ts](https://github.com/NUber-dev/YTubic/blob/main/src/lib/innertube/shared.ts). That means `__Secure-1PSID` alone is not sufficient for this client's authenticated InnerTube calls.

yt-dlp uses a useful stricter test: `LOGIN_INFO` plus at least one of `SAPISID`, `__Secure-1PAPISID`, or `__Secure-3PAPISID`. Its comment notes that a 3P signing cookie can survive after logout or rotation while `LOGIN_INFO` is cleared. See [yt-dlp's YouTube authentication implementation](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_base.py).

For this client I would define:

- `identity_present`: at least one exact identity-cookie name, useful only for continuity and protected-deletion decisions.
- `credentials_plausible`: `LOGIN_INFO` plus a nonempty, unexpired signing cookie that the frontend actually knows how to use.
- `session_usable`: a successful authenticated `account/account_menu` response or another authoritative authenticated probe.
- `session_unknown`: credentials exist, but the probe failed for transport, keychain, storage, parsing, or WebKit reasons.
- `signed_out`: an authoritative anonymous response or explicit logout, not merely an exception.

With today's frontend, the plausible predicate should be `LOGIN_INFO` and either `SAPISID` or `__Secure-3PAPISID`. If you add `SAPISID1PHASH` support, include `__Secure-1PAPISID`.

I would not require `__Secure-1PSIDTS`, `__Secure-1PSID`, or both 1P and 3P variants. That would reject valid YouTube sessions. Google does not publish these cookie internals as a stable client contract, so validate the chosen liveness predicate against jars captured from your supported login flows and keep the authoritative network probe.

## E. Frontend and other missing work

At `src/lib/innertube/account.ts:27` and `:74`, transport failure must not return the same value as a successful anonymous response.

The UI needs three outcomes:

- Authenticated response: render the profile.
- Authoritative anonymous response: render sign-in.
- Transport, IPC, decrypt, storage, or parse failure: retain the last known account identity and show an offline, retrying, or neutral state.

Do not cache `EMPTY_AUTH` after failure. Delete the failed in-flight promise, retain a still-valid previous good auth context when appropriate, and let the next request retry. For account-scoped calls, it is better to reject with a typed auth-unavailable error than to silently send the current request anonymously. Current upstream avoids caching the failure but still returns an empty context for that call, which can still cause one anonymous request. The tri-state presentation approach is visible in [upstream auth-presence.ts](https://github.com/NUber-dev/YTubic/blob/main/src/lib/auth-presence.ts).

Apply the same distinction in Rust. Missing files are not the same as corrupt JSON, AES-GCM authentication failure, unavailable keychain, or I/O failure. `read_index()` and jar reads must return typed outcomes such as absent, corrupt, and temporarily unavailable. None of the latter two should be converted into signed out.

Refreshing more often should reduce replay risk when there is one persistent keeper WKWebView and each new rotation is committed in order. The increased risk comes from concurrency and rollback, not frequency itself:

- Two hidden WKWebViews refreshing the same account.
- A response merger overwriting a newer keeper snapshot.
- A failed capture replacing the jar with an empty set.
- Different user agents or WebKit data stores for login and refresh.
- A stale operation committing after a newer operation.
- Continuing to replay protected but remotely revoked credentials.
- Exporting a plaintext yt-dlp jar while another mutation is incomplete.

Use one authoritative WKWebView data store per account and one serialized mutation stream per account. Give each snapshot a generation number or compare against a mutation sequence so stale work cannot overwrite newer state. A 20-minute cadence plus prompt refresh after full wake is not inherently aggressive. Add small jitter and stagger multiple accounts.

If ordinary authenticated responses have recently produced valid `Set-Cookie` rotations, the keeper refresh can be activity-aware. Track the last successful auth-cookie mutation, not just the jar's file modification time, because metadata rewrites can otherwise postpone a needed refresh.

A `401` or `403` should normally mark the session suspect, merge any valid response cookies, perform one keeper refresh, and retry once. Do not immediately clear the account. Only an authoritative anonymous account response, a confirmed keeper state without auth cookies, or explicit logout should do that.

The minimum verification plan should cover:

- Exact cookie names, including `__Secure-1PSIDTS` without `__Secure-1PSID`.
- Domain, path, expiry, and same-name cookies on different paths.
- Failure injection before sync, after sync, before rename, after rename, and before directory sync.
- Concurrent response merge and keeper refresh.
- Long sleep, backward wall-clock movement, dark-wake failure, and full-wake retry.
- Success-only deadline advancement and retry backoff.
- Transport failure versus authoritative anonymous frontend responses.
- Protected-cookie deletion followed by keeper failure.
- Switching to an inactive account while its refresh is in flight.
- yt-dlp export during a cookie rotation.

This was a plan and source review only. Not run.