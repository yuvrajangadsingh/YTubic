import { useEffect } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { appLog } from "@/lib/app-log";
import {
  BASE_HEADERS,
  InnerTubeHttpError,
  authHeaders,
  captureSetCookies,
  innertubePost,
} from "@/lib/innertube/shared";
import { useAccounts } from "@/lib/store/accounts";
import { useCastStore } from "@/lib/store/cast";
import { usePlaybackStore } from "@/lib/store/playback";
import { resolveStreamId, useTrackSourceStore } from "@/lib/store/track-source";

/**
 * Tells YouTube a track was listened to, so plays in this app reach the
 * account's watch history and, through it, the home feed and radio. The
 * streams come from yt-dlp, which downloads a file and reports nothing, so
 * without this only likes and playlist edits ever reached the account.
 *
 * One request per listen, the way ytmusicapi's add_history_item does it:
 * ask `player` for the track, then GET the `videostatsPlaybackUrl` it
 * hands back with a fresh client playback nonce. No watchtime intervals,
 * so YouTube learns that the track was played, not how much of it. A
 * paused watch history on the account is YouTube's to honour.
 *
 * Same limitation as the Last.fm scrobbler: a repeat-one replay keeps its
 * queue slot and is reported once.
 */

// A listen counts after this much real playback, or half of a shorter track.
const LISTEN_SECONDS = 30;

const CPN_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

export function newCpn(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (b) => CPN_ALPHABET[b & 63],
  ).join("");
}

/**
 * The playback URL with the client fields appended, or null when it is not
 * a plain https YouTube URL: the request carries the account's cookies, so
 * the host a response names is checked before anything is sent to it. A
 * fragment is refused too, it would swallow the appended fields.
 */
export function playbackPingUrl(baseUrl: unknown, cpn: string): string | null {
  if (typeof baseUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !/(^|\.)youtube\.com$/.test(url.hostname) ||
    baseUrl.includes("#")
  ) {
    return null;
  }
  return `${baseUrl}${url.search ? "&" : "?"}ver=2&c=WEB_REMIX&cpn=${cpn}`;
}

/**
 * Seconds of real playback between two position samples: how far the
 * position moved, never more than the time that took. A stall moves less
 * than the clock, so only the part that played counts. A jump the clock
 * cannot explain, forwards or backwards, is a seek and counts for nothing.
 */
export function heardBetween(moved: number, elapsed: number): number {
  return moved > 0 && moved <= elapsed + 1 ? Math.min(moved, elapsed) : 0;
}

/**
 * Calls `onListen` once, after enough real playback, and returns the
 * unsubscribe. Driven by the store's own position samples instead of a
 * timer, so the clock is only ever compared with the sample it belongs to,
 * whether those come four times a second from the local element or every
 * second or two from a cast receiver. Wall-clock time: performance.now()
 * stops while the machine sleeps and a receiver keeps playing.
 *
 * Watches the track that is current when it is called and gives up the
 * moment another one takes the slot: that update already carries the next
 * track's duration, and the effect that owns this has not cleaned up yet.
 */
export function watchListen(onListen: () => void): () => void {
  let heard = 0;
  let at = Date.now();
  const { index, queue, position: startedAt } = usePlaybackStore.getState();
  const videoId = queue[index]?.videoId;
  let position = startedAt;
  const stop = usePlaybackStore.subscribe((s, prev) => {
    if (s.index !== index || s.queue[s.index]?.videoId !== videoId) {
      stop();
      return;
    }
    if (s.position === prev.position) return;
    const now = Date.now();
    // A local seek puts the position on its pendingSeek target, and until
    // the engine applies it the old element keeps sending samples from
    // before the jump. Only the target becomes the new baseline, or the
    // seek's completion would look like playback the length of its stall.
    if (s.pendingSeek !== undefined) {
      if (s.position === s.pendingSeek) {
        at = now;
        position = s.position;
      }
      return;
    }
    // ponytail: a cast seek has no marker, so a short forward one passes
    // as playback, and after a stall it can earn up to the stall's length.
    // The receiver's position also lands before its play state, so the
    // packet that resumes a cast earns nothing. Flag seeks in the store and
    // apply a receiver packet in one update if either ever matters.
    if (s.playing) {
      heard += heardBetween(s.position - position, (now - at) / 1000);
    }
    at = now;
    position = s.position;
    const half = s.duration > 0 ? s.duration / 2 : Infinity;
    if (heard < Math.min(LISTEN_SECONDS, half)) return;
    stop();
    onListen();
  });
  return stop;
}

/**
 * `account` and `pageId` are the identity that heard the track. Never
 * throws, and never logs the url: its query is the tracking ids.
 */
export async function reportListen(
  videoId: string,
  account: string,
  pageId: string | null,
): Promise<void> {
  try {
    // The GET is the request that writes history, and it goes out as the
    // listener or not at all: the account is bound, which fails after a
    // switch or a sign-out, and a brand channel switch keeps the account
    // id, so the page id is compared as well. The player POST is bound to
    // the account and only checked for the channel just before it.
    const asListener = async () => {
      const auth = await authHeaders("required", account);
      return auth.Authorization && (auth["X-Goog-PageId"] ?? null) === pageId
        ? auth
        : null;
    };
    if (!(await asListener())) {
      appLog(`[history] ${videoId}: skipped, not signed in as the listener`);
      return;
    }
    const player = await innertubePost(
      "player",
      {
        videoId,
        playbackContext: {
          contentPlaybackContext: {
            signatureTimestamp: Math.floor(Date.now() / 86_400_000) - 1,
          },
        },
      },
      { auth: "required", forAccount: account },
    );
    const url = playbackPingUrl(
      player?.playbackTracking?.videostatsPlaybackUrl?.baseUrl,
      newCpn(),
    );
    if (!url) {
      appLog(`[history] ${videoId}: no usable playback url`);
      return;
    }
    // Read again after the POST, whose response may have rotated the
    // cookies.
    const auth = await asListener();
    if (!auth) {
      appLog(`[history] ${videoId}: skipped, not signed in as the listener`);
      return;
    }
    const res = await tauriFetch(url, {
      method: "GET",
      headers: { ...BASE_HEADERS, ...auth },
    });
    await captureSetCookies(res, account);
    appLog(`[history] ${videoId}: ${res.status} ${new URL(url).hostname}`);
  } catch (e) {
    const why =
      e instanceof InnerTubeHttpError
        ? `player http ${e.status}`
        : e instanceof Error
          ? e.name
          : "request failed";
    appLog(`[history] ${videoId} failed: ${why}`);
  }
}

/** Mounted once in AppShell, next to the Last.fm scrobbler it mirrors. */
export function useYtHistory(): void {
  const index = usePlaybackStore((s) => s.index);
  const videoId = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
  );
  // What is actually playing: the song or its video counterpart locally,
  // always the queue's own id on a cast receiver.
  const streamId = useTrackSourceStore((s) =>
    videoId ? resolveStreamId(videoId, s.byVideoId, s.preferVideo) : undefined,
  );
  const casting = useCastStore((s) => s.deviceId !== null);
  const playedId = casting ? videoId : streamId;
  // Who is listening, known before the listen counts rather than read when
  // the report goes out.
  const active = useAccounts().data?.find((a) => a.isActive);
  const account = active?.id;
  const pageId = active?.pageId ?? null;

  // Keyed on the slot as well: the same video can sit at two queue slots.
  // And on the queue's id next to the played one: a video and its song
  // counterpart share a played id, and watchListen has already given up
  // when one replaces the other in the slot. A source switch mid-track
  // starts over, the new stream earns its own 30 s, and so does a new
  // identity.
  useEffect(() => {
    if (!playedId || !account) return;
    return watchListen(() => void reportListen(playedId, account, pageId));
  }, [playedId, videoId, index, account, pageId]);
}
