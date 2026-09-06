# Architecture

A map for anyone about to change this code. It answers six things: what the
system is, who owns each mutable fact, which dependencies are allowed, how
data moves, which rules fail silently when broken, and when to stop and ask
instead of guessing.

Line references were correct at the commit that added this file. If a
reference does not match what you read, trust the code and fix the line here.

## 1. System map

Tauri v2 desktop music player. React + TypeScript frontend, Rust backend, a
loopback HTTP server that proxies media bytes, yt-dlp for stream resolution,
raw InnerTube for metadata.

Frontend:

- `src/components/layout/app-shell.tsx:91` mounts the singletons. `useAudioEngine`
  is one of them, so exactly one playback engine exists per window.
- `src/lib/audio-engine.ts` is the playback engine. One hook, 28 effects, 16
  refs plus module-level mutable state. Read section 2 before touching it.
- `src/lib/store/` holds Zustand stores: `playback` (queue and user intent),
  `track-source` (song/video pairing), `premium`, `accounts`, `cast`.
- `src/lib/innertube/` is raw InnerTube. `shared.ts` is transport plus parsers,
  `client.ts` is the transport home.
- React Query owns server state and its disk persistence (`src/lib/query-client.ts`).
- `src/components/layout/floating-player-app.tsx` is a second window that mirrors
  state and forwards commands. It does not run an engine.
- `src/lib/cast-bridge.ts` hands playback to a receiver over the LAN listener.

Rust (`src-tauri/src/`):

- `lib.rs` is the app builder, 42 commands and the stream server. It is 5600
  lines and is being split; see section 6.
- `session.rs`, `authfs.rs` own credential storage and refresh.
- `ytdlp.rs` owns yt-dlp install and invocation.
- `stream_proxy.rs` owns range-proxied byte delivery.

Startup order in `lib.rs:5209` onward, and it matters:

1. `identity::migrate` before anything opens an identifier-derived path.
2. `applog::init`, after which stderr reaches the app log.
3. `secure_store::init`, before the first encrypt or decrypt.
4. `ActiveCacheRoot` captured once and managed. A cache-root preference change
   only applies after relaunch.
5. Account migrations, then the stream server binds.

## 2. Ownership

Every mutable fact has one owner. Most bugs in this repo have been two things
believing they owned the same fact.

| Fact | Owner |
|---|---|
| Queue, index, repeat, shuffle, user intent to play | `playback` store |
| The media element, its `src`, its clock, load state | the engine (`audio-engine.ts:210`) |
| Load generation and the carried seek | the resolve effect (`audio-engine.ts:771`) |
| The muted companion video following the audio master | the companion effect (`audio-engine.ts:1036`) |
| Displayed id to stream id mapping, and whether the user chose video | `track-source` store |
| Durable identity, cookie jars, refresh commits | the Rust account layer |
| Clearing account-dependent frontend state | `useAccountsChangedListener` (`accounts.ts:162`) |
| Per-stream writer ownership | `proxy_ensure` (`lib.rs:4335`) |
| The contiguous published byte prefix of a partial file | the proxy filler |
| Transport state while casting | the receiver, mirrored into `playback` |

The floating window owns nothing. It mirrors and forwards.

## 3. Dependency boundaries and forbidden paths

- UI transport controls go through `playback` store actions, never at the media
  element. `VideoSurface` (`video-surface.tsx:32`) is the one exception and it
  only reparents: it moves the element with `appendChild` so media selection does
  not re-run. It must not set `src`, call `load()`, or start playback, and it
  must not put sizing on `el.className`. Cleanup detaches only if this host still
  owns the element.
- Authenticated InnerTube requests go through the native transport with its
  signing and cookie-rotation path (`shared.ts:283`). Do not add a second cookie
  cache and do not bypass response-cookie capture.
- Account mutations must not read through the forgiving `read_index`
  (`lib.rs:589`), which degrades an unreadable index to empty, and then write
  back. Writing after that fallback erases accounts that were merely unavailable.
  Use the checked path and atomic writes.
- Media bytes come from the loopback proxy. UI code does not assign upstream URLs
  to a media element. Token-bearing URLs leave Rust through exactly three
  commands: `get_stream_base_url` (`lib.rs:3974`), `stream_lan_base_url`
  (`lib.rs:4034`), and `cache_cover`. Do not add a fourth without reading section 6.
- Every command in `lib.rs` is private. Tauri's command macro generates
  `__cmd__*` in the root macro namespace, so a `pub` command in this file is a
  redefinition (E0255). Commands moved to submodules become `pub` there. This is
  the main friction in splitting the file.
- Do not add a second owner of OS media commands on macOS. `media::init` is
  `#[cfg(target_os = "linux")]` (`lib.rs:5287`) because macOS Now Playing is owned
  by the webview's media session. Registering both fights over the system entry.
- There is no blanket "lib cannot import components" rule here. The engine and
  the cast bridge both import thumbnail helpers, deliberately.

## 4. Data flow

Playback:

play action -> `playback` queue and index -> `resolveStreamId` maps displayed id
to stream id (`track-source.ts:158`) -> premium gate -> tokenized loopback URL ->
cached file, or yt-dlp resolve plus proxy fill -> media events -> back into the
store and the UI.

Auth:

InnerTube request -> current auth context and signature -> native HTTP -> cookie
rotation -> parse -> query cache. An account change resets auth, playback, source
mappings, premium state and queries. A session refresh does not: it emits
`session-refreshed`, and the listener calls `resetInnertube()` first, then
invalidates `auth-logged-in`, `account-info` and `premium-status`
(`accounts.ts:139-160`). Reset before invalidate, or the refetch reuses the stale
Cookie header.

Casting:

device selection -> LAN listener -> loopback length probe -> receiver load ->
receiver state mirrored into `playback`, while local playback stays paused.

## 5. Invariants

These fail silently. Breaking one produces a wrong result, not a compile error.

**A media clock belongs to a specific loaded source.** `removeAttribute("src")`
does not reset the element: per spec it keeps the resource and the playhead. Call
`load()` too (`audio-engine.ts:837-846`). The resolve effect runs twice per track
change in video mode, and without the `load()` the second run reads the outgoing
track's `currentTime` and arms it as the incoming track's carry. Carry seeks only
across the same videoId, index and premium state, tagged with the current
generation token.

**An explicit seek during load updates both the carry and the startup-hold
target.** Otherwise a later `loadedmetadata` restores an older position.

**`resolveStreamId` and `wantsVideoStream` must answer consistently.** If one
hands back the video counterpart while the other says audio, the master streams
the music video's audio track under a UI reading Song, and the toggle is inert
because it already shows the state you want. Both take `preferVideo` for exactly
this reason (`track-source.ts:158`, `:181`). Related: one record is aliased under
BOTH ids, so a song row can read `selected: "video"` with `video` naming the
other file. Never redirect a row to a different file while the gate says audio.

**A mode is not per-track identity.** Sticky video mode lives in `preferVideo`.
Writing it into a track's `selected` field is what broke the rule above: the
mode leaked into per-track state that another function reads without knowing
about the mode. Seeded state that means "the row was queued as a video" and a
mode that means "play video versions" are different facts.

**Anything written ahead of the playhead must prefer authoritative data.** The
counterpart seeding effect bails on `if (byVideoId[id]) return`
(`audio-engine.ts:717`), so a speculative search result written for an upcoming
track outranks the real `/next` pairing permanently. Use `track.counterpartId`
when the queue has it.

**Displayed queue id and stream id are different identities**, and a seeded
`selected: "video"` is not the same as a user's explicit choice. `wantsVideoStream`
requires `selected === "video" && chosen === true` (`track-source.ts:175-181`).
Seeding writes `selected` only, which is why a lit toggle can play audio.

**Persisted playback restores paused, with no stream URL and no pending seek.**
`partialize` (`playback.ts:589`) deliberately drops position, status, streamUrl,
error, pendingSeek and playing. Ports and tokens belong to the running process.

**The premium gate is enforced in more than one place.** The resolve effect
(`audio-engine.ts:820`) and the resume path (`audio-engine.ts:1306`) both gate.
`streamUrlFor` only picks a URL and a cache scope, it does not gate.

**Account mutations keep index-before-account lock ordering** (`authfs.rs:163`),
and unavailable credentials are not absent credentials. Refresh rechecks that the
account still exists (`lib.rs:1782`) so a removed account cannot be resurrected,
and keeps a usable jar rather than committing an unusable replacement.

**Writer keys include storage scope, variant and video-only height**
(`lib.rs:4335`). Proxy and legacy download paths coordinate through the same key
so two representations never write one partial file.

**A proxy response delivers its promised byte count or fails the body.** A short
body is rejected before the pump is spawned, and re-resolution preserves the
representation and total. Final publication requires an exact size match.

**The degraded marker is committed before the rename** (`stream_proxy.rs:941`).
The other order leaves a window where an unmarked low-tier file becomes the
permanent cached copy. If the marker cannot be written, the file is not published.

**A declined prefetch must not fall through to the legacy downloader**
(`lib.rs:4799`). `SKIPPED` returns 429. Falling through spawns the uncapped
yt-dlp the skip existed to prevent.

**An empty deletion list means "clear everything"** (`lib.rs:3003`). An empty
computed eviction set must never reach that command.

**The `track-source` store is session-only on purpose** (`track-source.ts:105-118`).
Persisting it once left every launch gated behind a video spinner and pulled
2.5GB of vonly2160 files. Do not add persistence back.

## 6. Stop and ask

Pause for contract changes, not for mechanical moves.

- Cookie representation, credential storage or migration, account
  deduplication, profile identity, lock ordering, refresh success criteria.
- Premium policy anywhere: local playback, resume, casting, persistent caching.
- Cache eviction eligibility, completeness assumptions, deletion semantics, or
  live cache-root migration.
- yt-dlp format selectors, the authenticated to anonymous fallback, codec and
  container assumptions, retry or admission policy, partial-file publication.
- Media-clock ownership, source-switch seek behavior, companion startup, casting
  authority, OS media-command registration.
- LAN exposure, token handling, image URL and redirect policy, CSP, or widening
  Tauri capabilities (`src-tauri/capabilities/default.json`, `tauri.conf.json`).
  These are separate controls, not interchangeable allowlists.
- Persisted schema or query-key identity, and any "deduplication" that changes
  pagination limits, error propagation, or partial-result behavior.

For an unchanged extraction, just run the tests and compile. If correctness
depends on WebKit timing, live credentials, or a cast receiver, say so and stop
before calling it verified.

## Known gaps

Real today. Do not document these as guarantees.

- Casting has its own load path with no premium check (`cast-bridge.ts:89`).
- Auto-clean protects the displayed id (`cache-cleanup.ts:60`), but playback can
  be using an alternate stream id, so the file actually in use is unprotected in
  video mode.
- `merge_response_cookies` receives no originating account id and merges into the
  active account (`lib.rs:2749`). The frontend auth epoch protects cache
  population, not every outstanding request, so cross-account request and
  response isolation is not an established guarantee.
- Library continuation can return incomplete results (`playlist.ts:442-450`).
- The companion effect's deps omit `videoId` and `index`, so a duplicate queue
  entry can create a fresh hold that the existing companion never marks ready.
