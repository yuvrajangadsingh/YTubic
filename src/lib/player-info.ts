import { innertubePost } from "@/lib/innertube/shared";

/** A listen report usually comes 30 s after the loudness read. A listen
 *  stretched past this by pausing just asks again. */
const TTL_MS = 60_000;

type Entry = { at: number; response: ReturnType<typeof innertubePost> };
const cache = new Map<string, Entry>();

/**
 * The signed-in `player` response for a track, shared by what needs it
 * (loudness at the start of a track, the listen report after 30 s) so a
 * listen normally costs one. Bound to the account, and kept per account and
 * brand channel: the tracking url it holds is the channel's.
 */
export function playerInfo(
  videoId: string,
  account: string,
  pageId: string | null,
) {
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.at >= TTL_MS) cache.delete(k);
  const key = `${account}:${pageId}:${videoId}`;
  const hit = cache.get(key);
  if (hit) return hit.response;
  const response = innertubePost(
    "player",
    {
      videoId,
      playbackContext: {
        contentPlaybackContext: {
          signatureTimestamp: Math.floor(now / 86_400_000) - 1,
        },
      },
    },
    { auth: "required", forAccount: account },
  );
  cache.set(key, { at: now, response });
  // A failure isn't an answer: the next caller asks again.
  response.catch(() => {
    if (cache.get(key)?.response === response) cache.delete(key);
  });
  return response;
}

export function clearPlayerInfo(): void {
  cache.clear();
}
