import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LyricsSource } from "@/lib/lyrics/sources";

/** Tracks remembered; the oldest drop off first. */
const MAX_TRACKS = 200;

type State = {
  /** Sources the listener said had the wrong words, per videoId. Auto
   *  passes over them for that track only. */
  byVideo: Record<string, LyricsSource[]>;
  skip: (videoId: string, source: LyricsSource) => void;
  reset: (videoId: string) => void;
};

export const useLyricsSkip = create<State>()(
  persist(
    (set) => ({
      byVideo: {},
      skip: (videoId, source) =>
        set(({ byVideo }) => {
          const prev = byVideo[videoId] ?? [];
          if (prev.includes(source)) return { byVideo };
          // Re-inserted last so the cap drops the least recently touched.
          const next = { ...byVideo };
          delete next[videoId];
          next[videoId] = [...prev, source];
          const keys = Object.keys(next);
          for (const k of keys.slice(
            0,
            Math.max(0, keys.length - MAX_TRACKS),
          )) {
            delete next[k];
          }
          return { byVideo: next };
        }),
      reset: (videoId) =>
        set(({ byVideo }) => {
          const next = { ...byVideo };
          delete next[videoId];
          return { byVideo: next };
        }),
    }),
    { name: "ytm:lyrics-skip" },
  ),
);

// The floating player is another window on the same localStorage key, and
// persist does not pick up another window's writes by itself: a skip made
// there would never reach the main window's audio engine.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm:lyrics-skip") void useLyricsSkip.persist.rehydrate();
  });
}
