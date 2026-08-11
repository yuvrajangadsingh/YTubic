/**
 * Video-mode transport limits and startup diagnostics. Pure logic only —
 * no DOM, no store — so the decisions the companion video element makes
 * at runtime are unit-testable.
 */

/**
 * Hard ceiling on the height we actually request for the companion
 * video-only stream, regardless of what the user picked in the quality
 * menu.
 *
 * WHY, and what has to land before it can be raised again:
 *
 *  1. YouTube serves no h264 above 1080p, so `vonly_format()` asks for
 *     VP9-in-WebM at 1440p/2160p. WebKit's WebM media engine issues a
 *     single non-Range GET and consumes the object sequentially, so a
 *     WebM track can never be range-streamed through a plain
 *     `<video src>` — it either arrives whole or it never renders.
 *  2. The Rust stream server (see `stream_handler` in
 *     src-tauri/src/lib.rs) does not serve byte 0 until the WHOLE file
 *     is on disk. That reasoning was written for audio (moov-at-end,
 *     no valid Content-Range for an unknown length) and 4K silently
 *     inherited it: one 2160p attempt pulled 533 MB and minutes of wall
 *     clock before the element saw a single byte.
 *
 * At <=1080p the selector asks for mp4/avc1, which AVFoundation
 * range-fetches natively and which plays today. The cap is a temporary
 * stand-in for the range proxy; once the server can serve ranges out of
 * a partial file, delete this constant and the two call sites that read
 * it and the stored preference takes over again.
 */
export const VIDEO_QUALITY_CEILING = 1080;

/** The height actually requested from the stream server for `q`. */
export function effectiveVideoQuality(q: number): number {
  return Math.min(q, VIDEO_QUALITY_CEILING);
}

/** True when a quality tier is only unreachable because of the cap. */
export function isQualityCapped(q: number): boolean {
  return q > VIDEO_QUALITY_CEILING;
}

/**
 * Where a video attempt died. Deliberately named after what the
 * frontend can actually distinguish, not after an idealised pipeline:
 *
 *  - `resolving`    — asking the local server for a stream URL.
 *  - `transport`    — the URL is on the element and nothing has come
 *                     back yet. The server's own yt-dlp resolve AND the
 *                     whole download happen inside this window, because
 *                     it does not answer until the file is complete, so
 *                     a stall here is "no bytes", never "bad codec".
 *  - `decode`       — the element got data and rejected it, or reported
 *                     data with no picture in it (0x0).
 *  - `presentation` — decoded and playing, but no frame ever reached
 *                     the screen.
 */
export type VideoFailurePhase =
  | "resolving"
  | "transport"
  | "decode"
  | "presentation";

export type VideoFailure = {
  phase: VideoFailurePhase;
  /** One short human line. Shown in the UI, logged in the trace. */
  reason: string;
};

/** Phase wording for messages the user reads. */
const PHASE_LABEL: Record<VideoFailurePhase, string> = {
  resolving: "resolving the stream",
  transport: "downloading",
  decode: "decoding",
  presentation: "displaying",
};

/**
 * Map an HTMLMediaElement's `error` to a phase + human reason. The
 * companion's old handler never read this at all, which is why a failed
 * 4K pull became artwork with no explanation anywhere.
 *
 * MEDIA_ERR_ABORTED is transport, not decode: it means the fetch was
 * torn down (usually by us dropping `src`), so nothing was ever judged.
 */
export function mediaErrorFailure(
  err: { code: number; message?: string } | null | undefined,
): VideoFailure {
  const detail = err?.message?.trim() ? ` (${err.message.trim()})` : "";
  switch (err?.code) {
    case 1:
      return { phase: "transport", reason: `video load aborted${detail}` };
    case 2:
      return {
        phase: "transport",
        reason: `network error while fetching the video${detail}`,
      };
    case 3:
      return {
        phase: "decode",
        reason: `this machine could not decode the video${detail}`,
      };
    case 4:
      return {
        phase: "decode",
        reason: `video format not supported${detail}`,
      };
    default:
      return {
        phase: "decode",
        reason: err
          ? `video element error code ${err.code}${detail}`
          : "video element failed without reporting an error",
      };
  }
}

/**
 * Per-phase patience. Two different ideas, and conflating them is the
 * mistake this file exists to avoid:
 *
 *  - `noProgressMs` is a STALL detector. It can only be applied to a
 *    phase where something actually reports movement, which today means
 *    `decode` and nothing else.
 *  - `absoluteMs` is a deadline, measured from the start of THAT phase.
 *
 * `transport` gets a deadline and no stall rule at all. The stream
 * server does not answer a /stream request until the whole file is on
 * disk, so for the entire download the element observes no buffered
 * growth, no readyState change and no byte events — by construction. A
 * healthy 40 MB fetch and a wedged yt-dlp look identical from here, and
 * a stall rule would just cancel working playback.
 *
 * The transport deadline is sized so the SERVER always speaks first,
 * because its answer carries a real reason and this one is a guess
 * (src-tauri/src/lib.rs, `stream_handler`):
 *
 *     120s   the server's own bounded wait on the download
 *   +   5s   worst-case overshoot: the deadline is checked at the top of
 *            the loop and each pass can sleep a full 5s notify slice
 *   + ~25s   margin for the response itself, and for slack in when the
 *            element gets around to reporting the resulting error
 *   ------
 *     150s
 *
 * That margin is deliberately fat. Getting it wrong in the other
 * direction means the UI blames the video for something the server was
 * about to explain properly. It shrinks to something human once /stream
 * can answer from a partial file.
 */
export const VIDEO_PHASE_BUDGET: Record<
  VideoFailurePhase,
  { noProgressMs?: number; absoluteMs: number }
> = {
  // Building a loopback URL. streamUrlFor retries the IPC for ~2s.
  resolving: { absoluteMs: 15_000 },
  // yt-dlp resolve + the whole download happen inside this one, unseen.
  transport: { absoluteMs: 150_000 },
  // Media events fire here, so silence is real evidence, and a decode
  // that takes half a minute is broken however you look at it.
  decode: { noProgressMs: 9_000, absoluteMs: 30_000 },
  presentation: { absoluteMs: 15_000 },
};

/** How long a playing, on-screen video may present no frame at all. */
export const VIDEO_FIRST_FRAME_MS = 6_000;

/**
 * One video attempt's timing, as the frontend sees it. The server half
 * of the same story (cache hit, whether the request blocked on a whole
 * download, bytes) is logged from Rust under the same `[vtrace]` prefix
 * — grep both and a single attempt reads end to end.
 */
export type VideoTrace = {
  videoId: string;
  /** Height actually requested, i.e. already capped. */
  requestedHeight: number;
  /** ms from the attempt starting to holding a stream URL. */
  resolveMs?: number;
  /** ms to the first sign of data on the element. */
  firstByteMs?: number;
  metadataMs?: number;
  dataMs?: number;
  width?: number;
  height?: number;
};

/**
 * Terminal state of an attempt. `timeout:<phase>` is kept distinct from
 * `failed:<phase>` on purpose: one means nothing answered, the other
 * means something answered and was wrong.
 */
export type VideoOutcome =
  | { kind: "played" }
  | { kind: "failed"; failure: VideoFailure }
  | { kind: "timeout"; failure: VideoFailure }
  | { kind: "abandoned"; why: string };

function outcomeField(o: VideoOutcome): string {
  switch (o.kind) {
    case "played":
      return "played";
    case "failed":
      return `failed:${o.failure.phase}:${o.failure.reason}`;
    case "timeout":
      return `timeout:${o.failure.phase}`;
    case "abandoned":
      return `abandoned:${o.why}`;
  }
}

const ms = (v: number | undefined) => (v === undefined ? "-" : Math.round(v));

/** One greppable line per attempt. Pure so the format is testable. */
export function formatVideoTrace(
  t: VideoTrace,
  outcome: VideoOutcome,
  totalMs: number,
): string {
  const dims =
    t.width && t.height ? `${t.width}x${t.height}` : "-";
  return (
    `[vtrace] video=${t.videoId} h=${t.requestedHeight}` +
    ` resolve_ms=${ms(t.resolveMs)} first_byte_ms=${ms(t.firstByteMs)}` +
    ` meta_ms=${ms(t.metadataMs)} data_ms=${ms(t.dataMs)}` +
    ` dims=${dims} total_ms=${Math.round(totalMs)}` +
    ` outcome=${outcomeField(outcome)}`
  );
}

/**
 * The watchdog's whole decision, kept pure so it can be tested without
 * a media element. Returns null while the attempt is still allowed to
 * run. The message always names the phase it gave up in — a stall in
 * `transport` must never be reported as a decoder problem.
 *
 * Times are the accrued ones: the caller does not count time the page
 * spent hidden, cast, or with its timers throttled.
 */
export function watchdogVerdict(s: {
  nowMs: number;
  phaseStartedAtMs: number;
  lastProgressMs: number;
  phase: VideoFailurePhase;
}): VideoFailure | null {
  const label = PHASE_LABEL[s.phase];
  const budget = VIDEO_PHASE_BUDGET[s.phase];
  const inPhase = s.nowMs - s.phaseStartedAtMs;
  if (inPhase >= budget.absoluteMs) {
    return {
      phase: s.phase,
      reason: `gave up after ${Math.round(inPhase / 1000)}s while ${label}`,
    };
  }
  if (budget.noProgressMs !== undefined) {
    const idle = s.nowMs - s.lastProgressMs;
    if (idle >= budget.noProgressMs) {
      return {
        phase: s.phase,
        reason: `stalled for ${Math.round(idle / 1000)}s while ${label}`,
      };
    }
  }
  return null;
}

/**
 * Is there a picture to show yet?
 *
 * `loadeddata` alone is not one (WKWebView reports data for tracks it
 * cannot display), and dimensions alone are not one either: a `resize`
 * fires at METADATA time, before a single frame is decoded, so keying
 * off dimensions promoted the surface and released the startup hold with
 * nothing to draw. Both, plus the readyState that means a current frame
 * exists.
 */
export function canPromoteVideo(s: {
  loadedDataSeen: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
}): boolean {
  return (
    s.loadedDataSeen &&
    // HAVE_CURRENT_DATA
    s.readyState >= 2 &&
    s.videoWidth > 0 &&
    s.videoHeight > 0
  );
}

/** The bits of a media element this module needs. Structural so the
 *  wiring can be tested without a DOM. */
export type ReadinessSource = {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
};

/** Events that can change the answer to "is there a picture yet". */
const READINESS_EVENTS = [
  "loadeddata",
  "resize",
  "canplay",
  "playing",
] as const;

/**
 * Call `onReady` the moment the element actually has a frame to show.
 *
 * Listening to `loadeddata` alone strands a video whose dimensions
 * arrive afterwards: the check would never run again and a working
 * track would sit there until the watchdog killed it. So every event
 * that can complete the picture re-runs the test, and the latch resets
 * on a fresh load (a quality hot-swap reassigns `src`) so the surface
 * re-syncs then too.
 *
 * Returns a disposer.
 */
export function watchVideoReadiness(
  el: ReadinessSource,
  onReady: () => void,
): () => void {
  let loadedDataSeen = false;
  let promoted = false;
  const evaluate = () => {
    if (promoted) return;
    if (
      !canPromoteVideo({
        loadedDataSeen,
        readyState: el.readyState,
        videoWidth: el.videoWidth,
        videoHeight: el.videoHeight,
      })
    ) {
      return;
    }
    promoted = true;
    onReady();
  };
  const onLoadedData = () => {
    loadedDataSeen = true;
    evaluate();
  };
  const onReload = () => {
    loadedDataSeen = false;
    promoted = false;
  };
  el.addEventListener("loadeddata", onLoadedData);
  el.addEventListener("loadstart", onReload);
  el.addEventListener("emptied", onReload);
  for (const type of READINESS_EVENTS) {
    if (type !== "loadeddata") el.addEventListener(type, evaluate);
  }
  return () => {
    el.removeEventListener("loadeddata", onLoadedData);
    el.removeEventListener("loadstart", onReload);
    el.removeEventListener("emptied", onReload);
    for (const type of READINESS_EVENTS) {
      if (type !== "loadeddata") el.removeEventListener(type, evaluate);
    }
  };
}
