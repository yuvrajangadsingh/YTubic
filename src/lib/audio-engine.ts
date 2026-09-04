import { artistLineFromSubtitle } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { fetchRadio, fetchWatchQueueContinuation } from "@/lib/innertube/radio";
import { prefetchStream, saveTrackMeta, streamUrlFor } from "@/lib/stream";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import { isCasting, useCastStore } from "@/lib/store/cast";
import { usePremiumStore } from "@/lib/store/premium";
import { useSettingsStore } from "@/lib/store/settings";
import { openPremiumGate } from "@/lib/store/premium-gate";
import {
  resolveStreamId,
  useTrackSourceStore,
  wantsVideoStream,
} from "@/lib/store/track-source";
import { findCleanAudioAlternate } from "@/lib/innertube/alternate-source";
import { fetchPanelDuration } from "@/lib/innertube/radio";
import { pickThumbnail } from "@/components/shared/thumbnail";
import { useLyricsSources } from "@/lib/lyrics/sources";
import { correctedDuration, shouldSkipOutro } from "@/lib/outro";
import { appLog, mediaState } from "@/lib/app-log";

/**
 * AudioEngine binds the playback store to a singleton HTMLAudioElement and
 * drives native media controls from Rust via souvlaki (SMTC, MPRIS, and macOS
 * Now Playing; see src-tauri/src/media.rs). The webview media session stays
 * disabled on Windows because it belongs to WebView2 and appears as an
 * "Unknown app" duplicate.
 *
 * Mount this hook once, near the root. It owns the <audio> element's lifecycle.
 */
// The engine's singleton element, exposed so the fullscreen player can
// adopt it as a visible surface when the current stream is a video file.
let mediaElSingleton: HTMLVideoElement | null = null;

// Play/pause storm breaker.
//
// 2026-09-04 12:53: the element played, paused within milliseconds, and
// played again, dozens of times a second for over four minutes, never
// moving past 48.0s, with the UI starved to a grey flash. Every path in
// this file that calls play() checks the store first, so the store itself
// was being flipped each cycle, and the only writers that can do that
// without a user gesture are the two OS media integrations (the Rust
// media-controls listener and the webview's own mediaSession handlers).
// Both are logged now so the next occurrence names its source. Until it
// does, this is the guard rail: if the element flips state more than
// STORM_FLIPS times inside STORM_WINDOW_MS, OS media commands are ignored
// for STORM_HOLD_MS and the element settles on whatever the store says.
const STORM_WINDOW_MS = 1000;
const STORM_FLIPS = 8;
const STORM_HOLD_MS = 5000;
let stormActiveUntil = 0;
let flipTimes: number[] = [];
function noteFlip(kind: "play" | "pause"): void {
  const now = performance.now();
  flipTimes.push(now);
  flipTimes = flipTimes.filter((t) => now - t <= STORM_WINDOW_MS);
  if (flipTimes.length >= STORM_FLIPS && stormActiveUntil <= now) {
    stormActiveUntil = now + STORM_HOLD_MS;
    appLog(
      `play/pause storm: ${flipTimes.length} flips in ${STORM_WINDOW_MS}ms (last: ${kind}); ignoring OS media commands for ${STORM_HOLD_MS}ms`,
    );
  }
}
export function getMediaElement(): HTMLVideoElement | null {
  return mediaElSingleton;
}

// Muted companion element that carries the high-res VIDEO-ONLY stream
// while the singleton above stays the audio master. YouTube stopped
// serving progressive (muxed) files above 360p and we don't ship
// ffmpeg to merge tracks, so "video mode" plays the audio variant for
// sound and drift-syncs these frames to it. Created on first use,
// torn down (src dropped) whenever the current track isn't in video
// mode.
let companionVideoSingleton: HTMLVideoElement | null = null;
/** The element a VideoSurface should adopt: the companion when video
 *  mode is active, else the master (which still carries frames for the
 *  legacy muxed fallback). */
export function getVideoSurfaceElement(): HTMLVideoElement | null {
  return companionVideoSingleton ?? mediaElSingleton;
}

/**
 * The only way this module is allowed to start local playback.
 *
 * A cast session means the receiver is pulling the same stream for itself, so
 * anything playing here is a second copy of the track a few hundred ms out of
 * phase. Guarding the play/pause effect alone was not enough: there are six
 * routes to `el.play()` in here (the video startup hold releasing, its
 * timeout fallback, the resolve effect, the companion, retries) and every one
 * of them bypassed it. Switching to video mode while casting released the
 * hold, which called play() directly, and the track came out of the laptop
 * and the TV at once.
 *
 * Always returns a promise so callers can keep chaining `.catch`.
 */
/** Whether `t` falls inside any of the element's buffered ranges. */
function timeInBuffered(b: TimeRanges, t: number): boolean {
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= t && t <= b.end(i)) return true;
  }
  return false;
}

function playLocal(el: HTMLMediaElement | null | undefined): Promise<void> {
  if (!el || isCasting()) return Promise.resolve();
  // Every play() and its outcome go to the app log. A play() that neither
  // resolves nor rejects is the desktop-switch stall's signature: the
  // promise settles only when WebKit actually starts playback.
  appLog(`play() ${mediaState(el)}`);
  const p = el.play();
  p.then(
    () => appLog(`play() resolved ${mediaState(el)}`),
    (e: unknown) => {
      const err = e as { name?: string; message?: string } | undefined;
      appLog(`play() rejected ${err?.name}: ${err?.message} ${mediaState(el)}`);
    },
  );
  return p;
}

export function useAudioEngine() {
  const audioRef = useRef<HTMLVideoElement | null>(null);
  // Guard against stale stream resolutions when the user skips mid-fetch.
  const resolveTokenRef = useRef(0);
  // Position continuity across same-track reloads (song<->video source
  // flips, error retries): the resolve effect re-runs and drops the src,
  // so the playhead would reset to 0. When the LOGICAL track (videoId +
  // queue index) is unchanged between runs, the position is captured
  // here and re-applied once the new stream's metadata is in. Track
  // changes and same-id duplicates at another queue index don't carry.
  const prevResolveKeyRef = useRef<{
    videoId?: string;
    index: number;
    premiumOk: boolean;
  } | null>(null);
  const carrySeekRef = useRef<{ token: number; seconds: number } | null>(null);
  // Counts how many tracks have failed in a row without a successful
  // play in between. Reset to 0 on `playing`. Used to short-circuit
  // auto-skip after a few consecutive failures so we don't burn through
  // the whole queue if e.g. the network is dead.
  const consecutiveErrorsRef = useRef(0);
  // videoIds we've already run an audio-hunt for, so the same track doesn't
  // re-trigger a search on every re-render or seek.
  const huntedRef = useRef<Set<string>>(new Set());
  // Long-outro auto-advance bookkeeping: the last sung line's timestamp
  // for the current track, the videoId we already advanced past (never
  // twice), and the videoId whose outro the user deliberately seeked
  // into (respect that — they want to hear it).
  const lastVocalRef = useRef<number | null>(null);
  // Raw element-reported duration (pre-correction) so the end guard can
  // recognise the doubled-header case even after the store was clamped.
  const rawElDurationRef = useRef(0);
  // Authoritative length OF THE FILE CURRENTLY LOADED, which in video
  // mode is not the queue row: a 5:30 song pairs with a 6:15 music
  // video. Everything that reasons about "is the element lying about
  // its length" has to measure against this, not against the row.
  // `undefined` means we don't have a trustworthy reference yet and
  // those checks must stand down rather than guess.
  const metaReferenceRef = useRef<number | undefined>(undefined);
  // corrected-end advance latch; re-armed when the playhead returns
  // before the corrected end (see onTimeUpdate)
  const endGuardFiredRef = useRef<boolean>(false);
  const outroSkippedRef = useRef<string | null>(null);
  const outroSuppressedRef = useRef<string | null>(null);
  // Remembers the `videoId:index` we've already auto-retried once, so a
  // track that keeps failing falls through to the normal error/skip path
  // instead of looping. Cleared on a successful `playing`.
  const retriedTrackRef = useRef<string | null>(null);
  // Bumping this re-runs the resolve effect for the *current* track
  // without any of its real deps changing — used to re-fetch a fresh
  // stream URL after a transient failure (e.g. a googlevideo 403).
  const [retryNonce, setRetryNonce] = useState(0);
  // See the stall watchdog below for why this is as long as it is.
  const STALL_RELOAD_MS = 75_000;

  // Video-mode startup hold: audio and frames start TOGETHER (YouTube
  // semantics) instead of audio leading by however long the vonly
  // download takes. Generation-keyed by the resolve token so duplicate
  // ids, retries, and stale listeners can't release someone else's
  // hold. Every route to el.play() must respect it.
  const videoHoldRef = useRef<{
    token: number;
    audioReady: boolean;
    videoReady: boolean;
    timer: number;
    // Carried playhead for a same-track reload: the companion must be
    // seeked here and ready HERE (not at 0) before the held start
    // releases, or the audio leads while the video buffers its target.
    targetSeconds?: number;
  } | null>(null);
  const maybeStartHeld = () => {
    const el = audioRef.current;
    const h = videoHoldRef.current;
    if (!el || !h || !h.audioReady || !h.videoReady) return;
    window.clearTimeout(h.timer);
    videoHoldRef.current = null;
    const st = usePlaybackStore.getState();
    st.setVideoStartup("ready");
    const comp = companionVideoSingleton;
    if (comp && Number.isFinite(el.currentTime)) {
      comp.currentTime = el.currentTime;
    }
    // `playing` is the user's intent recorded during the hold; only a
    // still-true intent becomes actual playback. Both play() calls in
    // one task keeps the AV start close enough for the drift sync.
    if (st.playing) {
      void playLocal(el).catch(() => {});
      if (comp) void playLocal(comp).catch(() => {});
    }
  };
  /** Abandon the hold and continue audio-only (timeout / error / mode
   *  off). Detaches the companion so a late loadeddata can't resurrect
   *  the video mid-song at the wrong time. */
  const fallbackHeld = (startup: "fallback" | "idle") => {
    const el = audioRef.current;
    const h = videoHoldRef.current;
    if (!h) return;
    window.clearTimeout(h.timer);
    videoHoldRef.current = null;
    const st = usePlaybackStore.getState();
    st.setVideoStartup(startup);
    st.setStreamKind("audio");
    const comp = companionVideoSingleton;
    if (comp) {
      comp.removeAttribute("src");
      comp.load();
    }
    if (el && st.playing) void playLocal(el).catch(() => {});
  };

  // Ensure a single media element exists. It's a <video> element, not
  // new Audio(): for audio-only streams the two behave identically, but
  // when the user switches a track to its video source the same element
  // carries the picture and the fullscreen player adopts it as a live
  // surface (getMediaElement above).
  useEffect(() => {
    if (audioRef.current) return;
    const el = document.createElement("video");
    el.preload = "auto";
    el.playsInline = true;
    // Note: do NOT set crossOrigin — googlevideo.com doesn't return CORS
    // headers, and setting it makes the media fail to load in the webview.
    audioRef.current = el;
    mediaElSingleton = el;
    return () => {
      el.pause();
      el.src = "";
      el.remove();
      audioRef.current = null;
      mediaElSingleton = null;
    };
  }, []);

  // Wire element → store events.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const store = usePlaybackStore.getState;

    const onTimeUpdate = () => {
      store().setPosition(el.currentTime);
      // End-guard for the double-length m4a header bug: correctedDuration
      // shows the LISTED length while the element claims ~2x (phantom
      // silent second half). Displaying the truth isn't enough — playback
      // must also END at the truth, or the clock runs past the bar into
      // silence. The latch re-arms whenever the playhead is back before
      // the corrected end (repeat-one seeks to 0, manual seeks back,
      // fresh sources), so replays of the SAME src advance correctly too.
      const cur = store();
      const raw = rawElDurationRef.current;
      const doubled =
        cur.duration > 0 &&
        raw > 0 &&
        raw / cur.duration > 1.8 &&
        raw / cur.duration < 2.2;
      if (doubled && el.currentTime < cur.duration - 1) {
        endGuardFiredRef.current = false;
      }
      if (
        doubled &&
        el.currentTime >= cur.duration - 0.05 &&
        !endGuardFiredRef.current
      ) {
        endGuardFiredRef.current = true;
        // Rewind the element first: at the end of the queue (repeat off)
        // next() only stops — without this the element would sit parked
        // in the phantom zone and a later Play would resume silence.
        el.pause();
        el.currentTime = 0;
        cur.next();
      }
    };
    const onDurationChange = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        rawElDurationRef.current = el.duration;
        const cur = store();
        cur.setDuration(
          correctedDuration(metaReferenceRef.current, el.duration),
        );
      } else if (el.duration === Infinity) {
        // Streaming containers (progressively served webm) report
        // Infinity until fully buffered, which left the bar showing the
        // LISTED length while the real file ran longer, so the bar pinned
        // at full with audio still playing. The seekable range end is
        // the truth the server actually has; it grows monotonically to
        // the real length as the download completes.
        syncSeekableDuration();
      }
    };
    const syncSeekableDuration = () => {
      if (el.duration !== Infinity || el.seekable.length === 0) return;
      const end = el.seekable.end(el.seekable.length - 1);
      if (!Number.isFinite(end) || end <= 0) return;
      const cur = store();
      if (end > cur.duration + 0.5) {
        rawElDurationRef.current = end;
        cur.setDuration(correctedDuration(metaReferenceRef.current, end));
      }
    };
    const onProgress = () => syncSeekableDuration();
    const onEnded = () => {
      store().next();
    };
    // External pause/play — the system Now Playing widget or WebKit's
    // built-in media session can pause the element directly, bypassing
    // the store, which left the UI showing a stale playing state. Sync
    // the element's actual state back. Track changes pause the element
    // too, but by the time the queued pause event runs the status is
    // already "loading", so the ready-guard keeps auto-play intact.
    // While casting these are noise: the element is deliberately paused and
    // the receiver is what `playing` describes. Letting the local pause event
    // through would immediately contradict every status that says playing.
    const onElPause = () => {
      const s = store();
      if (isCasting()) return;
      if (s.status === "ready" && s.playing && !el.ended) {
        appLog("element paused under a playing store; store -> paused");
        s.setPlaying(false);
      }
    };
    const onElPlay = () => {
      const s = store();
      if (isCasting()) return;
      if (s.status === "ready" && !s.playing) {
        appLog("element playing under a paused store; store -> playing");
        s.setPlaying(true);
      }
    };
    const onError = () => {
      const mediaErr = el.error;
      const codeLabels: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED",
        2: "MEDIA_ERR_NETWORK",
        3: "MEDIA_ERR_DECODE",
        4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
      };
      const msg = mediaErr
        ? `${codeLabels[mediaErr.code] ?? `code ${mediaErr.code}`}${
            mediaErr.message ? `: ${mediaErr.message}` : ""
          }`
        : "Unknown audio error";

      // A music-video stream the webview can't decode (MEDIA_ERR_DECODE /
      // MEDIA_ERR_SRC_NOT_SUPPORTED) shouldn't surface a raw error banner
      // or skip the track. While the video source is the selected one,
      // drop it back to audio and let the resolve effect retry with the
      // song stream, which every track has. The selected-source check
      // keeps this from looping: once we're on audio a repeat failure
      // falls through to the normal error path below.
      const errored = store();
      const cur = errored.index >= 0 ? errored.queue[errored.index] : undefined;
      if (cur && (mediaErr?.code === 3 || mediaErr?.code === 4)) {
        const ts = useTrackSourceStore.getState();
        const selected = ts.byVideoId[cur.videoId]?.selected ?? "song";
        if (selected === "video") {
          if (import.meta.env.DEV) {
            console.warn(
              "[audio] video stream failed to decode, falling back to audio:",
              cur.videoId,
            );
          }
          ts.setSelected(cur.videoId, "song");
          return;
        }
      }

      if (import.meta.env.DEV) {
        console.error("[audio] element error:", msg, "src=", el.currentSrc);
      }

      // One automatic retry of the SAME track before giving up. Most
      // first-play failures are a transient googlevideo 403 on the media
      // URL: the stream server drops the failed entry immediately, so a
      // re-fetch spawns a fresh yt-dlp resolve that usually succeeds —
      // exactly what a manual re-click does. Only retry a track the user
      // actively wants playing, and only once per track instance.
      {
        const s0 = store();
        const cur0 = s0.index >= 0 ? s0.queue[s0.index] : undefined;
        const key0 = cur0 ? `${cur0.videoId}:${s0.index}` : null;
        if (s0.playing && key0 && retriedTrackRef.current !== key0) {
          retriedTrackRef.current = key0;
          if (import.meta.env.DEV) {
            console.warn("[audio] retrying", key0, "after error:", msg);
          }
          store().setStatus("loading");
          // Small delay so a truly-dead source doesn't hot-loop; also
          // gives the server a beat to tear down the failed download.
          window.setTimeout(() => setRetryNonce((n) => n + 1), 400);
          return;
        }
      }

      store().setStatus("error", msg);

      // Auto-advance: if the user wanted playback and we have a next
      // track, try it. Stop after 3 consecutive failures so a dead
      // network or a poisoned playlist doesn't burn through everything.
      const s = store();
      const hasNext = s.index >= 0 && s.index + 1 < s.queue.length;
      consecutiveErrorsRef.current += 1;
      if (s.playing && hasNext && consecutiveErrorsRef.current <= 3) {
        // Keep `playing: true` so the new track auto-resumes.
        s.next();
      } else {
        s.setPlaying(false);
      }
    };
    const onPlaying = () => {
      consecutiveErrorsRef.current = 0;
      // Track played successfully — allow a fresh auto-retry if it later
      // fails again (e.g. a mid-stream drop on a much later replay).
      retriedTrackRef.current = null;
      store().setStatus("ready");
    };
    const onWaiting = () => {
      // buffering — keep status as ready; don't flip to loading on every gap.
    };
    // Element lifecycle into the app log, with the page's visibility on
    // every line. The desktop-switch stall (Aug 2026: click play, change
    // Space, silence) has resisted three fixes made without this
    // timeline; the question is whether a hidden page ever reaches
    // canplay, and this answers it.
    const onLogged = (ev: Event) => {
      const cur = store().queue[store().index];
      appLog(`${ev.type} ${cur?.videoId ?? "-"} ${mediaState(el)}`);
    };
    const LOGGED = [
      "playing",
      "pause",
      "waiting",
      "stalled",
      "suspend",
      "canplay",
      "error",
    ];
    // When the page comes back, the store may still want playback that
    // never started while it was hidden. A repeated play() on an element
    // whose earlier play() is still pending is a no-op, so this is safe
    // even when WebKit was merely slow rather than blocked.
    const onVisibility = () => {
      appLog(`visibility ${document.visibilityState} ${mediaState(el)}`);
      if (document.visibilityState !== "visible") return;
      if (store().playing && el.paused && el.src && !videoHoldRef.current) {
        appLog("resuming after visibility change");
        void playLocal(el).catch(() => {});
      }
    };

    const onFlipPlay = () => noteFlip("play");
    const onFlipPause = () => noteFlip("pause");
    el.addEventListener("play", onFlipPlay);
    el.addEventListener("pause", onFlipPause);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("progress", onProgress);
    el.addEventListener("ended", onEnded);
    el.addEventListener("pause", onElPause);
    el.addEventListener("play", onElPlay);
    el.addEventListener("error", onError);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    for (const t of LOGGED) el.addEventListener(t, onLogged);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      el.removeEventListener("play", onFlipPlay);
      el.removeEventListener("pause", onFlipPause);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("pause", onElPause);
      el.removeEventListener("play", onElPlay);
      el.removeEventListener("error", onError);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
      for (const t of LOGGED) el.removeEventListener(t, onLogged);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // React to current-track changes → resolve stream → set src.
  const { videoId, track, index } = usePlaybackStore(
    useShallow((s) => {
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      return { videoId: t?.videoId, track: t, index: s.index };
    }),
  );

  // Substitute the streaming videoId via the user's per-track source
  // preference (Song ↔ Music Video). Subscribing here means the effect
  // below re-runs and re-resolves the stream when the user toggles the
  // source on the currently playing track.
  const streamVideoId = useTrackSourceStore((s) =>
    videoId ? resolveStreamId(videoId, s.byVideoId) : undefined,
  );

  // The stream's own length when it isn't the queue row's file.
  //
  // Song and video versions are different lengths by nature (intro,
  // outro, an extra verse). Measuring the video against the song's
  // metadata is what made a 6:15 video display as 12:29: its header
  // reports double (a known YT quirk), and 750/330 = 2.27 falls outside
  // the 1.8-2.2 doubled-header window, so the clamp never recognised it.
  // Against its own 375s it is exactly 2.0 and clamps correctly.
  const [streamMetaDuration, setStreamMetaDuration] = useState<
    number | undefined
  >(undefined);
  useEffect(() => {
    if (!streamVideoId || streamVideoId === videoId) {
      setStreamMetaDuration(undefined);
      return;
    }
    let cancelled = false;
    setStreamMetaDuration(undefined);
    fetchPanelDuration(streamVideoId)
      .then((secs) => {
        if (!cancelled && secs) setStreamMetaDuration(secs);
      })
      .catch(() => {
        /* no reference is better than the wrong one */
      });
    return () => {
      cancelled = true;
    };
  }, [streamVideoId, videoId]);

  // True only when the user explicitly switched this track to its video
  // source — then the stream request carries ?video=1 and the element
  // has real frames to show.
  const wantVideo = useTrackSourceStore((s) =>
    videoId ? wantsVideoStream(videoId, s.byVideoId) : false,
  );

  // Tracks queued from surfaces without a length (home cards) carry no
  // duration, which leaves the doubled-header clamp with no reference —
  // a 2x file then displays and scrubs at twice its real length. Fetch
  // the authoritative length from the track's own /next row once and
  // patch the queue entry; the re-clamp effect below applies it.
  useEffect(() => {
    if (!videoId) return;
    const cur = usePlaybackStore.getState();
    const track = cur.index >= 0 ? cur.queue[cur.index] : undefined;
    if (!track || track.videoId !== videoId || track.duration) return;
    let cancelled = false;
    fetchPanelDuration(videoId)
      .then((secs) => {
        if (cancelled || !secs) return;
        usePlaybackStore.getState().patchTrackDuration(videoId, secs);
      })
      .catch(() => {
        /* metadata nicety only — the element duration stays */
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // Re-apply the header clamp when the metadata length lands AFTER the
  // element already reported durationchange (the late-fetch above).
  const rowMetaDuration = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.duration : undefined,
  );
  // Whichever file is loaded, that file's own length is the reference.
  const metaReference =
    streamVideoId && streamVideoId !== videoId
      ? streamMetaDuration
      : rowMetaDuration;
  useEffect(() => {
    metaReferenceRef.current = metaReference;
  }, [metaReference]);
  useEffect(() => {
    if (!metaReference || !rawElDurationRef.current) return;
    usePlaybackStore
      .getState()
      .setDuration(correctedDuration(metaReference, rawElDurationRef.current));
  }, [metaReference]);

  // Reactive Premium check for the gate below. Subscribing (rather than
  // calling isPremium() inside the effect) makes the resolve effect
  // re-run when the status lands after sign-in / the launch-time probe.
  // Without this, a track gated during the "still checking" window would
  // sit silent until the user re-picked it.
  const premiumOk = usePremiumStore((s) => s.status === "premium");

  // Seed the song<->video pairing from InnerTube's own counterpart data
  // (from a /next `playlistPanelVideoWrapperRenderer`) so the Source
  // toggle flips to the real other version instead of a fuzzy search that
  // can land on an unrelated clip. Only when we have a pairing and no
  // record yet; `selected` lands on whichever kind was queued, so the
  // default stream doesn't change and no wasteful re-resolve fires.
  const counterpartId = track?.counterpartId;
  const trackKind = track?.kind;
  useEffect(() => {
    if (!videoId || !counterpartId || !trackKind) return;
    const ts = useTrackSourceStore.getState();
    if (ts.byVideoId[videoId]) return;
    const counterpartKind = trackKind === "video" ? "song" : "video";
    ts.setAlternate(videoId, counterpartKind, counterpartId);
  }, [videoId, counterpartId, trackKind]);

  // Auto-hunt the clean album ("song") version of whatever was queued.
  // Originally this only rescued kind==="video" rows, but extended/looped
  // re-uploads also surface as ordinary song rows (a 7:45 "(Remix)" that
  // keeps rolling minutes after the actual song ends), so it now fires for
  // any kind and leans on findCleanAudioAlternate's guarantees instead:
  // artists must exist (a bare title is not identity — a wrong swap here
  // changes what's PLAYING, worse than wrong lyrics), the found title has
  // to match, and the duration gate only ever swaps to a meaningfully
  // shorter album version (or a near-equal one for true video rows).
  // Fires once per id; /next counterpart data (handled above) and manual
  // Song/Video choices both take precedence.
  const huntTitle = track?.title;
  useEffect(() => {
    // Video rows only. The kind-agnostic expansion was chasing what
    // turned out to be the doubled-header bug (see correctedDuration) —
    // and for a normal song row an aggressively shorter "match" is a
    // sped-up bootleg, not a cleaner version.
    if (!videoId || trackKind !== "video") return;
    if (huntedRef.current.has(videoId)) return;
    const ts = useTrackSourceStore.getState();
    // A record alone doesn't mean "leave it alone": the counterpart
    // seeding above creates one for every popular song (song = the row
    // itself + its music video), which used to block the hunt exactly
    // where it's most needed. Only back off when the song side already
    // points elsewhere (a previous hunt or manual pick) or the user
    // explicitly selected the video source.
    const rec = ts.byVideoId[videoId];
    if (rec && (rec.song !== videoId || rec.selected === "video")) return;
    huntedRef.current.add(videoId);
    const s = usePlaybackStore.getState();
    const cur = s.index >= 0 ? s.queue[s.index] : undefined;
    if (!cur || cur.videoId !== videoId) return;
    void findCleanAudioAlternate({
      videoId,
      title: cur.title,
      artists: cur.artists,
      kind: cur.kind,
      duration: cur.duration,
    })
      .then((altId) => {
        if (!altId) return;
        // Bail if a manual choice or /next pairing landed while we searched.
        const now = useTrackSourceStore.getState();
        if (now.byVideoId[videoId]) return;
        now.setAlternate(videoId, "song", altId);
        now.setSelected(videoId, "song");
      })
      .catch(() => {
        /* stay on the queued source; a later manual switch still works */
      });
  }, [videoId, trackKind, huntTitle]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // Same logical track re-resolving (source flip / retry)? Grab the
    // playhead before anything below can destroy it. A premium-state
    // change re-resolves too but is a gating event, not a continuity
    // request, so it breaks the carry.
    const prevKey = prevResolveKeyRef.current;
    const sameTrack =
      !!prevKey &&
      prevKey.videoId === videoId &&
      prevKey.index === index &&
      prevKey.premiumOk === premiumOk;
    const posBefore = el.currentTime;
    prevResolveKeyRef.current = { videoId, index, premiumOk };
    // Invalidate in-flight resolutions of ANY earlier run before the
    // early returns below: without this, gating (premium loss, empty
    // queue) leaves the previous token live and a stale streamUrlFor()
    // promise can land afterwards and reinstall its src.
    const token = ++resolveTokenRef.current;
    // Only a same-track reload with a live playhead captures fresh; a
    // rapid double flip re-runs while the playhead is still 0 (the
    // first reload reset it), so an existing same-track carry is
    // retagged to the new generation instead of being dropped.
    carrySeekRef.current =
      sameTrack && posBefore > 0.5
        ? { token, seconds: posBefore }
        : sameTrack && carrySeekRef.current
          ? { token, seconds: carrySeekRef.current.seconds }
          : null;
    // Stop the previous track immediately. Without this the old src keeps
    // playing through the streamUrlFor() round-trip (~50–500 ms), so the
    // user hears the tail of track A bleed into the start of track B.
    el.pause();
    if (!streamVideoId) {
      el.removeAttribute("src");
      el.load();
      const store = usePlaybackStore.getState();
      store.setStreamUrl(undefined);
      store.setStreamKind("audio");
      return;
    }
    // Premium gate: signed-out / Free accounts browse but don't stream.
    // Every entry path (track clicks, media keys, tray, floating window,
    // restored queues) funnels through this effect, so one check here
    // guarantees no yt-dlp spawn and no cache write happens without
    // Premium. A deliberate play attempt (playing=true) gets the
    // explainer dialog; the silent preload of a restored queue
    // (playing=false) just parks the track.
    if (!premiumOk) {
      el.removeAttribute("src");
      el.load();
      const store = usePlaybackStore.getState();
      store.setStreamUrl(undefined);
      store.setStreamKind("audio");
      store.setStatus("idle");
      if (store.playing) {
        store.setPlaying(false);
        openPremiumGate();
      }
      return;
    }
    // Drop the previous track's src immediately. Otherwise a paused→playing
    // transition committed together with the track change (playNow/goTo set
    // playing: true) makes the [playing] effect below re-play the OLD src
    // for the duration of the streamUrlFor() round-trip.
    el.removeAttribute("src");
    // streamKind is only promoted to "video" after a resolve SUCCEEDS,
    // so reset it at the same moment the src drops. Otherwise a video
    // surface keeps rendering the previous track's last frame through
    // the loading gap (or forever, when resolution fails).
    usePlaybackStore.getState().setStreamKind("audio");

    usePlaybackStore.getState().setStatus("loading");

    // Establish the startup hold NOW (not in the async .then) so the
    // companion becoming ready first still finds it. Staged timeout:
    // cold 4K legitimately takes ~15s, 1080p should never.
    if (videoHoldRef.current) {
      window.clearTimeout(videoHoldRef.current.timer);
      videoHoldRef.current = null;
    }
    if (wantVideo) {
      const cap = useSettingsStore.getState().videoQuality;
      const timer = window.setTimeout(
        () => {
          const h = videoHoldRef.current;
          if (!h || h.token !== token) return;
          fallbackHeld("fallback");
        },
        cap > 1080 ? 20_000 : 12_000,
      );
      videoHoldRef.current = {
        token,
        audioReady: false,
        videoReady: false,
        timer,
        targetSeconds:
          carrySeekRef.current?.token === token
            ? carrySeekRef.current.seconds
            : undefined,
      };
      usePlaybackStore.getState().setVideoStartup("waiting");
    } else {
      usePlaybackStore.getState().setVideoStartup("idle");
    }

    // Persist this track's title/artist beside its cache file so the
    // Storage tab can name it without depending on the library walk.
    // Read from the store imperatively (like the rest of this effect) so
    // the track object doesn't have to join the dependency array.
    {
      const st = usePlaybackStore.getState();
      void saveTrackMeta(
        streamVideoId,
        st.index >= 0 ? st.queue[st.index] : undefined,
      );
    }

    // Playback goes through the local cache server: yt-dlp downloads
    // the file and the server serves it with Range support, so a
    // metadata-time seek (position carry below) is an ordinary range
    // request, not a stall.
    // Master always plays the AUDIO variant, even in video mode: the
    // companion element (effect below) carries the picture. streamKind
    // is promoted to "video" only when the companion actually has
    // frames, so the reset-on-src-drop above stays authoritative.
    streamUrlFor(streamVideoId)
      .then((src) => {
        if (token !== resolveTokenRef.current) return;
        if (import.meta.env.DEV) {
          console.debug("[audio] setting src for", videoId, "→", src);
        }
        el.src = src;
        const st = usePlaybackStore.getState();
        st.setStreamUrl(src);
        const carry = carrySeekRef.current;
        if (carry && carry.token === token) {
          el.addEventListener(
            "loadedmetadata",
            () => {
              const c = carrySeekRef.current;
              if (!c || c.token !== token) return;
              carrySeekRef.current = null;
              if (token !== resolveTokenRef.current) return;
              // The two cuts can differ in length (MV intros/outros):
              // clamp into the new cut instead of restarting, a
              // near-the-end toggle restarting at 0 would look exactly
              // like the bug this exists to fix.
              const dur = Number.isFinite(el.duration)
                ? el.duration
                : undefined;
              const target =
                dur && dur > 1 ? Math.min(c.seconds, dur - 1) : c.seconds;
              try {
                el.currentTime = target;
              } catch {
                /* seek failed — plays from 0, non-fatal */
              }
            },
            { once: true },
          );
        }
        el.load();
        appLog(`src set ${videoId ?? "-"} ${mediaState(el)}`);
        const hold = videoHoldRef.current;
        if (hold && hold.token === token) {
          el.addEventListener(
            "canplay",
            () => {
              const h = videoHoldRef.current;
              if (h && h.token === token) {
                h.audioReady = true;
                maybeStartHeld();
              }
            },
            { once: true },
          );
          return;
        }
        if (usePlaybackStore.getState().playing) {
          void playLocal(el).catch((e) => {
            // AbortError from a NEW load (user skipped mid-start) is
            // harmless: the token is stale and the next resolve owns
            // playback. But WebKit also aborts a pending play() when
            // the page goes hidden before playback starts, leaving the
            // element paused with the store still wanting playback —
            // proven in the log 2026-08-31 14:18:36: play() rejected
            // AbortError on the visibility flip, canplay two seconds
            // later, silence (the desktop-switch stall). The token
            // still being current tells those cases apart. Starting
            // while hidden is allowed (queue auto-advance does it), so
            // retry once the element can play.
            if (e?.name === "AbortError") {
              if (token !== resolveTokenRef.current) return;
              if (!usePlaybackStore.getState().playing) return;
              appLog(
                "play() aborted with track still current; retrying at canplay",
              );
              const retry = () => {
                if (token !== resolveTokenRef.current) return;
                if (!usePlaybackStore.getState().playing) return;
                void playLocal(el).catch(() => {});
              };
              if (el.readyState >= 3) retry();
              else el.addEventListener("canplay", retry, { once: true });
              return;
            }
            if (import.meta.env.DEV) {
              console.error("[audio] play() rejected:", e);
            }
            usePlaybackStore
              .getState()
              .setStatus("error", e?.message ?? String(e));
          });
        }
      })
      .catch((e: Error) => {
        if (token !== resolveTokenRef.current) return;
        usePlaybackStore.getState().setStatus("error", e.message);
        usePlaybackStore.getState().setPlaying(false);
      });
    // `index` is in the deps so advancing to a different queue slot that
    // holds the *same* videoId (a duplicate in a playlist, radio dupes)
    // still re-resolves and plays instead of stalling on "loading" —
    // videoId/streamVideoId alone wouldn't change. Repeating a *single*
    // track (repeat-one, or repeat-all on a 1-track queue) keeps the same
    // index, so the store replays it via pendingSeek instead — see
    // `next()` in store/playback.ts. `premiumOk` so that gaining Premium
    // (sign-in, status re-check) re-resolves a track the gate parked.
    // `retryNonce` so the error handler can force a fresh stream-URL fetch
    // for the current track after a transient failure without changing id.
  }, [streamVideoId, wantVideo, videoId, index, premiumOk, retryNonce]);

  // Companion video: when the user picked the video version, stream the
  // high-res video-only DASH track into a muted element and keep it
  // glued to the audio master's clock. Frames come from the companion,
  // sound and all engine logic (duration correction, outro advance,
  // media keys) stay on the master. Drift is trimmed continuously with
  // a playbackRate nudge and snapped when it exceeds SNAP_S (seeks,
  // decoder stalls).
  useEffect(() => {
    const master = audioRef.current;
    if (!master) return;
    if (!wantVideo || !streamVideoId || !premiumOk) return;
    let cancelled = false;
    let comp = companionVideoSingleton;
    if (!comp) {
      comp = document.createElement("video");
      comp.muted = true;
      comp.playsInline = true;
      comp.preload = "auto";
      companionVideoSingleton = comp;
    }
    const video = comp;

    const SNAP_S = 0.3;
    const syncNow = () => {
      if (Number.isFinite(master.currentTime)) {
        video.currentTime = master.currentTime;
      }
    };
    const follow = () => {
      if (master.paused) {
        video.pause();
      } else if (video.src) {
        void playLocal(video).catch(() => {});
      }
    };
    const onLoaded = () => {
      if (cancelled) return;
      const st = usePlaybackStore.getState();
      st.setStreamKind("video");
      st.setStreamVideoHeight(video.videoHeight || null);
      const h = videoHoldRef.current;
      if (h) {
        // Carried start: frames-at-0 are the wrong frames. Seek to the
        // carried target and count the companion ready only once it can
        // play THERE, else the held release lets audio lead while the
        // video buffers its way to the target. Identity-checked (h)
        // so a stale canplay can't release a later generation's hold.
        if (h.targetSeconds !== undefined) {
          const onReadyAtTarget = () => {
            if (cancelled || videoHoldRef.current !== h) return;
            h.videoReady = true;
            maybeStartHeld();
          };
          video.addEventListener("canplay", onReadyAtTarget, { once: true });
          try {
            video.currentTime = h.targetSeconds;
          } catch {
            video.removeEventListener("canplay", onReadyAtTarget);
            h.videoReady = true;
            maybeStartHeld();
          }
          return;
        }
        h.videoReady = true;
        maybeStartHeld();
        return;
      }
      syncNow();
      follow();
    };
    const onError = () => {
      if (cancelled) return;
      // No high-res track (or it failed to decode): continue audio-only
      // so the surfaces keep showing artwork instead of a black box.
      if (videoHoldRef.current) {
        fallbackHeld("fallback");
      } else {
        usePlaybackStore.getState().setStreamKind("audio");
      }
    };
    const onWaiting = () => {
      if (!cancelled) usePlaybackStore.getState().setVideoBuffering(true);
    };
    const onFlowing = () => {
      if (!cancelled) usePlaybackStore.getState().setVideoBuffering(false);
    };
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("error", onError);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onFlowing);
    video.addEventListener("canplay", onFlowing);
    master.addEventListener("play", follow);
    master.addEventListener("pause", follow);
    master.addEventListener("seeked", syncNow);
    // Continuous drift trim: small offsets are absorbed by a playback-
    // rate nudge (invisible), anything past SNAP_S snaps. Also re-snaps
    // after decoder stalls, where the companion silently falls behind.
    //
    // Mid-download WebM adds a failure mode: WebKit fetches WebM as one
    // sequential stream, so a forward seek past the downloaded edge
    // CLAMPS there and the companion keeps playing frames from the
    // wrong timestamp — burnt-in captions visibly disagreeing with the
    // audio/lyrics. When the master's position isn't inside the
    // companion's buffered ranges, freeze the frames with the buffering
    // chip up (what YT does) and re-snap once the download catches up.
    const HOLD_S = 1.5;
    const masterInBuffer = () =>
      timeInBuffered(video.buffered, master.currentTime);
    const driftTick = () => {
      if (video.readyState < 2 || master.paused) return;
      const d = master.currentTime - video.currentTime;
      if (Math.abs(d) <= SNAP_S) {
        if (video.paused) void playLocal(video).catch(() => {});
        video.playbackRate =
          master.playbackRate + Math.max(-0.04, Math.min(0.04, d * 0.1));
        return;
      }
      if (masterInBuffer()) {
        video.currentTime = master.currentTime;
        video.playbackRate = master.playbackRate;
        if (video.paused) void playLocal(video).catch(() => {});
        return;
      }
      // Target unreachable in EITHER direction (evicted early data on a
      // backward seek behaves like undownloaded data on a forward one):
      // freeze rather than play wrong-time frames.
      if (Math.abs(d) > HOLD_S) {
        if (!video.paused) video.pause();
        usePlaybackStore.getState().setVideoBuffering(true);
        return;
      }
      // Small or backward miss with odd buffer state: try anyway, the
      // next tick re-evaluates.
      video.currentTime = master.currentTime;
      video.playbackRate = master.playbackRate;
    };
    const drift = window.setInterval(driftTick, 1000);

    streamUrlFor(streamVideoId, {
      vonly: true,
      vonlyHeight: useSettingsStore.getState().videoQuality,
    })
      .then((src) => {
        if (cancelled) return;
        video.src = src;
        video.load();
      })
      .catch(() => {
        if (cancelled) return;
        if (videoHoldRef.current) {
          fallbackHeld("fallback");
        } else {
          usePlaybackStore.getState().setStreamKind("audio");
        }
      });

    // Quality changes hot-swap WITHOUT tearing the surface down: a
    // throwaway element warms the proxy's cache for the new cap first,
    // and only then the visible element reloads, which the local cache
    // satisfies near-instantly. Doing this as a plain src swap instead
    // (or by keying the whole effect on the quality) blanks the video
    // and resets streamKind, so the player visibly falls back to the
    // artwork layout for however long the new download takes: exactly
    // the "video disappeared, audio kept going" report.
    let switchToken = 0;
    let warm: HTMLVideoElement | null = null;
    const switchQuality = async (q: number) => {
      const token = ++switchToken;
      try {
        const src = await streamUrlFor(streamVideoId, {
          vonly: true,
          vonlyHeight: q,
        });
        if (cancelled || token !== switchToken) return;
        if (warm) {
          warm.removeAttribute("src");
          warm.load();
        }
        warm = document.createElement("video");
        warm.muted = true;
        warm.preload = "auto";
        const w = warm;
        w.addEventListener(
          "loadeddata",
          () => {
            if (cancelled || token !== switchToken) return;
            video.src = src;
            video.load();
            w.removeAttribute("src");
            w.load();
            if (warm === w) warm = null;
          },
          { once: true },
        );
        w.src = src;
        w.load();
      } catch {
        // keep playing at the current quality
      }
    };
    let lastQuality = useSettingsStore.getState().videoQuality;
    const unsubQuality = useSettingsStore.subscribe((state) => {
      const q = state.videoQuality;
      if (q === lastQuality) return;
      lastQuality = q;
      void switchQuality(q);
    });

    return () => {
      cancelled = true;
      unsubQuality();
      if (warm) {
        warm.removeAttribute("src");
        warm.load();
      }
      window.clearInterval(drift);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onFlowing);
      video.removeEventListener("canplay", onFlowing);
      master.removeEventListener("play", follow);
      master.removeEventListener("pause", follow);
      master.removeEventListener("seeked", syncNow);
      video.pause();
      video.removeAttribute("src");
      video.load();
      const st = usePlaybackStore.getState();
      st.setStreamKind("audio");
      st.setStreamVideoHeight(null);
      st.setVideoBuffering(false);
      // A pending hold dies with this companion instance, SILENTLY (no
      // play call: on a track change the old src is still on the master
      // for a beat and starting it would blip the previous song). The
      // master resolve effect re-runs right after every cleanup of this
      // effect and re-establishes hold state for the new inputs.
      if (videoHoldRef.current) {
        window.clearTimeout(videoHoldRef.current.timer);
        videoHoldRef.current = null;
      }
    };
  }, [streamVideoId, wantVideo, premiumOk, retryNonce]);

  // Play / pause follow store.
  const playing = usePlaybackStore((s) => s.playing);
  const casting = useCastStore((s) => s.deviceId !== null);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (casting) {
      // The receiver pulls the same stream for itself, so anything playing
      // here is a second copy of the track a few hundred ms out of phase.
      // Pause rather than mute: a muted element still holds the audio
      // session, which would leave the system Now Playing entry pointing at
      // a track this machine is not the one playing.
      el.pause();
      return;
    }
    if (playing && !premiumOk) {
      // Resume attempts (play button, Space, SMTC play) on a gated track
      // never reach the resolve effect (its deps don't include
      // `playing`), so intercept them here.
      usePlaybackStore.getState().setPlaying(false);
      openPremiumGate();
      return;
    }
    if (!el.src) return;
    if (playing) {
      // Startup hold active: the intent is recorded in `playing` and
      // maybeStartHeld() acts on it at release. Playing now would leak
      // audio ahead of the frames.
      if (videoHoldRef.current) return;
      void playLocal(el).catch((e) => {
        if (e?.name === "AbortError") return;
        usePlaybackStore.getState().setStatus("error", e?.message ?? String(e));
      });
    } else {
      el.pause();
    }
  }, [playing, premiumOk, casting]);

  // Stall watchdog.
  //
  // A load that never produces a single byte fires no `error` event, so
  // the retry in onError never runs and nothing else is listening: the
  // element sits at readyState 0 with networkState LOADING and the UI
  // shows a spinner forever. Seen 2026-09-03 20:34, track 3c7Iw3AoiZQ:
  // `src set` then `waiting` then `stalled`, and the stream server never
  // logged a GET for it at all, so there was no request to time out and
  // no failure to report. The app had no way to notice.
  //
  // Re-requesting is cheap enough to be the right answer even when the
  // load was merely slow rather than dead: the proxy keys in-flight work
  // by video id behind a OnceCell, so a second request joins the download
  // already running instead of starting another one.
  //
  // The delay has to clear a legitimately slow cold start. Measured over
  // 279 resolves: median 5.0s, 90th percentile 11.5s, slowest 33.7s, and
  // a timed-out resolve may now be retried once, so the honest worst case
  // is around a minute. 75s sits past that, which means this only fires
  // for a load that is genuinely going nowhere.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !videoId || !playing) return;
    const timer = window.setTimeout(() => {
      const s = usePlaybackStore.getState();
      const cur = s.index >= 0 ? s.queue[s.index] : undefined;
      // Moved on, paused, or it started after all: nothing to do.
      if (!cur || cur.videoId !== videoId || !s.playing) return;
      if (el.readyState >= 3 || el.buffered.length > 0) return;
      const key = `${cur.videoId}:${s.index}`;
      const state = `rs=${el.readyState} ns=${el.networkState}`;
      if (retriedTrackRef.current === key) {
        // Already reloaded this track once. Say so rather than looping.
        appLog(`stalled again after a reload (${state}); giving up`);
        s.setStatus("error", "The stream never started");
        return;
      }
      retriedTrackRef.current = key;
      appLog(
        `nothing loaded after ${STALL_RELOAD_MS}ms (${state}); reloading the source`,
      );
      s.setStatus("loading");
      setRetryNonce((n) => n + 1);
    }, STALL_RELOAD_MS);
    return () => window.clearTimeout(timer);
  }, [videoId, playing, retryNonce]);

  // Volume / mute follow store.
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // <audio>.volume is linear amplitude (0..1), but loudness perception
    // is logarithmic — a linear slider crams almost all the perceivable
    // change into the bottom ~20% and 20–100% sounds nearly identical.
    // Apply a cubic curve so the slider tracks perceived loudness.
    const clamped = Math.max(0, Math.min(1, volume));
    el.volume = clamped ** 3;
    el.muted = muted;
  }, [volume, muted]);

  // Handle seek requests.
  const pendingSeek = usePlaybackStore((s) => s.pendingSeek);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || pendingSeek === undefined) return;
    // A deliberate seek while a same-track reload is in flight: the
    // element still has the OLD (or no) src, so applying it here would
    // be consumed by the reload and then overwritten by the carried
    // position at loadedmetadata. Replace the carry (and the hold
    // target) instead; the metadata listener applies it.
    const carry = carrySeekRef.current;
    if (carry && carry.token === resolveTokenRef.current) {
      carry.seconds = pendingSeek;
      const h = videoHoldRef.current;
      if (h && h.token === carry.token) h.targetSeconds = pendingSeek;
      usePlaybackStore.getState().clearPendingSeek();
      return;
    }
    try {
      el.currentTime = pendingSeek;
    } catch {
      /* seek failed — non-fatal */
    }
    usePlaybackStore.getState().clearPendingSeek();
    // A deliberate seek into the tail means the user wants the outro —
    // disable the long-outro auto-advance for this track.
    if (
      videoId &&
      ((lastVocalRef.current !== null &&
        pendingSeek > lastVocalRef.current + 10) ||
        (() => {
          const cur =
            usePlaybackStore.getState().queue[
              usePlaybackStore.getState().index
            ];
          return !!cur?.duration && pendingSeek > cur.duration;
        })())
    ) {
      outroSuppressedRef.current = videoId;
    }
    {
      // Keep the system Now Playing clock in step with the new playhead.
      const s = usePlaybackStore.getState();
      const cur = s.index >= 0 ? s.queue[s.index] : undefined;
      const dur = s.duration > 0 ? s.duration : (cur?.duration ?? 0);
      applyMediaSessionPosition(pendingSeek, dur);
    }
    // repeat-one and error auto-advance re-select the same track and set
    // { pendingSeek: 0, playing: true } without changing `playing` (already
    // true), so the [playing] effect never re-fires. After an `ended` event
    // the element is paused, so seeking to 0 alone leaves it silent. Resume
    // here when the store wants playback but the element is paused.
    if (
      usePlaybackStore.getState().playing &&
      el.paused &&
      el.src &&
      !videoHoldRef.current
    ) {
      void playLocal(el).catch((e) => {
        if (e?.name === "AbortError") return;
        usePlaybackStore.getState().setStatus("error", e?.message ?? String(e));
      });
    }
  }, [pendingSeek]);

  // OS media controls are driven from Rust via souvlaki, not
  // navigator.mediaSession — the webview's own media session shows up as
  // "Unknown app" because it belongs to the WebView2 child process. Metadata /
  // state is pushed by the media_update effect lower down; buttons come back
  // via the media-control listener. See src-tauri/src/media.rs.

  // macOS Now Playing is owned by the WEBVIEW's media session, not the
  // native MPNowPlayingInfoCenter path. WebKit surfaces the playing
  // <audio> element in the system widget on its own, so a native session
  // alongside it produced two rows (a blank "YTubic" twin above the real
  // track). We feed navigator.mediaSession full metadata (incl. artwork,
  // which the native path could never safely provide) and leave the
  // native session unregistered. Fires on track change and play/pause.
  const videoStartupPhase = usePlaybackStore((s) => s.videoStartup);
  useEffect(() => {
    const s = usePlaybackStore.getState();
    const dur = s.duration > 0 ? s.duration : (track?.duration ?? 0);
    // Report ACTUAL playback: while the video-startup hold is pending
    // the element is paused, and claiming "playing" would make Now
    // Playing extrapolate a clock that is not moving.
    const actuallyPlaying = playing && videoStartupPhase !== "waiting";
    applyMediaSessionMetadata(track, actuallyPlaying);
    applyMediaSessionPosition(s.position, dur);
  }, [track, playing, videoStartupPhase]);

  // Tray menu commands come via a Tauri event. `cancelled` flag
  // protects against StrictMode's mount→unmount→mount race that
  // would otherwise leak duplicate listeners and double-call
  // `toggle()` (which would silently no-op the play/pause hotkey).
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen<string>("tray-action", (e) => {
      const store = usePlaybackStore.getState();
      if (e.payload === "play_pause") store.toggle();
      else if (e.payload === "prev") store.prev();
      else if (e.payload === "next") store.next();
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // (The old MPRemoteCommandCenter bridge is gone: with the webview
  // session owning macOS Now Playing, its action handlers below receive
  // the system transport presses. Two registered command targets meant
  // every press could fire twice.)

  // System media-control / media-key button presses (SMTC on Windows, MPRIS
  // on Linux) arrive from Rust via souvlaki as a
  // `media-control` event. Drive the store the same way the old
  // navigator.mediaSession action handlers did. `cancelled` guards against
  // StrictMode's mount→unmount→mount double-listen, like the tray listener.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen<{ action: string; position?: number }>("media-control", (e) => {
      const store = usePlaybackStore.getState();
      appLog(
        `media-control ${e.payload.action} (store playing=${store.playing})`,
      );
      if (stormActiveUntil > performance.now()) {
        appLog(`media-control ${e.payload.action} IGNORED: play/pause storm`);
        return;
      }
      switch (e.payload.action) {
        case "play":
          store.setPlaying(true);
          break;
        case "pause":
        case "stop":
          store.setPlaying(false);
          break;
        case "toggle":
          store.toggle();
          break;
        case "next":
          store.next();
          break;
        case "previous":
          store.prev();
          break;
        case "seek":
          if (typeof e.payload.position === "number")
            store.seek(e.payload.position);
          break;
      }
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // System media commands on macOS route through WKWebView's media
  // session — upstream removed these handlers when souvlaki took over
  // on Windows, which left the mac widget's buttons acting on the
  // element directly and desyncing the store. Mac-only: Windows keeps
  // the souvlaki media-control path.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    if (!navigator.userAgent.includes("Mac")) return;
    const api = navigator.mediaSession;
    const store = usePlaybackStore.getState;
    // Register each action separately: WebKit throws NotSupportedError for
    // actions it doesn't implement, and one bad action must not abort the
    // rest (or the cleanup).
    const trySet = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        api.setActionHandler(action, handler);
      } catch {
        /* unsupported on this WebKit build */
      }
    };
    trySet("play", () => {
      appLog(`mediaSession play (store playing=${store().playing})`);
      if (stormActiveUntil > performance.now()) return;
      store().setPlaying(true);
    });
    trySet("pause", () => {
      appLog(`mediaSession pause (store playing=${store().playing})`);
      if (stormActiveUntil > performance.now()) return;
      store().setPlaying(false);
    });
    trySet("previoustrack", () => store().prev());
    trySet("nexttrack", () => store().next());
    trySet("seekto", (details) => {
      if (typeof details.seekTime === "number") store().seek(details.seekTime);
    });
    return () => {
      trySet("play", null);
      trySet("pause", null);
      trySet("previoustrack", null);
      trySet("nexttrack", null);
      trySet("seekto", null);
    };
  }, []);

  // Prefetch the next queued track in the background while the current
  // one plays. First-time plays take ~2s (yt-dlp resolve + first audio
  // chunk); by the time the user hits "next" the file is cached on
  // disk and playback starts instantly with full seek support.
  const status = usePlaybackStore((s) => s.status);

  // App Nap guard. Audible audio keeps the process awake on its own,
  // but the silent gap between tracks doesn't: with the window on
  // another Space, macOS naps the process mid-download and the
  // "download done → play" completion crawls until the window is
  // visible again (next song only started after switching back to
  // that desktop). Hold an activity assertion whenever playback is
  // wanted — loading counts — and release it when idle, so a parked
  // player still naps like any background app. No-op off macOS.
  useEffect(() => {
    const active = playing || status === "loading";
    invoke("set_playback_activity", { active }).catch(() => {
      /* older backend without the command — nap stays, nothing breaks */
    });
  }, [playing, status]);
  const { nextVideoId } = usePlaybackStore(
    useShallow((s) => ({
      nextVideoId:
        s.index >= 0 && s.index + 1 < s.queue.length
          ? s.queue[s.index + 1].videoId
          : undefined,
    })),
  );
  // Substitute via source-prefs for the prefetch too — otherwise we'd
  // warm the cache for the wrong stream when the user has switched the
  // upcoming track to its video version.
  const nextStreamVideoId = useTrackSourceStore((s) =>
    nextVideoId ? resolveStreamId(nextVideoId, s.byVideoId) : undefined,
  );
  useEffect(() => {
    if (status !== "ready") return;
    if (!nextStreamVideoId) return;
    void prefetchStream(nextStreamVideoId);
    // Label the prefetched file too — same reasoning as the play path.
    const st = usePlaybackStore.getState();
    void saveTrackMeta(
      nextStreamVideoId,
      st.index >= 0 && st.index + 1 < st.queue.length
        ? st.queue[st.index + 1]
        : undefined,
    );
  }, [status, nextStreamVideoId]);

  // Auto-extend the queue with radio tracks when we're near the end, so
  // playback continues past the explicit queue.
  const autoRadio = usePlaybackStore((s) => s.autoRadio);
  const { qLen, qIndex, seedVideoId } = usePlaybackStore(
    useShallow((s) => ({
      qLen: s.queue.length,
      qIndex: s.index,
      seedVideoId: s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
    })),
  );

  // Drain a pending server-side shuffle continuation: when playback nears
  // the tail of the queue, pull the next ~50 tracks of the permutation and
  // append them. Deduped against the queue — once the permutation is
  // exhausted YTM starts repeating tracks, which is the signal to stop.
  const queueContinuation = usePlaybackStore((s) => s.queueContinuation);
  const continuationFetchingRef = useRef(false);
  useEffect(() => {
    if (!queueContinuation) return;
    if (qIndex < 0 || qLen === 0) return;
    // Only fetch once the playhead is close to the tail, so a freshly
    // built 50-track queue doesn't immediately drain its whole source.
    if (qLen - 1 - qIndex > 5) return;
    if (continuationFetchingRef.current) return;
    continuationFetchingRef.current = true;
    const token = queueContinuation;
    fetchWatchQueueContinuation(token)
      .then((page) => {
        const s = usePlaybackStore.getState();
        // Stale guard: the queue was replaced while the fetch was in flight.
        if (s.queueContinuation !== token) return;
        const seen = new Set(s.queue.map((t) => t.videoId));
        const fresh = page.tracks.filter((t) => !seen.has(t.id));
        if (fresh.length) s.appendToQueue(fresh);
        s.setQueueContinuation(
          fresh.length > 0 ? page.continuationToken : undefined,
        );
      })
      .catch(() => {
        // Fail open: drop the token so auto-radio (if on) can take over at
        // the end of the queue instead of wedging on a broken continuation.
        const s = usePlaybackStore.getState();
        if (s.queueContinuation === token) s.setQueueContinuation(undefined);
      })
      .finally(() => {
        continuationFetchingRef.current = false;
      });
  }, [queueContinuation, qIndex, qLen]);

  const radioFetchedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!autoRadio) return;
    // A pending shuffle continuation owns the tail; radio only takes over
    // once it's exhausted (the drain effect clears it).
    if (queueContinuation) return;
    if (qIndex < 0 || !seedVideoId) return;
    // Only fire when the current track is the last queued one.
    if (qIndex < qLen - 1) return;
    if (radioFetchedForRef.current === seedVideoId) return;
    radioFetchedForRef.current = seedVideoId;
    fetchRadio(seedVideoId)
      .then((tracks) => {
        // Guard against a stale fetch: the user may have replaced the queue
        // (playNow/setQueue) while the radio request was in flight. Only
        // append if this seed is still the current, last-in-queue track.
        const s = usePlaybackStore.getState();
        const cur = s.index >= 0 ? s.queue[s.index]?.videoId : undefined;
        if (cur !== seedVideoId || s.index < s.queue.length - 1) return;
        const rest = tracks.filter((t) => t.id !== seedVideoId);
        if (rest.length) s.appendToQueue(rest);
      })
      .catch(() => {
        // Allow a retry on transient failure.
        radioFetchedForRef.current = undefined;
      });
  }, [autoRadio, queueContinuation, qIndex, qLen, seedVideoId]);

  // Push metadata + playback state to the OS media controls. Native backends
  // interpolate the scrubber between pushes while the state is
  // Playing, so we don't push on every timeupdate — just on track / play-state
  // / duration change, plus a light 2s refresh while playing to correct drift
  // and reflect seeks. Live values are read imperatively so this OS sync never
  // re-triggers the resolve / playback effects above.
  const duration = usePlaybackStore((s) => s.duration);
  const position = usePlaybackStore((s) => s.position);

  // Long-outro auto-advance. Extended uploads and music-video audio can
  // run minutes past the actual song; when the synced lyrics say the
  // vocals ended long ago (see shouldSkipOutro's thresholds), move on.
  // Reuses the same lyric queries the panel fires, so this costs no
  // extra network beyond what the lyrics UI already does.
  const { queries: lyricQueries, best: lyricBest } = useLyricsSources(
    track,
    !!track,
  );
  const lastVocal = useMemo(() => {
    const data = lyricBest ? lyricQueries[lyricBest]?.data : null;
    if (!data || data.kind !== "timed" || data.lines.length === 0) {
      return null;
    }
    // Trailing "♪" instrumental markers aren't vocals — walk back to the
    // last line with real text.
    for (let i = data.lines.length - 1; i >= 0; i--) {
      const line = data.lines[i];
      const text = line.text.trim();
      if (text && text !== "♪") return line.end ?? line.start;
    }
    return null;
  }, [lyricBest, lyricQueries]);
  useEffect(() => {
    lastVocalRef.current = lastVocal;
  }, [lastVocal]);
  // Metadata-end guard: some YT entries stream audio whose container
  // claims a far longer duration than the entry's own listed length
  // (a "4:21" row whose element reports 8:41). The listed metadata
  // length is the song; once playback runs meaningfully past it while
  // the element believes in a much longer file, move on. Seeking past
  // the listed end disables it for that track (same suppression as the
  // outro skip — a deliberate listen wins).
  // Reference for THIS guard is the loaded file's own length. Using the
  // queue row's instead is what cut music videos off mid-play: a 6:15
  // video against a 5:30 song satisfied "element is 1.5x the metadata"
  // and then fired next() the moment playback passed 5:32. `?? 0`
  // disables the guard whenever we have no trustworthy reference, which
  // is the correct default — advancing on a guess is worse than not
  // advancing at all.
  const metaDuration = metaReference ?? 0;
  useEffect(() => {
    if (!playing || !videoId) return;
    if (outroSkippedRef.current === videoId) return;
    if (outroSuppressedRef.current === videoId) return;
    if (
      metaDuration > 60 &&
      rawElDurationRef.current > metaDuration * 1.5 &&
      position > metaDuration + 2
    ) {
      outroSkippedRef.current = videoId;
      usePlaybackStore.getState().next();
    }
  }, [position, duration, metaDuration, playing, videoId]);

  useEffect(() => {
    if (!playing || !videoId || !lastVocal) return;
    if (outroSkippedRef.current === videoId) return;
    if (outroSuppressedRef.current === videoId) return;
    if (shouldSkipOutro(position, duration, lastVocal)) {
      outroSkippedRef.current = videoId;
      if (import.meta.env.DEV) {
        console.debug(
          "[audio] long outro: advancing",
          videoId,
          `pos=${Math.round(position)}s lastVocal=${Math.round(lastVocal)}s dur=${Math.round(duration)}s`,
        );
      }
      usePlaybackStore.getState().next();
    }
  }, [position, duration, playing, videoId, lastVocal]);
  useEffect(() => {
    const push = () => {
      const s = usePlaybackStore.getState();
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      if (!t) {
        void invoke("media_clear").catch(() => {});
        return;
      }
      void invoke("media_update", {
        title: t.title,
        artist: buildArtistLabel(t),
        album: t.album ?? "",
        thumbnail: pickThumbnail(t.thumbnails, 512) ?? "",
        duration: Number.isFinite(s.duration) ? s.duration : 0,
        elapsed: s.position,
        paused: !s.playing,
      }).catch(() => {});
    };
    push();
    if (!playing) return;
    const id = window.setInterval(push, 2000);
    return () => window.clearInterval(id);
  }, [track, playing, duration]);

  // Discord Rich Presence mirrors the same metadata, but pushed only on
  // track / play-state / duration change — never the 2s position refresh
  // above. Discord rate-limits activity updates, and it derives its own
  // progress bar from the start/end timestamps, so one push animates the bar
  // for the whole song. The worker + (re)connect lifecycle live in
  // src-tauri/src/discord.rs; the on/off toggle is mirrored separately by
  // useDiscordPresenceSync, which also clears the activity when disabled.
  const discordRp = useSettingsStore((s) => s.discordRichPresence);
  useEffect(() => {
    if (!discordRp) return; // disabled → useDiscordPresenceSync cleared it
    const s = usePlaybackStore.getState();
    const t = s.index >= 0 ? s.queue[s.index] : undefined;
    if (!t) {
      void invoke("discord_clear").catch(() => {});
      return;
    }
    const dur = Number.isFinite(s.duration) ? s.duration : 0;
    // Timestamps (hence the progress bar) only while actually playing: Discord
    // can't freeze a bar, so paused shows none rather than a wrong one. Unix
    // milliseconds, per Discord's Activity spec.
    let startMs: number | null = null;
    let endMs: number | null = null;
    if (s.playing && dur > 0) {
      startMs = Math.round(Date.now() - s.position * 1000);
      endMs = Math.round(startMs + dur * 1000);
    }
    void invoke("discord_update", {
      title: t.title,
      artist: buildArtistLabel(t),
      album: t.album ?? "",
      imageUrl: pickThumbnail(t.thumbnails, 512) ?? "",
      startMs,
      endMs,
    }).catch(() => {});
  }, [track, playing, duration, discordRp]);
}

function buildArtistLabel(track: QueueTrack): string {
  if (track.artists?.length) return track.artists.map((a) => a.name).join(", ");
  return artistLineFromSubtitle(track.subtitle);
}

/**
 * Feed the webview media session, which owns the macOS system Now
 * Playing entry (Control Center / menu bar widget / AirPods). WebKit
 * surfaces the playing <audio> element there regardless, so owning that
 * session — instead of running a second native MPNowPlayingInfoCenter
 * one next to it — is what keeps the widget to a single, correct row.
 * Artwork comes free as a URL here; the native path couldn't provide it
 * safely at all. Mac-gated like the action handlers below.
 */
function applyMediaSessionMetadata(
  track: QueueTrack | undefined,
  playing: boolean,
): void {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  if (!navigator.userAgent.includes("Mac")) return;
  const api = navigator.mediaSession;
  if (!track) {
    api.metadata = null;
    api.playbackState = "none";
    return;
  }
  const best = [...(track.thumbnails ?? [])]
    .filter((t) => !!t.url)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  const artwork: MediaImage[] = best
    ? [
        best.width && best.height
          ? { src: best.url, sizes: `${best.width}x${best.height}` }
          : { src: best.url },
      ]
    : [];
  api.metadata = new MediaMetadata({
    title: track.title,
    artist: buildArtistLabel(track),
    album: track.album ?? "",
    artwork,
  });
  api.playbackState = playing ? "playing" : "paused";
}

/**
 * Keep the widget's scrubber/clock in step. playbackRate stays 1;
 * paused-ness is conveyed via playbackState, and a rate of 0 is
 * rejected by some WebKit builds.
 */
function applyMediaSessionPosition(position: number, duration: number): void {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaSession?.setPositionState
  )
    return;
  if (!navigator.userAgent.includes("Mac")) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(Math.max(0, position), duration),
      playbackRate: 1,
    });
  } catch {
    /* transient position/duration mismatch during track switches */
  }
}
