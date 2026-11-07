/**
 * Which queue slot is playing, as the audio engine sees it: an id that stays
 * the same while the playing entry only moves (an earlier row removed or
 * moved shifts `index`), and changes when another track takes over.
 *
 * The engine reloads when this changes. Keyed on `index` alone, removing a
 * row above the playing song restarted it.
 */
export type PlayingSlot = {
  entry: unknown;
  index: number;
  videoId: string | undefined;
  id: number;
};

export function followSlot(
  prev: PlayingSlot,
  entry: unknown,
  index: number,
  videoId: string | undefined,
): PlayingSlot {
  if (entry === prev.entry && index === prev.index) return prev;
  // The same entry somewhere else (a shift), or a new entry for the same song
  // in the same slot (a queue rebuilt around it): still the same playback.
  const sameSlot =
    entry === prev.entry || (index === prev.index && videoId === prev.videoId);
  return { entry, index, videoId, id: sameSlot ? prev.id : prev.id + 1 };
}
