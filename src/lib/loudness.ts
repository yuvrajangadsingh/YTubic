import { useEffect, useState } from "react";
import { appLog } from "@/lib/app-log";
import { playerInfo } from "@/lib/player-info";
import { useAccounts } from "@/lib/store/accounts";
import { useSettingsStore } from "@/lib/store/settings";

/**
 * Tracks louder than this are turned down to it. YouTube's own reference is
 * -7 LKFS, and its attenuate-only rule changed nothing on the four tracks
 * measured (-7.58 to -14.22), so this sits where those actually differ.
 */
const TARGET_LKFS = -14;
const YOUTUBE_REFERENCE_LKFS = -7;

/** Element gain from `playerConfig.audioConfig`. `loudnessDb` is the track
 *  relative to YouTube's reference. Never above 1: an element can't boost. */
export function loudnessGain(audioConfig: unknown): number {
  const c = audioConfig as
    { loudnessDb?: unknown; loudnessTargetLkfs?: unknown } | null | undefined;
  if (typeof c?.loudnessDb !== "number") return 1;
  const reference =
    typeof c.loudnessTargetLkfs === "number"
      ? c.loudnessTargetLkfs
      : YOUTUBE_REFERENCE_LKFS;
  return Math.min(1, 10 ** ((TARGET_LKFS - (c.loudnessDb + reference)) / 20));
}

/** The gain for what's playing, 1 while the setting is off. Until a new
 *  track's answer lands the previous track's gain stays in place. */
export function useLoudnessGain(videoId: string | undefined): number {
  const enabled = useSettingsStore((s) => s.normalizeVolume);
  const account = useAccounts().data?.find((a) => a.isActive)?.id;
  const [gain, setGain] = useState(1);
  useEffect(() => {
    if (!enabled || !videoId || !account) {
      setGain(1);
      return;
    }
    let stale = false;
    playerInfo(videoId, account).then(
      (player) => {
        if (stale) return;
        const config = player?.playerConfig?.audioConfig;
        const next = loudnessGain(config);
        appLog(
          `[loudness] ${videoId}: loudnessDb ${config?.loudnessDb} gain ${next.toFixed(3)}`,
        );
        setGain(next);
      },
      (e: unknown) => {
        if (stale) return;
        appLog(
          `[loudness] ${videoId} failed: ${e instanceof Error ? e.name : "request failed"}`,
        );
        setGain(1);
      },
    );
    return () => {
      stale = true;
    };
  }, [enabled, videoId, account]);
  return gain;
}
