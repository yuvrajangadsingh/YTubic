# Ideas and improvements from forks

A snapshot of the `NUber-dev/YTubic` fork network from July 15, 2026. This is a list of ideas to go through later, not a finished merge plan: the large branches conflict with `main`, so changes should be ported in small topical commits with tests.

## Platforms

- Linux: `.deb`/`.rpm`/AppImage, CI releases, resizing frameless windows and secure cookie storage through Secret Service. Already adapted in the local Linux branch based on PR #1.
- macOS: native title bar, Keychain + AES-GCM for cookies, Safari UA for the login WebView, universal Intel/Apple Silicon build, Dock/menu bar and the system media keys. PR #27 looks like the most focused base; individual improvements are worth taking from draft PR #33.

## Player

- Save the last track and playhead, restore them after a restart (`ameenalasady`, `5510d22`).
- Restore the last page and scroll position (`ameenalasady`, `f41d57f`).
- Fix the doubled duration of some streams on macOS and the incorrect seek before metadata loads.
- Add a fallback between yt-dlp clients (`android_vr`, `ios`) on DRM/403 and a fallback from video to audio.
- Make Song/Video a real audio/video stream switch, including a separate video cache.
- Carefully skip long empty outros in extended uploads.
- Add a fullscreen player with a large cover, lyrics, an ambient background and an accent color.

## Lyrics

- Add provider timeouts so the panel doesn't hang on Loading.
- Be stricter about dropping lyrics from another song: take the artist, the duration and remix/live qualifiers into account.
- Scale timestamps for sped-up/slowed versions and support a manual per-track offset.
- Allow turning lyrics off globally and skipping the network requests (`ameenalasady`, `022ab82`).
- Show the queue instead of an empty state when there are no lyrics.

## Library and navigation

- For Library → Songs use `FEmusic_liked_videos`, not the general `LM`, which can pick up Shorts and regular YouTube videos.
- Don't include Suggested tracks in the real contents of a playlist.
- In search, open album/artist/playlist pages instead of starting a random video from the play overlay.
- Improve artist shuffle: the full catalog, a new order on every start and station continuation.
- Make artists and albums clickable from cards and from the player.
- Use the channel handle to dedupe accounts when YouTube doesn't return an email.

## UI and settings

- Add a Home refresh and optional reordering of sections. Design the reordering without requiring an eager load of the whole feed.
- Add search over the music cache and show the real titles/artists.
- Add a lightbox for the full-size cover; port it together with the later image selection fixes.
- Resizable sidebar/player, IndexedDB for the caches that change often, a cover cache limit and the auto-dock removal are already done locally.

## Integrations and auth

- Consider importing cookies from browsers as a separate fallback for a broken WebView login, only after a security review.
- Brand channel switching is already in the main app; the old implementation doesn't need porting.
- Check whether the Last.fm offline retry, the `Topic` cleanup and the avatar account card were ported in full.

## Do not port

- A user-facing or default-on bypass of the Premium gate.
- The change that reads a Premium upsell as having Premium.
- Updater public keys from other people's forks.
- Whole conflicting macOS/auth branches without splitting them up and without platform regression tests.

## Sources

- PR #1: <https://github.com/NUber-dev/YTubic/pull/1>
- PR #3: <https://github.com/NUber-dev/YTubic/pull/3>
- PR #27: <https://github.com/NUber-dev/YTubic/pull/27>
- PR #33: <https://github.com/NUber-dev/YTubic/pull/33>
- Ameen fork: <https://github.com/ameenalasady/YTubic>
- YTMac fork: <https://github.com/metabreakr/YTMac>
