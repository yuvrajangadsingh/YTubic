# YTubic, the map

One screen. Read this first if it has been a while. The long version of every
"why" is in `DECISIONS.md` next to this file.

## What this is

A native macOS YouTube Music client. Tauri v2: a Rust process (stream proxy,
auth, yt-dlp, cache) and a React/TypeScript UI in WKWebView. Forked from
NUber-dev/YTubic in July 2026, detached in August, now its own line. Upstream is
Windows-first; this is macOS-only on purpose.

## Where things live

| What | Where |
|---|---|
| Rust side (proxy, auth, cache, identity, media) | `src-tauri/src/` (`lib.rs` is big; `stream_proxy.rs`, `session.rs`, `authfs.rs`, `identity.rs`, `ytdlp.rs`) |
| Playback engine (the audio element, retries, storm breaker) | `src/lib/audio-engine.ts` |
| Lyrics (four sources, the site-chrome gate) | `src/lib/lyrics/` |
| InnerTube client | `src/lib/innertube/` |
| Release flow | `BRANCHING.md`, `.github/workflows/mac-release.yml` |
| App log (timestamps, no dates) | `~/Library/Logs/com.github.yuvrajangadsingh.ytubic/ytubic.log` |
| App data (encrypted jar, `cookie.key`, yt-dlp binary) | `~/Library/Application Support/com.github.yuvrajangadsingh.ytubic/` |
| Stream cache | `~/Library/Caches/com.github.yuvrajangadsingh.ytubic/stream/` |
| Backlog | Linear, Personal › YTubic (ME-28 to ME-34 as of Sep 2026) |

## How a song plays

Click → `src set` in the log → GET to the local proxy → if not cached, the proxy
runs `yt-dlp -j` signed in (median 5s, this is the whole wait) → 1-byte probe →
filler downloads while the element streams from the growing file → `playing`.
Next track is prefetched. 64% of plays start from disk and are instant.

## The decisions, one line each

- **Detached from the fork** so main's commits count and the app has its own identity (`com.github.yuvrajangadsingh.ytubic`); a migration moves old data over.
- **No 1080p cap** on video. Decided, don't re-propose.
- **Premium audio (271k Opus, itag 774)** needs the signed-in resolve; the proxy retries anonymously only when signed-in returns no formats.
- **yt-dlp needs deno** on PATH for the JS challenge; the app finds it itself so Dock launches work.
- **Cookie key is a 0600 file, not a keychain item** (macOS): the keychain prompted on every build because the app has no Team ID; the plaintext jar for yt-dlp already sat beside it anyway.
- **Auth writes are atomic** (temp + fsync + rename) with a wall-clock refresh schedule that survives sleep.
- **Resolve hedge at 12s**: a signed-in resolve still running at 12s gets an anonymous one raced beside it; an anonymous winner is served but never kept as the cached copy.
- **Plays before prefetch**: prefetch resolves take one slot and yield to plays; a play waiting on a queued prefetch promotes it.
- **Lyrics**: YouTube Music's own lyrics first (keyed by videoId), then LRCLIB, Musixmatch, Genius; every result passes a gate that rejects scraped site navigation. Upstream's scorer rewrite was measured and rejected.
- **Video match gates**: title (with artist tokens stripped), artist, and a duration window plus a 1.5x ratio ceiling. No swap beats a wrong swap.
- **Storm breaker**: if the element flips play/pause 8 times in a second, the app goes silent for 5s and hard-resets the element if the flipping persists.
- **WebKit occlusion detection is off** for the main window: a window on another Space was being marked hidden, which froze rendering, throttled timers and swallowed media keys.
- **Media keys after a long pause are WebKit's problem**, not fixable from the page; the fix is native audio in Rust (ME-34).
- **CI runs macOS + Ubuntu only.** Windows dropped Sep 2026.
- **Releases**: `release/x.y.z` branch → PR to main → merge → the workflow builds a signed DMG and `latest.json` as a draft → publish by hand. The updater key is ours (`298F8824CAC01DC8`).
- **Rename parked, not rejected.** Shortlist in `.notes/rename-shortlist-2026-09-01.md`. It is the first step of any launch (ME-30).

## How to ship

1. Branch from `develop`, PR to `develop`, CI green, merge with a merge commit.
2. `release/x.y.z` from `develop`: bump the four version fields, add a What's New entry, bump `.github/mac-release-version`, turn the dev-only settings off (`devtools` feature, dev signing identity).
3. PR to `main`, merge. The macOS workflow builds a draft release. Check `latest.json` is among the assets, then publish.
4. Merge `main` back into `develop` and restore the two dev-only settings.

## How to debug

- The log has no dates: slice from the last `==== launch` line, never by time across days.
- `[web]` lines are the media element's own events; `[proxy]` is the resolve/filler; `[refresh]` is the auth loop.
- A slow start is almost always the `resolved+probed in Ns` line. Under 12s is normal-slow; over that the hedge fires.
- Proof of an install is the running pid's start time, never the file on disk: the single-instance plugin hands a second launch to the old process.

## Open as of Sep 4 2026

- Native audio playback in Rust (ME-34), the fix for everything WebKit-shaped.
- Intent prefetch (warm on hover, two ahead), the next real click-to-sound win.
- Cover art disagreeing between fullscreen and the docked player (three independent latches; make it one per track).
- The sleep/wake refresh has never been exercised: the Mac has not slept.
- The launch chain: rename → release page → one true sentence → pitch (ME-30 to ME-33).
