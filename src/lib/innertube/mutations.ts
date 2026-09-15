import { appLog } from "@/lib/app-log";
import {
  collectContinuationItems,
  innertubePost,
  rawBrowse,
  readPagingToken,
  type YtNode,
} from "./shared";

/**
 * Mutating InnerTube actions (likes + playlist edits). All require the
 * authenticated cookie jar populated by Settings → Sign in; anonymous
 * calls succeed HTTP-wise but don't persist anywhere.
 */

/**
 * Which is why every call below is `auth: "required"`: a jar that can't
 * be read has to fail loudly here. Downgrading to anonymous would make
 * the request answer 200, write nothing, and leave an optimistic UI
 * showing an edit that never happened.
 */
const AUTHED = { auth: "required" } as const;

export type LikeStatus = "LIKE" | "DISLIKE" | "INDIFFERENT";

async function rate(
  endpoint: "like/like" | "like/dislike" | "like/removelike",
  videoId: string,
): Promise<void> {
  try {
    const resp = await innertubePost(endpoint, { target: { videoId } }, AUTHED);
    if (import.meta.env.DEV) {
      console.debug(`[mutations] ${endpoint} ${videoId} →`, resp);
    }
  } catch (e) {
    // Surface the body text from `innertubePost` (it embeds the
    // YouTube error JSON in the message) so a DevTools peek tells us
    // immediately whether it's auth, throttling, or a malformed body.
    console.error(`[mutations] ${endpoint} ${videoId} failed:`, e);
    throw e;
  }
}

export function likeTrack(videoId: string): Promise<void> {
  return rate("like/like", videoId);
}

export function dislikeTrack(videoId: string): Promise<void> {
  return rate("like/dislike", videoId);
}

/** Clear whatever rating the user has on a track (undo like OR dislike). */
export function removeRating(videoId: string): Promise<void> {
  return rate("like/removelike", videoId);
}

export type UserPlaylist = {
  id: string;
  title: string;
  thumbnailUrl?: string;
  /** Best-effort track count string ("12 songs"); YTM doesn't always
   *  expose a numeric count in the library shelf. */
  subtitle?: string;
};

/**
 * Fetch only the playlists the current user has created (not ones they
 * follow). YTM surfaces them in the "Your playlists" / "Playlists"
 * shelf of the library browse response; followed playlists appear in a
 * separate shelf. We also filter out the auto-generated pseudo-entries
 * ("New playlist", "Episodes for later", etc.) since they aren't
 * editable via `browse/edit_playlist`.
 */
export async function fetchUserPlaylists(): Promise<UserPlaylist[]> {
  // Also AUTHED: anonymous this browse returns the generic explore page,
  // which parses cleanly to zero playlists and tells the "Add to
  // playlist" picker the user has none.
  const json = await rawBrowse("FEmusic_liked_playlists", undefined, AUTHED);
  const tabs: YtNode[] =
    json?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  const sectionList: YtNode | undefined =
    tabs[0]?.tabRenderer?.content?.sectionListRenderer;
  const sections: YtNode[] = sectionList?.contents ?? [];

  const out: UserPlaylist[] = [];
  for (const section of sections) {
    const shelf =
      section?.gridRenderer ??
      section?.musicShelfRenderer ??
      section?.musicCarouselShelfRenderer;
    const firstPage: YtNode[] = shelf?.items ?? shelf?.contents ?? [];
    // The shelf is paged at ~25 rows, so an owner of 30+ playlists would
    // otherwise find the "Add to playlist" submenu missing everything past
    // the first page.
    const token =
      readPagingToken(shelf) ??
      (sections.length === 1 ? readPagingToken(sectionList) : undefined);
    const items: YtNode[] = [
      ...firstPage,
      ...(await collectContinuationItems(token, AUTHED)),
    ];
    for (const raw of items) {
      const r =
        raw?.musicTwoRowItemRenderer ??
        raw?.musicResponsiveListItemRenderer;
      if (!r) continue;
      const browseId: string | undefined =
        r.navigationEndpoint?.browseEndpoint?.browseId ??
        r.menu?.menuRenderer?.items?.[0]?.menuNavigationItemRenderer
          ?.navigationEndpoint?.browseEndpoint?.browseId;
      // Only real user playlists have browseIds that start with "VL" —
      // which wraps a "PL..." playlistId. Pseudo-entries (liked songs
      // "LM", episodes, new-playlist placeholders) either lack this or
      // are not editable by the owner.
      if (!browseId?.startsWith("VLPL")) continue;
      const playlistId = browseId.slice(2);

      const title =
        readRun(r.title) ||
        r.accessibilityText ||
        readRun(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text) ||
        "";
      if (!title) continue;

      const thumbs =
        r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
        r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
        [];
      const thumbnailUrl = thumbs[thumbs.length - 1]?.url;

      const subtitle =
        readRun(r.subtitle) ||
        readRun(
          r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text,
        );

      out.push({
        id: playlistId,
        title,
        thumbnailUrl,
        subtitle: subtitle || undefined,
      });
    }
  }
  // De-dupe on id — some responses include the same playlist in multiple
  // shelves (e.g. "Recently added" + "Your playlists").
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

function readRun(node: YtNode | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  // Some library shelves deliver the title as { simpleText } instead of
  // { runs }. Without this branch such a playlist reads as "" and is
  // silently dropped from the "Add to playlist" submenu.
  if (typeof node.simpleText === "string") return node.simpleText;
  const runs: YtNode[] = node.runs ?? [];
  return runs.map((r) => r.text ?? "").join("");
}

export type AddToPlaylistResult = "added" | "duplicate";

/**
 * YouTube runs its own duplicate check on this call: a song already in
 * the playlist is refused and nothing is added (ytmusicapi documents the
 * refusal and the dedupeOption that turns the check off; the refusal's
 * body has not been captured here yet). That case is reported as
 * "duplicate" rather than thrown; `force` turns the check off up front,
 * which is what YouTube Music's own Add anyway button does.
 */
export async function addToPlaylist(
  playlistId: string,
  videoId: string,
  opts: { force?: boolean } = {},
): Promise<AddToPlaylistResult> {
  const action: Record<string, unknown> = {
    action: "ACTION_ADD_VIDEO",
    addedVideoId: videoId,
  };
  if (opts.force) action.dedupeOption = "DEDUPE_OPTION_SKIP";
  const json = await innertubePost(
    "browse/edit_playlist",
    { playlistId, actions: [action] },
    AUTHED,
  );
  // edit_playlist returns HTTP 200 even when it rejects the edit (not the
  // owner, stale cookies, …) — surface the envelope status so the
  // optimistic "Added to <playlist>" toast doesn't lie.
  const status = json?.status as string | undefined;
  if (status === "STATUS_SUCCEEDED") return "added";
  if (isDuplicateRefusal(json, videoId)) return "duplicate";
  if (!status) return "added";
  // Any other refusal is unexpected; keep its shape for the next look.
  appLog(`edit_playlist ${status}: ${JSON.stringify(json).slice(0, 1500)}`);
  throw new Error(`edit_playlist failed: ${status}`);
}

/**
 * The duplicate refusal is recognised by its retry, not its wording: the
 * expectation is that the response carries an add of this same video with
 * dedupeOption DEDUPE_OPTION_SKIP (the dialog's Add anyway). Where that
 * sits in the tree is not pinned down, so the whole response is walked;
 * the depth cap only guards against a runaway, JSON has no cycles.
 */
export function isDuplicateRefusal(json: YtNode, videoId: string): boolean {
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 64 || !node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((n) => visit(n, depth + 1));
    const o = node as Record<string, unknown>;
    if (o.dedupeOption === "DEDUPE_OPTION_SKIP" && o.addedVideoId === videoId) {
      return true;
    }
    return Object.values(o).some((v) => visit(v, depth + 1));
  };
  return visit(json, 0);
}

/**
 * Remove one entry from a user-owned playlist. Targets the specific
 * playlist *entry* via setVideoId (playlistItemData.playlistSetVideoId
 * from the playlist browse), not just the videoId — a track added twice
 * only loses the copy that was right-clicked.
 */
export async function removeFromPlaylist(
  playlistId: string,
  videoId: string,
  setVideoId: string,
): Promise<void> {
  const json = await innertubePost(
    "browse/edit_playlist",
    {
      playlistId,
      actions: [
        {
          action: "ACTION_REMOVE_VIDEO",
          removedVideoId: videoId,
          setVideoId,
        },
      ],
    },
    AUTHED,
  );
  const status = json?.status as string | undefined;
  if (status && status !== "STATUS_SUCCEEDED") {
    throw new Error(`edit_playlist failed: ${status}`);
  }
}

/**
 * Create a brand-new private playlist containing the given track as
 * its first entry. Returns the new playlistId so callers can navigate
 * or show it in toasts.
 */
export async function createPlaylistWithTrack(
  title: string,
  videoId: string,
): Promise<string> {
  const json = await innertubePost(
    "playlist/create",
    {
      title,
      videoIds: [videoId],
      privacyStatus: "PRIVATE",
    },
    AUTHED,
  );
  const id: string | undefined =
    (json?.playlistId as string | undefined) ??
    (json?.response?.playlistId as string | undefined);
  if (!id) throw new Error("Could not read new playlistId from response");
  return id;
}
