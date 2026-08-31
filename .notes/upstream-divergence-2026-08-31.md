# YTubic upstream divergence, cherry-pick assessment

Repo: `/Users/yuvrajangadsingh/Sites/projects/personal/YTubic`. Our `develop` vs `upstream/main`, merge-base `160f3745` (2026-07-23). 50 upstream-only commits (verified this session), 127 ours-only (verified). 37 assessed below; the other 13 are pre-verdicted chores, listed at the bottom. All verdicts come from reading diffs and develop blobs. Nothing was cherry-picked, built, or run. My own checks this session were git-level only (blob diffs, patch-ids, greps, ancestry), listed in the sanity-check section.

## Executive summary

- Of 37 assessed commits: 11 clean takes, 15 rework-takes, 5 skips, 6 already built on develop. The 13 leftover upstream commits are release/docs/branding chores, all skip.
- Two probably-live bugs in your packaged build lead the list: LRCLIB lyrics dead via CSP (lrclib.net absent from connect-src and capabilities while `src/lib/lyrics/lrclib.ts` uses webview fetch, fix in 3ceaddb, config-level gap confirmed this session) and library shelves silently truncating at ~25 rows (0026eb4), which also poisons the protected set the Storage auto-clean sweep builds, so real library tracks can be marked deletable cache.
- The auth trio (2f3f6df, 03d2065, 1df6deb) fixes the signed-out-after-sleep family in code develop still shares nearly verbatim; the wall-clock refresh loop matters on macOS too because tokio timers ride Instant, which stalls across mac sleep.
- Biggest feature win is f9671eb: YouTube Music's own synced lyrics keyed on videoId, which structurally cannot return another song's words. The scorer stack (f99e71c, 62ed3c3, a9f4d15) is a wholesale replacement of our matching layer; decide it separately and, if adopted, take it from upstream tip as a unit, with 0285415's measurement doc as the evidence file (its data says our shipped scaleTimedLines drifts 3-5s late-song).
- Skip the upstream-hosted share page (SHARE_BASE hardcodes nuber-dev.github.io and funnels to their build) and the Windows thumbbar pair; b4821a9 and the ytdlp.rs half of 14e98fe are already in via our b4bd70e, and the memory note that our media keys go through now_playing.rs is stale, develop already runs the 3a9db77 architecture.

## Verdict table

| sha | topic | title (short) | verdict | effort |
|---|---|---|---|---|
| 2f3f6df | auth | harden refresh loop + cookie jar | conflicts_rework | medium |
| 03d2065 | auth | no sign-in button on failed session check | take | medium |
| 1df6deb | auth | login stuck on bare music.youtube.com | take | trivial |
| 3ceaddb | lyrics | LRCLIB reachable again, stop caching failures | conflicts_rework | medium |
| f9671eb | lyrics | YT Music's own lyrics as first source | conflicts_rework | medium |
| 420e7e4 | lyrics | parse YTM metadata into lookup metadata | conflicts_rework | small |
| f99e71c | lyrics | score candidates, not first-plausible | conflicts_rework | large |
| 62ed3c3 | lyrics | find re-uploads hiding artist in title | conflicts_rework | small |
| a9f4d15 | lyrics | romanized Cyrillic artists | skip | small |
| 0285415 | lyrics | scorer design/measurement doc | take | trivial |
| b1670b7 | lyrics | lyrics follow slider while scrubbing | conflicts_rework | medium |
| ee86b26 | lyrics | keep scaled active line in column | conflicts_rework | trivial |
| bb3cce9 | lyrics | bottom fade from first line | already_have | trivial |
| 0026eb4 | library | follow paging tokens, full libraries | take | small |
| bd24565 | library | playlist search on shared Input | take | trivial |
| 661108e | library | drop page pin button, rename to "top" | skip | small |
| 077d5ce | player+menus | Discord presence down when paused | take | small |
| 887d8f4 | player+menus | submenu row alignment + regen test | take | trivial |
| fa6ba3d | player+menus | album context/header menus | take | small |
| 24f1c42 | player+menus | liked heart sync race | conflicts_rework | medium |
| be906dc | player+menus | cover right-click menu + Download cover | conflicts_rework | medium |
| 3a9db77 | player+menus | macOS media keys drive the queue | already_have | trivial |
| 0e8e4b8 | polish | ArtworkOutline component | take | small |
| 938d7fc | polish | cover/shell card polish | conflicts_rework | small |
| a592c3a | polish | isolate fix for lyrics blur | conflicts_rework | trivial |
| 4f72a58 | polish | frosted glass menus | take | small |
| 1f6fa8b | polish | seek bar visible in light theme | conflicts_rework | small |
| 7637a14 | polish | What's New no auto-focus | take | trivial |
| 1cec8e0 | polish | equal side insets (scrollbar-gutter) | already_have | trivial |
| 97bb6e7 | share | ytubic:// deep links + share page | conflicts_rework | medium |
| 0d99d26 | share | album/playlist share buttons | skip | medium |
| 6e0bbe8 | share | Share in track menu | already_have | trivial |
| c3f7b27 | platform | dev bundle identifier | conflicts_rework | small |
| 14e98fe | platform | unpin dead yt-dlp clients | already_have | trivial |
| b4821a9 | platform | yt-dlp onedir build (0.3s spawns) | already_have | trivial |
| 375a084 | platform | Windows taskbar thumbnail toolbar | skip | large |
| ceddfd5 | platform | thumbbar launch-crash fix | skip | medium |

Pre-verdicted skips (release/docs/branding chores): 28c7cc7, aee8da0, adfa1fe, 77de87e, b3fe720, bff1223, d5285d3, 8fd9f33, 503df04, 88fdf33, 8455acc, b395eaf, 44dab6e.

## 1. Auth and session recovery (highest priority)

**What upstream did.** Jul 30 to Aug 19 they fixed the exact "opens signed out after sleep/shutdown" family. 2f3f6df is the Rust half: atomic temp+fsync+rename writes for cookies.enc/accounts.json (a torn write reads as signed-out), the sleep(20min) refresh loop replaced by a wall-clock deadline on a 60s tick with 30/120/300s backoff, a new `power.rs` (Windows suspend/resume signals, harmless stubs elsewhere), refusal of Set-Cookie deletions of identity cookies plus the RFC 6265 domain check, a keeper page-load wait before trusting snapshots, and exact-name `header_has_auth_cookie` replacing the substring `is_logged_in` (the __Secure-1PSID-is-a-prefix-of-__Secure-1PSIDTS bug). 03d2065 is the designed frontend half: session checks throw on transport failure instead of resolving null, one shared query triad (retry 3, refetchOnReconnect) across all seven call sites, a pure tested `accountSlot()` so the sidebar only shows sign-in on an authoritative answer, a session-refreshed listener, and it stops a failed `get_active_account_id` emptying pinned playlists. 1df6deb fixes login parking on a bare music.youtube.com by replaying the ServiceLogin URL; the real change is 10 lines (the 8187-line stat is a bundled CRLF-to-LF rewrite of lib.rs).

**Where develop stands.** The pre-fix baseline, nearly verbatim: substring `is_logged_in` at `src-tauri/src/lib.rs` ~1364, bare `tokio::fs::write` in write_index/login capture/refresh, no domain check in `merge_set_cookies_into_jar`, the old sleep loop at ~4384-4400, `catch { return null }` in `src/lib/innertube/account.ts`, EMPTY_AUTH cached on failure in `src/lib/innertube/shared.ts` ~143. Our refresh worker and jar-rotation logging ARE this baseline, not an equivalent. The standby bug is ours too: tokio Instant stalls across macOS sleep. Our only nearby divergences are `ytdlp_cookie_file` (~526-577) and the macOS Safari login UA (~987), neither overlapping the changed logic.

**What to do.** Take all three. 2f3f6df first with `-Xignore-cr-at-eol` (upstream lib.rs was CRLF until 1df6deb); expect small context conflicts at the read_cookies_plain trailing context, the imports hunk, and the setup() block near our stream-server code. Then 03d2065 (one manual merge in `app-sidebar.tsx` ~482-495 next to our sign-out dialog hooks; its listener and canRefresh prompt read 2f3f6df's event and field, confirmed 2f3f6df is its ancestor). 1df6deb any time as a 3-edit hand-apply; do not take its line-ending rewrite. Run cargo test plus vitest after (both bring tests). Optional later: wire NSWorkspace didWakeNotification into power.rs's Notify.

## 2. Lyrics pipeline

Upstream rebuilt the whole pipeline in ten commits the week after we detached, and it partially collides with our own post-fork lyrics work (timeouts, hitMatches, qualifier-aware picks, auto-align.ts, the Apple Music fullscreen view). Four separate decisions:

**a) Transport and failure semantics, 3ceaddb (urgent piece).** I confirmed this session that `develop:src-tauri/tauri.conf.json`'s connect-src is 'self' + localhost only, `capabilities/default.json` has no lrclib entry, and `src/lib/lyrics/lrclib.ts`'s own comment says it uses the webview's plain fetch. So LRCLIB requests are CSP-blocked in the packaged .app (not verified on a running build, but the config forbids them, and he runs the packaged .app per tauri.macos.conf.json). Minimal fix is one line (add https://lrclib.net to connect-src) or port their tauriFetch move + capability entry + Lrclib-Client header. Second half: our `musixmatch.ts` and `genius.ts` still `catch { return null }` on transport failures while `src/App.tsx` persists query results to IndexedDB with 24h gcTime, so one flaky moment gets cached as "no lyrics" for a day. Adapt their throw-for-retryable / return-only-real-answers rule and rate-limit classification into our diverged provider files; the per-source Try-again UI needs lyrics-view work.

**b) YTM provider, f9671eb (biggest win).** Two anonymous InnerTube hops get YouTube Music's own line-synced lyrics, keyed on videoId so wrong-song lyrics are structurally impossible; ANDROID_MUSIC client context returns synced lines where WEB_REMIX gives plain text. `music.youtube.com/*` is already in our capabilities (line 12). ytmusic.ts ports nearly clean but imports three helpers from 3ceaddb's http.ts, so port http.ts first or shim them with our existing timeout signal. Wiring into our `sources.ts`/`lyrics-view.tsx` is mechanical (4th videoId-keyed query, SOURCE_ORDER/labels/loadPref); fix the shared hardcoded-source-list loadPref bug while there.

**c) Query metadata, 420e7e4.** We built the subtitle-to-artist half ourselves (`artistLineFromSubtitle` in `src/lib/utils.ts:25`) but have zero title cleaning at query time; `sources.ts` sends `track.title` verbatim to every provider, which is the retrieval failure upstream measured. Port `cleanTrackTitle` + `stripTopicSuffix` from their self-contained track-meta.ts and swap our two call sites (`sources.ts`, `lastfm.ts`); unifying our helper into it is optional.

**d) Scorer stack, f99e71c + 62ed3c3 + a9f4d15 (decide as a unit, later).** A wholesale replacement of our matching layer, and its measured criticisms genuinely hit our code: our Jaccard scores "Stay" vs "Stay Stay Stay" at 1.0, `normalizeForMatch` strips all parentheticals at compare time, and our `scaleTimedLines` in lrclib.ts is exactly the tempo rescaling their four measured pairs say drifts 3-5s by the last line. If adopted, take match.ts/score.ts from upstream tip as one unit (tip folds in 62ed3c3 and a9f4d15), renumber cache keys, and explicitly decide the fate of scaleTimedLines and our auto-align.ts. If not adopted, graft 62ed3c3's reattribution retry standalone (~30 lines onto our lrclib.ts): it re-reads "Artist - Title" uploads whose artist field holds an uploader channel, which is common in Punjabi/Hindi uploads, his actual library. a9f4d15 stays skip either way (strictly Cyrillic-gated, near-zero value for him; rides along free if the stack is taken). 0285415, the 773-line measurement doc, is a clean take right now regardless: it is the evidence file for the scaleTimedLines decision. The numbers in it are upstream's claims, not verified here.

**e) View UX.** b1670b7 (lyrics follow the thumb while scrubbing) is a real gap: both our player bars hold scrub as local useState and `scrub.ts` doesn't exist on develop (confirmed). The 25-line store and bar wiring port nearly clean; the lyrics-view half must be re-derived against our reworked view and the fullscreen player from our c8bf064, which has its own slider to wire. ee86b26 is a one-line adaptation (our px-1 to pl-1 pr-[4%], we scale 1.04 not 1.06) next time lyrics-view is open. bb3cce9 we already built in c8bf064, same mechanism and gate, different gradient stops; nothing to take.

## 3. Library paging and playlist UI

**0026eb4 is the single cleanest high-value pick in the whole set.** Our `src/lib/innertube/library.ts` and `mutations.ts` are byte-identical to its parent (re-verified this session with blob diffs), so every library shelf and the Add-to-playlist submenu stop at the first browse page (~25 rows). Fork-specific kicker: our own `fetchLibraryTracks` builds the protected set for the Storage auto-clean sweep from these fetchers, so truncation marks real library tracks as deletable cache. The shared.ts hunks land in non-diverged regions and a 203-line vitest file comes along. Verify against a real account after; a small library may not paginate. bd24565 (playlist search field onto the shared Input) is a trivial clean take, exact pre-image present at `src/routes/playlist.$id.tsx` ~526. Skip 661108e: it conflicts with our share-button-less header, and in our fork the page pin button is the only pin entry point for playlists not in the library (our own app-sidebar comment says so). If the "Pin to top" wording appeals, that is a 2-string hand edit in app-sidebar.tsx, no pick needed.

## 4. Player, menus, Discord

Clean takes: 077d5ce (Discord card stood at "Listening to YTubic" hours after pause; `discord.rs` byte-identical to parent, confirmed, and the audio-engine effect matches textually) and 887d8f4 (missing gap-2 on the context-menu sub-trigger; base file byte-identical, confirmed, plus a source-grep test that guards against shadcn regen). fa6ba3d (album right-click + header menus, every prerequisite present) lands mostly clean but its new album-menu.tsx imports `ctxPrimitives`, which on develop is an unexported const at `src/components/shared/track-context-menu.tsx:104` (confirmed); add the `export` keyword or the build fails.

Reworks: 24f1c42's heart-flip race is live in our build (cold-start ["liked-songs"] fetch resolving after an optimistic patch clobbers it; zero cancelQueries anywhere in src), but it cannot be cherry-picked: it sits on like-actions.ts, a file created by the skipped Windows-toolbar commit 375a084 (ancestry confirmed), and like-actions.ts is absent on develop (confirmed). Hand-port the ~10-line cancel-at-commit + invalidate-if-interrupted dance into our 4 inline mutation sites (like-buttons.tsx onLike ~84-100, track-context-menu.tsx runLike/runRemoveRating/runDislike ~153-192); skip their jsdom test. be906dc (cover right-click menu + Download cover) is worth having on a personal music app: take player-cover-menu.tsx and the cover-art.ts/bottom-bar pieces nearly as-is, hand-wrap our restructured CoverArt sub-component in player-bar.tsx, and write the `download_cover` command against our own richer SSRF module (lib.rs 2594-2830) instead of taking their lib.rs refactor; consider wrapping our fullscreen-player cover too.

3a9db77 (macOS media keys) is already_have: develop already gates `media::init` to windows/linux, deliberately stopped calling now_playing::init, and drives navigator.mediaSession from audio-engine.ts with per-action try/catch upstream lacks. The memory-file claim that our media keys go through now_playing.rs is stale; update `ytubic_upstream_divergence.md` when closing this out.

## 5. Visual polish

Five of seven are worth having, none deserve a skip, and conflict risk is low: dialog.tsx, dropdown-menu.tsx, entity-page-header.tsx and the whats-new context are identical to the pre-images. Apply in dependency order: 0e8e4b8 first (ArtworkOutline; the six copy-pasted hairline sites exist verbatim on develop), then 938d7fc with a592c3a's `isolate` folded into the adaptation (inseparable: taking 938d7fc without it ships a lyrics-blur regression, because the blending outline promotes the wrapper that contains cover AND lyrics into a backdrop root). The only real rework in 938d7fc is our player-bar CoverArt sub-component; the entity-header and bottom-bar hunks land clean. Then 4f72a58 (frosted menus + submenu portals; goes after 887d8f4, which is its ancestor, so context-menu.tsx matches its pre-image), then 1f6fa8b by hand: we ship the light theme and with our thumbless seek bar the entire unplayed track vanishes in light mode, not just the thumb; our slider.tsx has the thumb class inside a ternary and player-bar.tsx has FOUR bg-white/20 overrides vs their three (our extra horizontal volume row), so it is class swaps plus one extra site. 7637a14 is a 4-line clean take. 1cec8e0 is already on develop as c6c41b2, identical patch-id 696f8214 (re-verified this session). Eyeball light theme, one submenu, and the lyrics blur afterwards.

## 6. Share and deep links

The share page is upstream infrastructure: SHARE_BASE hardcodes `https://nuber-dev.github.io/YTubic/s/`, the page footer links NUber-dev's releases, and a private fork cannot serve its own docs/ on Pages, so every shared link would depend on their domain and advertise their build. We already have the plain-URL half (copyTrackLink "Copy link" in track-context-menu.tsx, shared with the player menu), so 6e0bbe8 is already_have (its only delta, an execCommand clipboard fallback, has no observed need) and 0d99d26 is a full skip. The one piece worth rework-taking from 97bb6e7 is the ytubic:// deep-link plumbing: `deep-link.ts` + `use-deep-links.ts` apply near-verbatim as new files plus ~6 small edits (Cargo.toml, package.json, capabilities, tauri.conf plugins block, lib.rs plugin init, app-shell hook), letting scripts and notes open or play tracks in the app. Drop SHARE_BASE/universalShareUrl, keep copying plain music.youtube.com URLs. A raw cherry-pick is hopeless anyway: the commit converts track-context-menu.tsx and tauri.conf.json to CRLF against our LF tree. macOS caveat: runtime scheme registration is cfg'd for linux/windows-debug, so the scheme comes from Info.plist at bundle time; works in the bundled .app, not `tauri dev`.

## 7. Windows, yt-dlp, dev identity

Mostly settled history. b4821a9 (yt-dlp onedir, 0.3s spawns) plus the ytdlp.rs half of 14e98fe came in verbatim via our b4bd70e, and develop's ytdlp.rs is now a strict superset (our deno js_runtime_args on top); 14e98fe's lib.rs half was independently done same-day as our 90f1f32, and ours is better adapted (cookie-authenticated spawns, Premium 774/141 format ladder, ios pin kept only for the HLS video path). One sliver to remember: our bare bestaudio selector tails carry no `[protocol^=http]` guard, a one-line hardening if uncached playback ever yields unplayable bytes. Skip 375a084 + ceddfd5 as an inseparable pair unless a Windows build ever becomes real: the whole Rust surface is cfg(windows), the frontend half grinds against our +1060-line audio-engine.ts divergence, and 375a084 alone shipped a launch-abort bug that ceddfd5 fixes. c3f7b27's dev-bundle-identifier idea is worth having (we use single-instance and share data dirs in dev) but must be re-cut by hand, never picked: on top of our c77ae57 identity rename, a dev instance configured as `*.ytubic.dev` would run `identity::migrate()` and rename a not-yet-migrated release install's data into the dev sandbox, factory-resetting the real app. Recreate it as tauri.dev.conf.json with `com.github.yuvrajangadsingh.ytubic.dev`, an npm (not pnpm) script, and a guard so migrate() no-ops unless the configured identifier equals the canonical release id. The guard is the part that matters.

## Cross-agent sanity check

No two topics claim the same file with conflicting verdicts. The overlaps that exist corroborate each other, and I re-verified the load-bearing ones with git this session:

- **like-actions.ts**: topic 4 says 24f1c42 sits on a refactor from the Windows toolbar work; topic 7 independently identifies 375a084 as that refactor's origin and skips it. Confirmed: 375a084 is an ancestor of 24f1c42 and the file is absent on develop. Hand-port is the only route; both agents converge on it.
- **album-menu.tsx**: fa6ba3d (take) creates the file that 0d99d26 (skip) edits. Consistent: 0d99d26 stays skip because its content targets the upstream share page, and after fa6ba3d lands, plain-URL album sharing would be a small fresh edit if ever wanted.
- **context-menu.tsx**: topic 4 says develop is byte-identical to 887d8f4's parent (confirmed); topic 6 says develop differs from 4f72a58's pre-image only by that gap-2. Both true because 887d8f4 is an ancestor of 4f72a58 (confirmed). Pick 887d8f4 first.
- **player-bar.tsx is the contended file**: b1670b7, be906dc, 938d7fc/a592c3a, and 1f6fa8b all rework it. No verdict conflict, but sequence them (polish pass, then cover menu, then scrub) or each one re-conflicts with the last.
- **6e0bbe8 vs 97bb6e7**: upstream itself replaced 6e0bbe8's plain-URL share with the share page three days later; keeping our copyTrackLink and taking only the deep-link half resolves both verdicts cleanly.
- **Stale brief note**: topic 4's finding that develop no longer calls now_playing::init contradicts the task brief's framing, in develop's favor. The `ytubic_upstream_divergence` memory (which called b4821a9 "the one cherry-pick worth doing") is now doubly stale: that pick happened (b4bd70e), and this report supersedes the assessment.
- **My spot checks (git only, nothing built or run)**: 50/127 commit counts; all 50 shas resolve; blob-identity for 0026eb4 (library.ts, mutations.ts), 077d5ce (discord.rs), 887d8f4 (context-menu.tsx); patch-id 1cec8e0 == c6c41b2; like-actions.ts and store/scrub.ts absent; ctxPrimitives unexported at track-context-menu.tsx:104; no lrclib.net in tauri.conf.json connect-src or capabilities/default.json while lrclib.ts documents using webview fetch; three ancestry relations above. All held.

## Cherry-pick plan

Mechanics for every pick: use `-Xignore-cr-at-eol` (upstream's CRLF era vs our LF tree), rewrite picked commit messages to drop the Co-Authored-By/AI attribution lines upstream carries (at least 0026eb4 has one), run `cargo test` + vitest after each phase, and manually check the packaged behaviors a phase touches. Must-travel-together sets: {2f3f6df then 03d2065}, {0e8e4b8, 938d7fc, a592c3a}, {3ceaddb's http.ts before f9671eb, or shim}, {f99e71c + 62ed3c3 + a9f4d15 + 420e7e4 from tip, all or none}, {375a084 + ceddfd5, skipped as a pair}, {fa6ba3d + the one-word ctxPrimitives export}.

**Phase 1, clean picks (byte-identical or matching bases, land with at most line fuzz):**
1. `0026eb4` library paging. Real bug, protects the storage sweep, bundled tests.
2. `077d5ce` Discord pause.
3. `887d8f4` submenu gap-2 + regen-guard test.
4. `bd24565` playlist search Input.
5. `7637a14` What's New focus.
6. `0285415` scorer measurement doc (new file; the evidence for the phase 6 decision).
7. `1df6deb` login nudge, as a 3-edit hand-apply so the CRLF rewrite never enters the tree.

**Phase 2, auth pair (this order):**
8. `2f3f6df` rework: expect conflicts at read_cookies_plain context (our ytdlp_cookie_file), imports, setup block.
9. `03d2065` take: one manual merge in app-sidebar.tsx. cargo test + vitest.

**Phase 3, lyrics transport (the urgent minimal fix can even jump the queue):**
10. `3ceaddb` rework: add lrclib.net to connect-src + capability (or port the tauriFetch move) immediately; then adapt throw-vs-value + rate-limit semantics into our musixmatch.ts/genius.ts so failures stop being cached 24h as "no lyrics".
11. `f9671eb` rework: YTM provider, after http.ts exists or with a 3-helper shim.
12. `420e7e4` rework: title cleaning, two call-site swaps.

**Phase 4, menus:**
13. `fa6ba3d` take + export ctxPrimitives (build fails without it).
14. `24f1c42` hand-port (~10 lines into 4 inline sites; no cherry-pick possible).
15. `be906dc` rework: cover menu + download_cover against our SSRF helpers.

**Phase 5, polish (dependency order):**
16. `0e8e4b8`, then 17. `938d7fc` with 18. `a592c3a` folded in (never one without the other), then 19. `4f72a58`, then 20. `1f6fa8b` by hand. Eyeball light theme, a submenu, lyrics blur.

**Phase 6, lyrics UX + the scorer decision:**
21. `b1670b7` rework: scrub store + bars clean, lyrics-view half re-derived (fullscreen slider too).
22. `ee86b26` one-liner, fold into whichever lyrics-view touch comes first.
23. Read 0285415, then decide: adopt f99e71c + 62ed3c3 + a9f4d15 from upstream tip as one unit (large; replaces match.ts, retires scaleTimedLines, re-judges auto-align.ts) or keep our matcher and graft only 62ed3c3's reattribution retry (~30 lines, real value for Punjabi/Hindi re-uploads).

**Phase 7, optional plumbing:**
24. `97bb6e7` partial rework: deep-link.ts + use-deep-links.ts + 6 config/lib.rs edits; drop the share page, keep plain YTM links. Bundled-.app only on macOS.
25. `c3f7b27` re-cut by hand with our dev identifier and the identity::migrate() guard. Do not naive-pick; it can rename the release install's data into the dev sandbox.

Skips stay skipped: a9f4d15 (rides the scorer or nothing), 0d99d26, 661108e (2-string hand edit if the wording appeals), 375a084 + ceddfd5 (revisit only if Windows ever matters, and only as a pair), plus the 13 chores. Already_have needs nothing: bb3cce9, 6e0bbe8, 3a9db77, 1cec8e0, 14e98fe, b4821a9.

## Shortlist (machine copy)

- `0026eb4` fix(library): follow the paging tokens so big libraries load in full — small — Library shelves and the Add-to-playlist submenu truncate at ~25 rows on files byte-identical to upstream's parent (verified), and the truncation poisons the protected set our Storage auto-clean sweep builds; cleanest highest-value pick, bundled tests.
- `077d5ce` fix(discord): take the presence down when playback is paused — small — Discord card stays at 'Listening to YTubic' for hours after pause; our discord.rs is byte-identical to the parent (verified) and the audio-engine hunk context matches verbatim.
- `887d8f4` fix(ui): align the submenu row in the track right-click menu — trivial — Missing gap-2 on the context-menu sub-trigger, base file byte-identical (verified), plus a regen-guard test; also makes 4f72a58 apply to its exact pre-image.
- `1df6deb` fix: login stuck on a bare music.youtube.com after Google auth — trivial — Login nudge replays the ServiceLogin URL so cookie exchange completes every time instead of ~half; real change is 10 lines, hand-apply the 3 edits and skip the bundled CRLF-to-LF rewrite.
- `bd24565` feat(ui): put the playlist search field on the shared Input — trivial — Pure consistency win; the exact pre-image sits at src/routes/playlist.$id.tsx ~526 and our divergence is elsewhere in the file.
- `7637a14` ui: don't auto-focus the first entry in the What's New dialog — trivial — 4-line clean take; our whats-new-dialog.tsx context matches verbatim and our focusVersion effect only scrolls, so nothing breaks.
- `0285415` docs: record the measurements behind the lyrics scorer — trivial — New file, applies clean regardless of the scorer decision; its tempo-rescaling data judges our shipped scaleTimedLines (3-5s late-song drift) and is the evidence file for phase 6.
- `2f3f6df` fix(auth): harden the session refresh loop and the cookie jar — medium — Our lib.rs is the exact pre-fix baseline; the wall-clock refresh loop fixes mac standby staleness (tokio Instant stalls across sleep), plus torn-write, identity-cookie and substring is_logged_in fixes; expect small context conflicts around ytdlp_cookie_file, imports, setup.
- `03d2065` fix(auth): stop showing a sign-in button when the session check merely failed — medium — The actual signed-out-after-sleep frontend fix; every bug it describes exists on develop verbatim; take after 2f3f6df (its ancestor, verified), one manual merge in app-sidebar.tsx.
- `3ceaddb` fix(lyrics): reach LRCLIB again, and stop caching failures as no-lyrics — medium — LRCLIB is CSP-blocked in our packaged .app (lrclib.net absent from connect-src and capabilities while lrclib.ts uses webview fetch, config gap verified this session), and musixmatch/genius still persist transport failures to disk as 'no lyrics' for 24h; minimal CSP fix is one line.
- `f9671eb` feat(lyrics): add YouTube Music's own lyrics as the first source — medium — Line-synced lyrics keyed on videoId, structurally cannot return the wrong song; music.youtube.com already in our capabilities; port 3ceaddb's http.ts first or shim its three helpers, then mechanical wiring.
- `420e7e4` feat(lyrics): parse YTM display metadata into lookup metadata — small — We built the artist half ourselves but have zero title cleaning at query time (sources.ts sends track.title verbatim), the exact retrieval failure upstream measured; port cleanTrackTitle/stripTopicSuffix and swap two call sites.
- `fa6ba3d` feat(album): give albums the same menus songs already have — small — Album cards and the album page get Play/Shuffle/Play next/Queue/Radio menus; lands mostly clean but needs ctxPrimitives exported at track-context-menu.tsx:104 (unexported const, verified) or the build fails.
- `24f1c42` fix: keep the liked heart in sync after context-menu likes — medium — The heart-flip race is live in our build (zero cancelQueries in src); cherry-pick impossible because its base file comes from skipped 375a084 (ancestry verified), so hand-port the ~10-line cancel-at-commit dance into our 4 inline mutation sites.
- `be906dc` feat(player): open the track menu on right-click of the cover — medium — Cover right-click menu plus a Download cover command; take player-cover-menu.tsx nearly as-is, hand-wrap our restructured CoverArt, and write download_cover against our own richer SSRF module instead of their lib.rs refactor.
- `0e8e4b8` refactor(ui): extract the adaptive artwork outline into one component — small — The six copy-pasted hairline sites exist verbatim on develop; foundation for 938d7fc/a592c3a, pick it first in the polish pass.
- `938d7fc` feat(ui): polish the covers and shell cards in the player and header — small — Radius/shadow/outline polish where entity-header and bottom-bar hunks land clean; only the player-bar cover hunk needs adapting into our CoverArt sub-component; fold a592c3a in while adapting.
- `a592c3a` fix(player): stop the cover outline from darkening the lyrics blur — trivial — The isolate fix that keeps ArtworkOutline's blending from flattening the lyrics backdrop-blur; inseparable from 938d7fc, taking one without the other ships a regression.
- `4f72a58` feat(ui): put the menus on the same frosted glass as the dialogs — small — Frosted surface tokens for menus and search suggestions plus the submenu Portal fix; near-clean after 887d8f4, and all our extra menus inherit the glass automatically.
- `1f6fa8b` fix(player): make the seek bar visible in the light theme — small — We ship the light theme and with our thumbless seek bar the entire unplayed track is invisible there today; hand-port the token swap around our slider ternary plus our fourth bg-white/20 override site.
- `b1670b7` feat(lyrics): follow the progress slider while scrubbing — medium — Our lyrics freeze during drags (both bars hold scrub as local state, store/scrub.ts absent, verified); the 25-line store and bar wiring port clean, the lyrics-view half gets re-derived against our rework and the fullscreen player's slider.
- `ee86b26` fix(lyrics): keep the scaled active line inside the column — trivial — Same clipping physics in our tree at 1.04 scale; one-line adaptation (px-1 to pl-1 pr-[4%]), fold into the next lyrics-view touch.
- `f99e71c` fix(lyrics): score candidates instead of taking the first plausible one — large — Its measured criticisms hit our matcher (Jaccard scores 'Stay' vs 'Stay Stay Stay' at 1.0, parentheticals stripped at compare time), but it replaces match.ts wholesale; adopt from upstream tip as a unit with 62ed3c3/a9f4d15 or not at all, and decide scaleTimedLines and auto-align.ts explicitly.
- `62ed3c3` fix(lyrics): find re-uploads that hide the artist in the title — small — Reattribution retry for 'Artist - Title' uploads with a channel in the artist field, common in Punjabi/Hindi uploads; rides the scorer stack free, or a ~30-line standalone graft onto our lrclib.ts if the scorer is declined.
- `97bb6e7` feat(share): ytubic:// deep links and a universal share page — medium — Take only the deep-link plumbing (deep-link.ts + use-deep-links.ts near-verbatim plus ~6 config/lib.rs edits) for ytubic:// automation; drop SHARE_BASE and the nuber-dev.github.io landing page, keep copying plain YTM links; bundled-.app only on macOS.
- `c3f7b27` chore(dev): give the dev build its own bundle identifier — small — Real pain for us (single-instance plus shared data dirs in dev) but re-cut by hand with com.github.yuvrajangadsingh.ytubic.dev and a guard so identity::migrate() no-ops off the canonical id; a naive pick can rename the release install's data into the dev sandbox.
