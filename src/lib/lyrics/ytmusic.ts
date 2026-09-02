import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { rawNext } from "@/lib/innertube/shared";
import type { Lyrics, TimedLine } from "@/lib/lyrics/types";

/**
 * YouTube Music's own lyrics, over InnerTube.
 *
 * Structurally different from the other three providers, and that is the
 * entire point: this one is keyed on the track's videoId, not on a fuzzy
 * title/artist string. It cannot return another song's words. Every
 * "wrong lyrics" report is a string-matching failure, and there is no
 * string matching here — which is also why `sources.ts` does NOT gate it on
 * the `verifiable` (artist-known) check the other three need.
 *
 * Two hops:
 *   1. `/next` with the videoId returns the watch page's tabs. One of them
 *      is Lyrics, carrying an `MPLYt...` browseId. A tab marked
 *      `unselectable` means YTM has no lyrics for this track; that is an
 *      answer, and it costs no second request to learn it.
 *   2. `/browse` with that browseId returns the lyrics themselves.
 *
 * The response *shape* of hop 2 is decided by the client context, which is
 * the non-obvious part. Every figure below comes from anonymous probes
 * (no cookies, no Authorization, no SAPISIDHASH) against the live API on
 * 2026-09-01, run from this machine. On the same browseId
 * (MPLYt_7knn4lCqvhP-1):
 *   - ANDROID_MUSIC returns 41 line-synced rows in a 613 KB response.
 *   - WEB_REMIX, which the rest of the app sends, returns 0 timed blocks and
 *     1378 characters of plain text, footed "Source: Musixmatch".
 * So hop 2 has to go out on the mobile client or every timing is lost.
 *
 * Hop 1 does NOT. Across ten tracks (five with lyrics, five without),
 * WEB_REMIX and ANDROID_MUSIC returned the identical browseId and the
 * identical `unselectable` flag, in ~20 KB against ~2.75 MB. So hop 1 goes
 * through our existing `rawNext` — byte for byte the request this app
 * already makes on this endpoint (radio.ts does the same) — and only hop 2
 * is a new, deliberately anonymous call.
 *
 * That anonymity is the point of not routing hop 2 through `innertubePost`:
 * it would attach the user's Cookie and a SAPISIDHASH to a mobile client
 * context, which is exactly the mismatch worth avoiding in an app with this
 * one's history of session trouble. The probes above all ran signed out, so
 * auth buys nothing measurable here. Do not "tidy" this into the shared
 * client.
 *
 * Coverage over the 73 tracks in this machine's own play cache: 26 have no
 * lyrics tab at all (36%), 38 return line-synced lyrics (52%), and 9 return
 * rows that carry text but no cue ranges (12%) — see `parseLyricRows`. Those
 * were anonymous probes too, so a signed-in session may do better; that is
 * untested.
 */

const YTM_API_BASE = "https://music.youtube.com/youtubei/v1";

/**
 * The client that unlocks timed lyrics. Version pinned rather than
 * floated: this is a reverse-engineered surface, and a version YTM stops
 * recognising fails loudly here rather than silently degrading to plain
 * text somewhere else.
 */
const ANDROID_MUSIC = {
  clientName: "ANDROID_MUSIC",
  clientVersion: "7.21.50",
  androidSdkVersion: 34,
  hl: "en",
  gl: "US",
};

const CLIENT_NAME_ID = "21";

/**
 * The exact header set the probe ran with. A desktop User-Agent alongside
 * a mobile client context reads oddly, but it is what was verified to
 * return timed lyrics, and verified beats plausible on an undocumented
 * API.
 */
const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-YouTube-Client-Name": CLIENT_NAME_ID,
  "X-YouTube-Client-Version": ANDROID_MUSIC.clientVersion,
  Origin: "https://music.youtube.com",
  Referer: "https://music.youtube.com/",
  Accept: "*/*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

type YtNode = Record<string, unknown>;

export async function fetchYtMusicLyrics(
  videoId: string | undefined,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  if (!videoId) return null;

  const browseId = await findLyricsBrowseId(videoId, signal);
  // No tab, or a tab YTM marked unselectable: it has nothing for this
  // track. A real answer, worth caching.
  if (!browseId) return null;
  return fetchLyricsPage(browseId, signal);
}

/**
 * `rawNext` predates React Query's signals and takes none, so the abort has
 * to be applied here. The underlying request still runs to completion — it
 * is the shared InnerTube path and not ours to restructure — but the
 * provider stops waiting on it, which is what the panel's per-provider
 * budget exists to guarantee. Without this a single stalled `/next` would
 * pin the whole panel on "Loading lyrics…" until the track changed.
 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("YouTube Music lyrics aborted");
}

/**
 * Walk the response for every value stored under `key`, at any depth.
 *
 * The literal paths into these payloads are eight or nine segments long
 * (`contents.elementRenderer.newElement.type.componentType.model.
 * timedLyricsModel.lyricsData.timedLyricsData`) and YTM reshapes them
 * without notice. A search costs microseconds on a response this size and
 * survives a renamed wrapper, which a hardcoded path does not.
 */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

async function findLyricsBrowseId(
  videoId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = (await abortable(rawNext({ videoId }), signal)) as YtNode;
  for (const tab of collect(res, "tabRenderer") as YtNode[]) {
    const endpoint = (tab?.endpoint as YtNode)?.browseEndpoint as YtNode;
    if (!endpoint) continue;
    const pageType = (
      (endpoint.browseEndpointContextSupportedConfigs as YtNode)
        ?.browseEndpointContextMusicConfig as YtNode
    )?.pageType as string;
    // Select on the page type, not on the tab's index or its title:
    // both are localisation- and layout-dependent.
    if (pageType !== "MUSIC_PAGE_TYPE_TRACK_LYRICS") continue;
    // Set when the track has no lyrics. Bail without a second request.
    if (tab.unselectable === true) return null;
    const browseId = endpoint.browseId;
    return typeof browseId === "string" && browseId ? browseId : null;
  }
  return null;
}

async function fetchLyricsPage(
  browseId: string,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  const url = `${YTM_API_BASE}/browse?prettyPrint=false`;
  // Let transport failures and bad statuses propagate: a failure to look up
  // is not evidence of absence, and React Query would cache it as one.
  const r = await tauriFetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ browseId, context: { client: ANDROID_MUSIC } }),
    signal,
  });
  if (!r.ok) throw new Error(`YouTube Music browse ${r.status}`);
  const res = (await r.json()) as YtNode;

  const rows = parseLyricRows(res);
  if (rows) return rows;

  const plain = parsePlain(res);
  if (plain) return plain;

  // "Lyrics not available" and friends: an answer, not a failure.
  return null;
}

type TimedRow = {
  lyricLine?: string;
  cueRange?: {
    startTimeMilliseconds?: string | number;
    endTimeMilliseconds?: string | number;
  };
};

/** Milliseconds arrive as JSON strings, not numbers. */
function ms(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n / 1000 : undefined;
}

function parseLyricRows(res: YtNode): Lyrics | null {
  const blocks = collect(res, "timedLyricsData") as TimedRow[][];
  const rows = blocks.find((b) => Array.isArray(b) && b.length > 0);
  if (!rows) return null;

  const lines: TimedLine[] = [];
  for (const row of rows) {
    // A trailing attribution row ("Source: Musixmatch") rides along with
    // no cueRange; without this it would land at t=0 and shadow the first
    // real line.
    const start = ms(row?.cueRange?.startTimeMilliseconds);
    if (start === undefined) continue;
    const text = (row?.lyricLine ?? "").trim();
    lines.push({
      start,
      end: ms(row?.cueRange?.endTimeMilliseconds),
      // YTM writes an interlude as a bare note; the view already draws its
      // own marker for an empty line, so don't double up.
      text: text === "♪" ? "" : text,
    });
  }
  if (lines.length > 0) {
    lines.sort((a, b) => a.start - b.start);
    return { kind: "timed", lines, source: "YouTube Music" };
  }

  // A third shape, and the reason this function is not upstream's
  // `parseTimed`: some tracks come back with a full `timedLyricsData` block
  // where every row carries a `lyricLine` and NO `cueRange` at all, and
  // nothing else in the response holds the text either. Dropping the rows
  // and looking for a description shelf finds nothing, so the track reports
  // "no lyrics" while holding complete ones. Measured on 9 of this
  // library's 73 tracks (Kinaaray / Abdul Hannan joins to 958 characters of
  // correct Urdu-Hinglish), always all-or-nothing: 0 rows with a cueRange,
  // every row with a lyricLine. Untimed text is worth more than nothing.
  const text = rows
    .map((row) => (row?.lyricLine ?? "").trim())
    .filter((t) => t && t !== "♪")
    .join("\n")
    .trim();
  if (text) return { kind: "plain", text, source: "YouTube Music" };
  return null;
}

function parsePlain(res: YtNode): Lyrics | null {
  for (const shelf of collect(
    res,
    "musicDescriptionShelfRenderer",
  ) as YtNode[]) {
    const runs = collect(shelf?.description, "runs")[0] as
      { text?: string }[] | undefined;
    const text = (runs ?? [])
      .map((r) => r?.text ?? "")
      .join("")
      .trim();
    if (text) return { kind: "plain", text, source: "YouTube Music" };
  }
  return null;
}
