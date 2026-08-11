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
