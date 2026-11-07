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
  /** The store still holds a stream url. Every playback transition (next,
   *  prev, goTo, a new queue, removing the playing row) clears it; an edit
   *  around the song (remove or move another row, shuffle on) doesn't. */
  loaded: boolean,
): PlayingSlot {
  if (entry === prev.entry && index === prev.index) return prev;
  // The same entry somewhere else (a shift), or a new entry for the same song
  // in the same slot (a queue rebuilt around it): still the same playback,
  // unless a transition cleared the stream (repeat-all reshuffling the same
  // entry to the front, next onto a duplicate that shares the object).
  const sameSlot =
    loaded &&
    (entry === prev.entry ||
      (index === prev.index && videoId === prev.videoId));
  return { entry, index, videoId, id: sameSlot ? prev.id : prev.id + 1 };
}
