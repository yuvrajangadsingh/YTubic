import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLayoutStore } from "@/lib/store/layout";
import { useSettingsStore } from "@/lib/store/settings";
import { usePlaybackStore } from "@/lib/store/playback";

/** Shape of the Rust `perf_stats` command result. */
type PerfStats = {
  appMem: number;
  appCpu: number;
  helpers: number;
  sysCpu: number;
  memUsed: number;
  memTotal: number;
};

const POLL_MS = 2000;

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  return `${Math.round(bytes / 1024 ** 2)}MB`;
}

/**
 * Small floating readout of app + system CPU/memory, shown only while
 * the "Show performance stats" setting is on. It polls a Rust command
 * every couple seconds — and only while visible, so a disabled chip
 * costs nothing.
 *
 * Sits bottom-left, lifted above the bottom player bar when that
 * layout is active so it never overlaps the transport controls. The
 * app figure is labelled "app" when the Rust side could attribute the
 * webview helper processes, and "app (core)" when it could only see
 * this process (see `perf_stats` in the Rust side for why that
 * happens on macOS).
 */
export function PerfStatsChip() {
  const show = useSettingsStore((s) => s.showPerfStats);
  const mode = useLayoutStore((s) => s.mode);
  // The bottom bar only renders in `bottom` mode and only with a track
  // loaded — match that so the chip lifts exactly when the bar is there.
  const bottomBarVisible = usePlaybackStore(
    (s) => mode === "bottom" && s.index >= 0 && s.index < s.queue.length,
  );
  const [stats, setStats] = useState<PerfStats | null>(null);

  useEffect(() => {
    if (!show) {
      setStats(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<PerfStats>("perf_stats");
        if (alive) setStats(s);
      } catch {
        /* command unavailable (plain-vite dev) — leave last value */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [show]);

  if (!show || !stats) return null;

  const appLabel = stats.helpers > 0 ? "app" : "app (core)";

  return (
    <div
      className="pointer-events-none fixed left-3 z-30 flex flex-col gap-0.5 rounded-md border border-hairline bg-black/55 px-2 py-1 font-mono text-[11px] leading-tight text-white/85 tabular-nums shadow-sm backdrop-blur-sm"
      style={{ bottom: bottomBarVisible ? "6rem" : "0.75rem" }}
      aria-hidden
    >
      <span>
        {appLabel} {fmtBytes(stats.appMem)} {stats.appCpu.toFixed(1)}%
      </span>
      <span>
        sys {stats.sysCpu.toFixed(0)}% {fmtBytes(stats.memUsed)}/
        {fmtBytes(stats.memTotal)}
      </span>
    </div>
  );
}
