const RUNGS = [2160, 1440, 1080, 720, 480, 360];

/**
 * The ladder rung a decoded frame belongs to. YouTube labels a frame by
 * the 16:9 box it fills, not by its row count: a 1.9:1 upload decodes as
 * 3840x2026 and is listed as 2160p, a vertical 1080x1920 one as 1080p.
 * Fit the longer side to a 16:9 box, then snap to the nearest rung when
 * it's within 12%. Frames well below the ladder (240p, 144p) keep their
 * real height.
 */
export function videoQualityTier(width: number, height: number): number | null {
  if (!(width > 0) || !(height > 0)) return null;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const fit = Math.max(short, (long * 9) / 16);
  const rung = RUNGS.reduce((best, r) =>
    Math.abs(r - fit) < Math.abs(best - fit) ? r : best,
  );
  return Math.abs(rung - fit) <= rung * 0.12 ? rung : Math.round(fit);
}
