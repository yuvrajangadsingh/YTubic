# Decisions

The long version. One entry per decision that shaped the app, newest first,
each with what was decided, the evidence it rested on, what was rejected and
why, and where it stands. `MAP.md` is the one-screen index of the same things.

Dates are when the decision was made. Numbers are the ones measured at the
time; they are quoted, not rounded up.

---

## 2026-09-06 · Windows support removed from the code

**Decided:** delete the Windows code, not just the CI job. Gone: the DPAPI
cookie store, the `CREATE_NO_WINDOW` spawn flags, the WebView2 browser args,
the AppUserModelID module, the nsis bundle target, the Microsoft Store icons,
the `windows-sys` dependency and the Windows entry in the release matrix.

**Why:** nothing has built for Windows since the CI job went on 2026-09-04, so
none of it was compiled anywhere. The gates were the real cost. Most of them
wrapped the mac and the Linux paths as much as the Windows one, so reading a
spawn call or the cookie store meant working out which of three platforms each
arm was for, and deleting the wrong half of one would have broken Linux
quietly.

**Kept:** Linux. It is the canary that catches non-mac Rust mistakes, and
`release.yml` is still the only workflow that bundles the deb, rpm and
AppImage. Two `cfg`s in `lib.rs` still name windows on purpose: the catch-all
plaintext arms of `encrypt` and `decrypt` for unsupported platforms. Leaving
the term in makes a Windows build fail at compile time instead of quietly
writing session cookies in the clear.

---

## 2026-09-04 · CI runs macOS and Ubuntu only

**Decided:** drop `windows-latest` from the CI matrix and from main's required
checks. Ubuntu stays.

**Why:** the app ships for macOS only. The Windows job was the slowest and it
blocked three PRs in one day over a test that used the `rand` crate, which is a
macOS/Linux-only dependency, so the test could never run on Windows. Ubuntu is
a one-minute canary that catches non-mac Rust mistakes cheaply.

**Trade accepted:** the Windows-only code paths (the DPAPI secure store,
`CREATE_NO_WINDOW` spawn flags) are no longer compiled anywhere. They compile
again the day Windows is a target.

---

## 2026-09-04 · WebKit's window occlusion detection is off

**Decided:** set WKWebView's private `_windowOcclusionDetectionEnabled` to
`false` on the main window at setup.

**Why:** every WebKit problem measured that day came from one state: the window
on another Space, macOS reporting it occluded, WebKit marking the page hidden.
From that state: rendering stopped (the Space thumbnail in Mission Control went
flat grey), timers slowed to one tick per several minutes (a one-minute
keepalive interval ran once per 4.5 minutes), a pending `play()` was aborted on
the visible-to-hidden edge (the desktop-switch stall of late August), and after
a long pause remote media commands were accepted by WebKit's GPU process and
never reached the page (`rcd: Command = <TogglePlayPause>` routed to
`com.apple.WebKit.GPU/<bundle id>`, accepted in 10 ms, no handler fired).

**Rejected first:** a page-level keepalive that re-asserted the media session's
metadata once a minute while paused. It failed its first real test: WebKit
throttled the keepalive's own timer, and an F8 press 65 minutes into the pause
still went nowhere. Removed the same day.

**Status:** in. The thumbnail and the timer cadence are checkable immediately.
Whether it ends the media-key dead zone needs a real long pause to prove. The
structural fix remains native audio playback in Rust (Linear ME-34), where the
app owns the Now Playing session outright and none of this exists.

---

## 2026-09-04 · The storm breaker silences the app, then resets the element

**Decided:** if the media element flips play/pause 8 times inside a second, the
app goes silent for 5 seconds both ways (element events are not echoed into the
store, the store is not enforced on the element). If the element kept flipping
on its own during those 5 seconds, the media element is hard-reset (source
dropped, `load()`, source re-installed through `retryNonce`). If it went quiet,
the element is reconciled once to the store. OS play/pause/toggle commands
during the hold are deferred and applied after, never dropped; next, previous,
seek and stop pass through.

**Why:** twice in one day the element flipped play/pause about four times a
second for minutes (500+ cycles the second time). Every "element playing under
a paused store" line came before any `play()` of ours, so the flips were
WebKit's, released as a burst of media commands it had been holding, and the
app was echoing each one. The first breaker only gated OS commands, which
changed nothing and swallowed real presses (Codex review finding #11).

**Status:** in. Not reproducible on demand; the log lines `play/pause storm`,
`storm persisted` and `storm settled` are the evidence to look for.

---

## 2026-09-04 · Plays go before prefetch; a waiting play promotes its prefetch

**Decided:** prefetch resolves take a single background slot and hold off while
any play resolve is running, bounded at 45 seconds; a prefetch that cannot get
the slot in time is skipped, never run without a permit. A play that arrives
while its own prefetch is still queued marks the id as wanted, and the queued
resolve promotes itself to foreground instead of making the play wait behind
it. Play resolves never wait.

**Why:** resolves that overlapped another resolve exceeded 15 seconds twice as
often as lone ones (9% vs 4.4%), and nothing capped concurrent yt-dlp
processes. Codex's review of the first version found two holes: a timed-out
wait proceeded *without* a permit (so every queued prefetch stampeded at once),
and a play joining a queued prefetch inherited background priority and could
wait 45 seconds before resolving.

**Rejected:** a plain one-permit semaphore. A click behind a prefetch would wait
up to the full resolve timeout, the worst outcome of all.

---

## 2026-09-04 · Resolve hedge at 12 seconds, degraded results never cached

**Decided:** a signed-in resolve still running at 12 seconds gets an anonymous
resolve started beside it, and whichever finishes first wins. An anonymous
winner is served for that play only: its file is marked `.degraded`, evicted
the moment playback moves to another track, and never treated as the cached
copy. A signed-in resolve that hits its 30-second ceiling falls back to an
anonymous resolve (15-second ceiling) rather than retrying the same way.

**Why:** over 279 resolves the signed-in path had a median of 5.0s and a 90th
percentile of 11.5s, but on a bad afternoon it hung to 18s, 29s, 41s and 98s
for single clicks. The anonymous path measured 2.0s when the network was
healthy. Retrying the same signed-in path (tried first) made a 30-second hang
into 60. 12s is the p90, so about one fetched play in ten hedges and the price
is the anonymous tier (130k) on a play that was already slow. His choice over
15s.

**Caveat found the same evening:** when the link itself is bad, the anonymous
path hangs too (measured: 2 of 5 plain connections to youtube.com failing, the
others taking up to 7.5s). No app-side change produces sound through that.

**Rejected:** caching the anonymous winner. Codex pointed out that it would make
every later replay of that track 130k. Hence the marker and eviction, with the
marker committed before the rename so a crash cannot leave an unmarked low-tier
file as the permanent copy.

---

## 2026-09-04 · Lyrics results pass a plausibility gate

**Decided:** every provider result passes `plausibility.ts` before it can be
shown. Three or more of the opening lines being known site chrome ("Menu",
"Home", "Privacy Policy"...) rejects it; two, plus a run of one-word nav-style
labels, also does. Terms are counted distinct, so a repeated hook is one word.
All four provider cache keys were bumped so persisted entries pass the gate.

**Why:** "Night Out" by Arjan Dhillon showed `Menu / Home / News / Quiz /
Charts / Stories / SWITCH SKIN / You Are Here` as lyrics. Every one of LRCLIB's
four records for the track begins that way; someone uploaded a lyrics site's
navigation as the words. Community databases will always hold a few of these.

---

## 2026-09-04 · The cookie key is a file, not a keychain item (macOS)

**Decided:** the 32-byte key that encrypts the cookie jar lives in `cookie.key`
in the app data directory, mode 0600. The first run of that build takes the
key from the existing keychain item (one last dialog) and never touches the
keychain again. A key file of the wrong size is an error, never replaced. While
an encrypted jar exists, only a keychain candidate that opens it is accepted
and none is ever minted.

**Why:** a keychain item's access list is keyed to each build's code hash when
the app has no Apple Team ID, so every rebuild and every update put up the
"YTubic wants to access key" dialog, and one morning the first play after a
relaunch waited 99 seconds on it. Tested and ruled out: a certificate with an
OU does not yield a TeamIdentifier. The only in-keychain fix is an Apple
Developer ID ($99/yr).

**Why a file is not a downgrade here:** the jar is already written to disk in
plaintext for yt-dlp (`ytdlp-cookies/cookies.txt`, 0600, refreshed on every
play). The keychain was guarding a key whose product sat on disk beside it.

**The Aug 31 lesson baked in:** minting a fresh key beside an existing jar
made an intact jar read as signed-out. That path is now an error, and every
keychain candidate is checked against the jar rather than the first one found
winning.

---

## 2026-09-04 · Native audio playback in Rust is the fix for everything WebKit-shaped

**Decided (direction, filed as ME-34, High):** the first chunk of the Rust port
worth doing is moving playback out of the webview: decode and output audio in
the Rust process, register the app's own Now Playing session, leave the webview
to draw the UI.

**Why:** the media element inside WKWebView means WebKit owns the Now Playing
session, the media keys, hidden-page throttling and rendering. Upstream hit the
same wall and wrote it down (their commit 3a9db77: WKWebView publishes its own
session the moment the element plays and it cannot be suppressed). Every
page-level workaround tried since has either half-worked or failed.

---

## 2026-09-04 · The launch chain, parked behind the rename

**Decided (filed as ME-30 to ME-33):** rename first, then a release page a
stranger can download from in one click, then one true sentence about what
this does that the original doesn't, then pitch the outlets that covered the
original.

**Why:** upstream's 285 stars came from press (Android Authority, Gadget
Hacks, two listings), not from an audience: the account has 2 followers. This
repo introduces itself as "macOS port of YTubic", was a fork until late August
(forks are hidden from search and trending), and has never been posted
anywhere. The gap is identity and one launch moment, not features.

---

## 2026-09-03 · Anonymous fallback on a timed-out resolve (superseded)

**Decided then:** a timed-out signed-in resolve is retried once the same way.
**Superseded the next day** by the hedge above: the same-path retry cost a click
60 seconds instead of 30 when the signed-in path was the thing hanging.

---

## 2026-09-03 · A stall watchdog, 100 seconds

**Decided:** if a track is still wanted and the element has buffered nothing
after 100 seconds, reload the source once through `retryNonce`; a second stall
reports "The stream never started" instead of spinning. Keyed to the same load
generation as the resolve effect.

**Why:** a load that never produces a byte fires no `error` event, so the only
automatic retry (which hangs off `onError`) never ran, and one track sat on a
spinner at 0:00 forever with the server verifiably healthy and no request ever
reaching it. Root cause of that missing request was never found; the watchdog
makes it recoverable and logs the element state when it fires. 75 seconds was
the first value; the review showed the legitimate pre-byte budget (30s resolve,
15s fallback, ~31s of probe retries) exceeded it.

---

## 2026-09-03 · The auto-updater: three separate breakages, all fixed

**Decided:** generate our own updater keypair (passwordless; key id
`298F8824CAC01DC8`), store only the private key as a repo secret, replace the
public key in `tauri.conf.json`, and have the release workflow pass
`--config '{"bundle":{"createUpdaterArtifacts":true}}'` so only CI builds the
signed updater bundle.

**Why, in three parts:** the secrets had never been set; the config still
trusted *upstream's* public key while pointing at our own releases, so no
release built here could ever have been accepted; and `tauri.macos.conf.json`
disables updater artifacts on purpose (a local build has no key and would
fail), so tauri-action was tarring the `.app` itself, unsigned, and skipping
`latest.json` with the line "Signature not found for the updater JSON". No
release from this repo had ever been updatable.

**Verified:** the minisign key id decoded from the signature blob and from the
shipped public key match. 0.4.6 was the first release with `latest.json`.

---

## 2026-09-03 · Merge commits, never squash, for releases

**Decided:** release PRs merge to main with a merge commit.

**Why:** the contribution graph and GitHub code search count only the default
branch, and place each commit on its author date. Squashing 48 commits into one
made one square dated today; a merge commit backfilled Aug 25 to Sep 2 at their
real dates. (Main had been frozen at 0.4.3 since Aug 27 while the work sat on
develop; that is why nothing showed for a week.)

---

## 2026-09-02 · No cap on video resolution

**Decided:** video plays up to 4K when the track has it. PR #4, which proposed
a 1080p cap, was closed. Not to be re-proposed.

---

## 2026-09-02 · Video counterpart matching requires all three signals

**Decided:** a song's video (or a video's song) is accepted only if the title
matches (exact, contained, or token overlap with the artist and connector
tokens stripped), the artist is named on both sides (byline or inside the
upload title), and the duration is inside an absolute window *and* the longer
side is no more than 1.5x the shorter plus 30 seconds. No match beats a wrong
match.

**Why:** each signal alone had been fooled in the wild: a 0:38 song reached a
6:56 upload through a missing-duration escape hatch, and a mashup channel's
sibling upload won on a shared "x artist x channel Remix" suffix at +186
seconds, inside the old window.

---

## 2026-09-02 · YouTube Music's own lyrics first; upstream's scorer rejected

**Decided:** the lyrics source order is YouTube Music (looked up by videoId
over `/next` then `/browse` with the ANDROID_MUSIC client, which returns
line-synced rows where WEB_REMIX returns none), then LRCLIB, Musixmatch,
Genius. Titles are cleaned before lookup. A transport failure is a failure,
not a cached "no lyrics". Upstream's scorer rewrite was not taken.

**Why:** measured on 73 real cached tracks, upstream's scorer found zero tracks
ours missed, lost two, and the wrong-song rate was already zero for both. Title
cleaning was the only gain (55 → 57 tracks with lyrics, 47 → 49 synced). Their
measurement doc is kept in `docs/` as evidence.

---

## 2026-09-01 · Auth hardened, Codex-reviewed

**Decided:** exact cookie-name predicate for "signed in" (`__Secure-3PAPISID`
or `SAPISID`, the cookies the frontend signs with), atomic jar writes (unique
`O_EXCL` temp at 0600, fsync, rename, parent fsync), per-account mutation locks
with a fixed lock order, a wall-clock refresh schedule persisted to disk with a
60-second tick and separate retry backoff, and a dark-wake keychain failure
treated as "defer", not "failed".

**Why:** the refresh timer was measured stalling across sleep (gaps of 142 and
177 minutes on a 20-minute monotonic timer), and the previous sign-in check was
looser than what the app actually needs to sign requests. Ten blockers from the
Codex review were repaired before merge.

**Still unverified:** the sleep/wake path. The Mac has not slept once since
this landed.

---

## 2026-09-01 · Rename parked, not rejected

**Decided:** keep the name for now. 36 candidates were generated and judged;
the clear ones were radif, sneck and chapbook; the judge's order was radif,
gamak, sneck, chapbook, tarz. Full shortlist and icon directions in
`.notes/rename-shortlist-2026-09-01.md`. Reopened as ME-30 on Sep 4 as the
first step of any launch.

---

## 2026-08-31 · Own identity, with a migration

**Decided:** bundle identifier `com.github.yuvrajangadsingh.ytubic`, author
field, updater endpoint and keyring service all moved off the upstream
identifiers. `identity.rs` carries a pre-rename install's data over on first
launch: app data, caches, logs, and the macOS-specific `WebsiteData`,
`.binarycookies`, preferences and saved state, at the paths macOS pre-creates.

**Why:** the fork was detached (the previous commits never counted on the
contribution graph and never will) and the app is its own thing. The keychain
item moves only when the old one can be read; if it exists but cannot be read,
the run fails rather than minting a key that would orphan the jar.

---

## 2026-08-28 · Deno on PATH for yt-dlp, found by the app

**Decided:** `ytdlp::js_runtime_args()` locates deno (`~/.deno/bin`, Homebrew,
`/usr/local/bin`, PATH) and passes `--js-runtimes deno:<path>` to every yt-dlp
spawn.

**Why:** yt-dlp needs a JS runtime for YouTube's player challenge. A Dock
launch has a bare PATH, so signed-in extraction silently found no formats and
the anonymous retry hid it: the 271k tier only worked when the app was started
from a terminal. Node 20 is unsupported by yt-dlp for this; bun is not enabled
by default.

---

## 2026-08-28 · The desktop-switch stall

**Decided:** when `play()` rejects with `AbortError` while the track is still
current and the store still wants playback, retry at `canplay`. Every
`[web]` log line carries the element's visibility, readyState, networkState
and playhead.

**Why:** WebKit aborts a pending `play()` on the visible-to-hidden transition
and leaves the element paused; `canplay` then arrives with nobody listening.
Three earlier fixes had been made without seeing the element's side of it. The
occlusion-detection change of Sep 4 removes the transition itself.

---

## 2026-08-25 · Range proxy instead of download-then-play

**Decided:** the Rust stream server resolves a direct googlevideo URL with
`yt-dlp -j`, learns the exact size with a 1-byte probe, and serves ranges
immediately while a filler downloads into the same `.part`/rename contract;
above the fill line, ranges pass through to googlevideo. The legacy
download-everything-first path remains as the fallback.

**Why:** two constraints had forced serve-after-full-download: an unknown total
length making `Content-Range` invalid, and moov-at-end m4a needing a tail read
first. The probe answers the first and passthrough the second. Everything after
the resolve now costs about 0.4 seconds; the resolve is the whole wait.

---

## 2026-07-23 · macOS support, and the fork

**Context:** the macOS port was opened upstream as PR #33 (native window
chrome, Keychain-backed cookie encryption, platform-aware login and media
hooks, `tauri.macos.conf.json`). The maintainer folded it and a competing PR
into one commit of his own with co-author credit, shipped it as 0.4.0, and the
PR was closed from this side with the note that the fork would carry the
extras. A co-author trailer does not count toward GitHub's contributors list,
which is why this account does not appear there.
