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
 * How long a video attempt may sit with nothing happening — no bytes,
 * no readyState change, no media event — before it is called dead. One
 * fixed timer over the whole startup was the old behaviour and it timed
 * a cold 4K download and a wedged decoder with the same stopwatch.
 */
export const VIDEO_NO_PROGRESS_MS = 9_000;

/**
 * Absolute ceiling on a single attempt, however healthy the progress
 * looks. A 500MB pull can keep reporting progress for minutes; the user
 * is not waiting that long for a music video.
 */
export const VIDEO_ABSOLUTE_MS = 28_000;

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
 */
export function watchdogVerdict(s: {
  nowMs: number;
  startedAtMs: number;
  lastProgressMs: number;
  phase: VideoFailurePhase;
}): VideoFailure | null {
  const label = PHASE_LABEL[s.phase];
  if (s.nowMs - s.startedAtMs >= VIDEO_ABSOLUTE_MS) {
    return {
      phase: s.phase,
      reason: `gave up after ${Math.round(
        (s.nowMs - s.startedAtMs) / 1000,
      )}s while ${label}`,
    };
  }
  if (s.nowMs - s.lastProgressMs >= VIDEO_NO_PROGRESS_MS) {
    return {
      phase: s.phase,
      reason: `no progress for ${Math.round(
        (s.nowMs - s.lastProgressMs) / 1000,
      )}s while ${label}`,
    };
  }
  return null;
}
