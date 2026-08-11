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
import {
  effectiveVideoQuality,
  mediaErrorFailure,
  watchdogVerdict,
  VIDEO_ABSOLUTE_MS,
  VIDEO_FIRST_FRAME_MS,
  type VideoFailure,
  type VideoFailurePhase,
} from "@/lib/video-diagnostics";

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
function playLocal(el: HTMLMediaElement | null | undefined): Promise<void> {
  if (!el || isCasting()) return Promise.resolve();
  return el.play();
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

  // Video-mode startup hold: audio and frames start TOGETHER (YouTube
  // semantics) instead of audio leading by however long the vonly
  // download takes. Generation-keyed by the resolve token so duplicate
  // ids, retries, and stale listeners can't release someone else's
  // hold. Every route to el.play() must respect it.
  const videoHoldRef = useRef<{
    token: number;
    audioReady: boolean;
    videoReady: boolean;
    /** Interval id of the startup watchdog, not a one-shot timer: the
     *  attempt is judged on lack of PROGRESS, not on a fixed budget
     *  spanning resolve + download + decode. */
    watchdog: number;
    // Carried playhead for a same-track reload: the companion must be
    // seeked here and ready HERE (not at 0) before the held start
    // releases, or the audio leads while the video buffers its target.
    targetSeconds?: number;
  } | null>(null);
  // What the current video attempt has actually achieved, written by
  // the companion effect below and judged by the watchdog above it.
  // Separate from the hold because the hold is about WHEN to start
  // playing and this is about whether anything is happening at all.
  const videoProbeRef = useRef<{
    token: number;
    startedAt: number;
    lastProgressAt: number;
    phase: VideoFailurePhase;
    lastReadyState: number;
    lastBuffered: number;
  } | null>(null);
  /** Mark forward motion (and optionally advance the phase). */
  const noteVideoProgress = (phase?: VideoFailurePhase) => {
    const p = videoProbeRef.current;
    if (!p) return;
    if (phase) p.phase = phase;
    p.lastProgressAt = performance.now();
  };
  const maybeStartHeld = () => {
    const el = audioRef.current;
    const h = videoHoldRef.current;
    if (!el || !h || !h.audioReady || !h.videoReady) return;
    window.clearInterval(h.watchdog);
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
  /**
   * Give up on the video and continue audio-only. Detaches the
   * companion so a late loadeddata can't resurrect the video mid-song
   * at the wrong time.
   *
   * `failure` is what the UI shows and what the trace records; pass
   * null only for a deliberate stand-down (video mode switched off),
   * which is not a failure and must not display one. Unlike the old
   * fallbackHeld this also runs when no hold is pending, because a
   * video can die mid-song too and that was silently swallowed.
   */
  const abandonVideo = (failure: VideoFailure | null) => {
    const el = audioRef.current;
    const h = videoHoldRef.current;
    if (h) {
      window.clearInterval(h.watchdog);
      videoHoldRef.current = null;
    }
    videoProbeRef.current = null;
    const st = usePlaybackStore.getState();
    st.setVideoStartup(failure ? "failed" : "idle", failure ?? undefined);
    st.setStreamKind("audio");
    st.setStreamVideoHeight(null);
    st.setVideoBuffering(false);
    const comp = companionVideoSingleton;
    if (comp) {
      comp.removeAttribute("src");
      comp.load();
    }
    // Only a HELD start owes the user a play(): without a hold the
    // master was never suppressed and is already running.
    if (h && el && st.playing) void playLocal(el).catch(() => {});
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
        const meta =
          cur.index >= 0 ? cur.queue[cur.index]?.duration : undefined;
        cur.setDuration(correctedDuration(meta, el.duration));
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
        const meta =
          cur.index >= 0 ? cur.queue[cur.index]?.duration : undefined;
        cur.setDuration(correctedDuration(meta, end));
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
        s.setPlaying(false);
      }
    };
    const onElPlay = () => {
      const s = store();
      if (isCasting()) return;
      if (s.status === "ready" && !s.playing) {
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
      const cur =
        errored.index >= 0 ? errored.queue[errored.index] : undefined;
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

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("progress", onProgress);
    el.addEventListener("ended", onEnded);
    el.addEventListener("pause", onElPause);
    el.addEventListener("play", onElPlay);
    el.addEventListener("error", onError);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("pause", onElPause);
      el.removeEventListener("play", onElPlay);
      el.removeEventListener("error", onError);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
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
  const liveMetaDuration = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.duration : undefined,
  );
  useEffect(() => {
    if (!liveMetaDuration || !rawElDurationRef.current) return;
    usePlaybackStore
      .getState()
      .setDuration(
        correctedDuration(liveMetaDuration, rawElDurationRef.current),
      );
  }, [liveMetaDuration]);

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
    // companion becoming ready first still finds it.
    if (videoHoldRef.current) {
      window.clearInterval(videoHoldRef.current.watchdog);
      videoHoldRef.current = null;
    }
    if (wantVideo) {
      const startedAt = performance.now();
      const comp = companionVideoSingleton;
      // Advancing to a DUPLICATE of the playing track (same videoId at
      // another queue index) re-runs this effect but not the companion
      // effect, so no second loadeddata is coming for frames that are
      // already decoded. Count them as ready instead of waiting out a
      // timeout and throwing away a working video.
      const alreadyShowing = !!(
        comp?.getAttribute("src") &&
        comp.readyState >= 2 &&
        comp.videoWidth > 0
      );
      videoProbeRef.current = {
        token,
        startedAt,
        lastProgressAt: startedAt,
        phase: "resolving",
        lastReadyState: comp?.readyState ?? 0,
        lastBuffered: 0,
      };
      const watchdog = window.setInterval(() => {
        const h = videoHoldRef.current;
        const p = videoProbeRef.current;
        if (!h || h.token !== token || !p || p.token !== token) return;
        const nowMs = performance.now();
        if (h.videoReady) {
          // The video side is done and the hold is only waiting on the
          // audio master now. That is never a video failure — release
          // the hold at the absolute cap and let both elements catch
          // up rather than blaming the picture for the sound.
          if (nowMs - p.startedAt >= VIDEO_ABSOLUTE_MS) {
            h.audioReady = true;
            maybeStartHeld();
          }
          return;
        }
        // Affirmative progress: bytes buffered or a readyState step.
        // The failure this exists to catch fires NO media event at all
        // (networkState stuck LOADING, readyState HAVE_NOTHING), so
        // waiting to be told would wait forever.
        const live = companionVideoSingleton;
        if (live) {
          const buffered = live.buffered.length
            ? live.buffered.end(live.buffered.length - 1)
            : 0;
          if (live.readyState !== p.lastReadyState || buffered > p.lastBuffered) {
            p.lastReadyState = live.readyState;
            p.lastBuffered = buffered;
            p.lastProgressAt = nowMs;
          }
        }
        const verdict = watchdogVerdict({
          nowMs,
          startedAtMs: p.startedAt,
          lastProgressMs: p.lastProgressAt,
          phase: p.phase,
        });
        if (verdict) abandonVideo(verdict);
      }, 1000);
      videoHoldRef.current = {
        token,
        audioReady: false,
        videoReady: alreadyShowing,
        watchdog,
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
            // AbortError is what we get when a pending play() is
            // interrupted by a new load (e.g. user clicked the next
            // track before the current one started). It's harmless
            // and should never surface to the user.
            if (e?.name === "AbortError") return;
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
      noteVideoProgress("decode");
      // Affirmative readiness: `loadeddata` alone is not a picture.
      // WKWebView will happily report data for a track it cannot show,
      // and promoting that to "video" is how a dead 4K pull ended up
      // looking exactly like a track that simply has no video. Wait for
      // real dimensions (they can still arrive on a later `resize`);
      // the watchdog calls it if they never do.
      if (!video.videoWidth || !video.videoHeight) return;
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
      // Tearing the element down (`removeAttribute("src")` + `load()`)
      // can surface as an error event; an element holding nothing has
      // nothing to report.
      if (!video.getAttribute("src")) return;
      // READ the error. The old handler ignored `video.error` entirely,
      // which is the whole reason a failed 4K pull produced artwork and
      // not one word about why.
      abandonVideo(mediaErrorFailure(video.error));
    };
    const onWaiting = () => {
      if (!cancelled) usePlaybackStore.getState().setVideoBuffering(true);
    };
    const onFlowing = () => {
      if (!cancelled) usePlaybackStore.getState().setVideoBuffering(false);
    };
    const onLoadStart = () => noteVideoProgress("transport");
    const onProgress = () => noteVideoProgress();
    const onMetadata = () => noteVideoProgress("decode");
    // First-frame check. Frames that decode but never reach the screen
    // are a distinct failure from frames that never decode, and only
    // this phase can tell them apart. Armed on actual playback and only
    // while the surface is really on screen: a paused, detached or
    // backgrounded element is SUPPOSED to present nothing, and demanding
    // a frame from one would invent failures.
    let framesSeen = false;
    let frameHandle = 0;
    let frameTimer = 0;
    const onScreen = () =>
      video.isConnected && document.visibilityState === "visible";
    const onCompanionPlaying = () => {
      onFlowing();
      noteVideoProgress();
      if (cancelled || framesSeen || frameTimer) return;
      if (typeof video.requestVideoFrameCallback !== "function") return;
      if (!onScreen()) return;
      const armedAt = video.currentTime;
      frameHandle = video.requestVideoFrameCallback(() => {
        framesSeen = true;
        frameHandle = 0;
        window.clearTimeout(frameTimer);
        frameTimer = 0;
      });
      frameTimer = window.setTimeout(() => {
        frameTimer = 0;
        if (cancelled || framesSeen) return;
        // Re-check: the user may have paused, hidden the window or
        // navigated the surface away since it was armed.
        if (video.paused || !onScreen()) return;
        // A missing frame callback on its own is not proof of a broken
        // picture — WebKit throttles rendering for an occluded window
        // while still calling itself visible, and killing a video the
        // user is only half-watching would be a worse bug than the one
        // this whole change exists to fix. Only call it dead when the
        // media clock is stuck too, i.e. nothing at all is coming out.
        if (video.currentTime > armedAt + 0.25) return;
        abandonVideo({
          phase: "presentation",
          reason: `playback started but no frame appeared in ${Math.round(
            VIDEO_FIRST_FRAME_MS / 1000,
          )}s`,
        });
      }, VIDEO_FIRST_FRAME_MS);
    };
    video.addEventListener("loadeddata", onLoaded);
    // Dimensions can land after loadeddata; re-run the readiness check
    // rather than sitting on a 0x0 element until the watchdog fires.
    video.addEventListener("resize", onLoaded);
    video.addEventListener("error", onError);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onCompanionPlaying);
    video.addEventListener("canplay", onFlowing);
    video.addEventListener("loadstart", onLoadStart);
    video.addEventListener("progress", onProgress);
    video.addEventListener("loadedmetadata", onMetadata);
    master.addEventListener("play", follow);
    master.addEventListener("pause", follow);
    master.addEventListener("seeked", syncNow);
    // Continuous drift trim: small offsets are absorbed by a playback-
    // rate nudge (invisible), anything past SNAP_S snaps. Also re-snaps
    // after decoder stalls, where the companion silently falls behind.
    const drift = window.setInterval(() => {
      if (video.readyState < 2 || master.paused) return;
      const d = master.currentTime - video.currentTime;
      if (Math.abs(d) > SNAP_S) {
        video.currentTime = master.currentTime;
        video.playbackRate = master.playbackRate;
      } else {
        video.playbackRate =
          master.playbackRate + Math.max(-0.04, Math.min(0.04, d * 0.1));
      }
    }, 1000);

    streamUrlFor(streamVideoId, {
      vonly: true,
      vonlyHeight: effectiveVideoQuality(
        useSettingsStore.getState().videoQuality,
      ),
    })
      .then((src) => {
        if (cancelled) return;
        noteVideoProgress("transport");
        video.src = src;
        video.load();
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        abandonVideo({
          phase: "resolving",
          reason: `could not reach the local stream server (${
            e instanceof Error ? e.message : String(e)
          })`,
        });
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
          vonlyHeight: effectiveVideoQuality(q),
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
    // Compared as EFFECTIVE heights: while the cap is in place, 2160 and
    // 1440 both resolve to the same request as 1080, and re-downloading
    // an identical file to satisfy a menu click is pure churn.
    let lastQuality = effectiveVideoQuality(
      useSettingsStore.getState().videoQuality,
    );
    const unsubQuality = useSettingsStore.subscribe((state) => {
      const q = effectiveVideoQuality(state.videoQuality);
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
      window.clearTimeout(frameTimer);
      if (frameHandle && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(frameHandle);
      }
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("resize", onLoaded);
      video.removeEventListener("error", onError);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onCompanionPlaying);
      video.removeEventListener("canplay", onFlowing);
      video.removeEventListener("loadstart", onLoadStart);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("loadedmetadata", onMetadata);
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
        window.clearInterval(videoHoldRef.current.watchdog);
        videoHoldRef.current = null;
      }
      videoProbeRef.current = null;
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
    trySet("play", () => store().setPlaying(true));
    trySet("pause", () => store().setPlaying(false));
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
  const metaDuration = track?.duration ?? 0;
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
  if (typeof navigator === "undefined" || !navigator.mediaSession?.setPositionState) return;
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
