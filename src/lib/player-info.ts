import { innertubePost } from "@/lib/innertube/shared";

/** Long enough for a track's loudness to be read once per play. */
const TTL_MS = 60_000;

type Entry = { at: number; response: ReturnType<typeof innertubePost> };
const cache = new Map<string, Entry>();

/**
 * The signed-in `player` response for a track, for loudness. Bound to the
 * account and kept per account and channel. The listen report does not use
 * it: a channel switch while a request is out can store one channel's
 * tracking url under the other, which is harmless for loudness only.
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
