//! Range-proxy streaming for uncached tracks.
//!
//! The legacy path (spawn_downloader in lib.rs) blocks the HTTP response
//! until yt-dlp has downloaded the ENTIRE file, because two things made
//! progressive serving impossible at the time:
//!
//!   1. the total length was unknown mid-download, and a Range response
//!      with an unknown total (`Content-Range: bytes 0-*/*`) is
//!      grammatically invalid per RFC 7233;
//!   2. m4a tracks can carry the `moov` atom at the END of the file, so
//!      the decoder's very first read is a tail range we couldn't serve
//!      until the last byte had arrived.
//!
//! This module removes both constraints by resolving the direct
//! googlevideo URL first (`yt-dlp -j`, sub-second spawn since the onedir
//! migration) and probing it with a 1-byte range request: that yields the
//! EXACT total up front and validates that plain HTTPS byte-range access
//! works. From there:
//!
//!   - a background *filler* task downloads the file sequentially into
//!     the same `<id>.part` file the legacy path uses, renaming to the
//!     final cache name on completion (identical contract, so ServeFile,
//!     cache listing and eviction all keep working);
//!   - the HTTP handler serves bounded 206 windows immediately: from the
//!     `.part` file when the requested span is already on disk, and by
//!     fetching exactly that span from googlevideo when it isn't (which
//!     is how a tail `moov` probe gets answered seconds into a download);
//!   - requests with no Range header (WebKit fetches WebM with a single
//!     plain GET and never range-requests) get a 200 with the exact
//!     Content-Length whose body tails the `.part` file as the filler
//!     writes it.
//!
//! googlevideo URLs 403 transiently: measured Aug 11 2026, re-requesting
//! the SAME URL recovered 9/9 within three attempts, while re-resolving
//! got a fresh working URL in the remaining case. The filler and the
//! passthrough fetches therefore retry the current URL a few times with
//! backoff, and the filler re-resolves once before declaring failure.
//! Errors before a response is committed fall back to the legacy
//! blocking path in the caller. Mid-body failures on an already-started
//! response (a tailing 200, a partially-sent window) cannot fall back —
//! the transfer just breaks and the media element's own error handling
//! retries the request, which re-enters the normal decision chain.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify, OnceCell};

/// Largest span served by a single 206 response. Both AVFoundation and
/// Chromium treat a shorter-than-requested (but well-formed) 206 as an
/// invitation to issue a follow-up range request, so capping the window
/// bounds per-request memory and lets each follow-up re-decide between
/// disk and passthrough as the filler advances.
pub const WINDOW: u64 = 8 * 1024 * 1024;

/// A request whose span ends no more than this far past the filler's
/// high-water mark waits for the filler instead of double-downloading
/// the span via passthrough; a farther seek goes straight to
/// passthrough so seeking stays snappy.
const NEAR_GAP: u64 = 16 * 1024 * 1024;

/// How long a request may wait on filler progress (or a rangeless body
/// may wait for the next chunk) before giving up. The filler's own
/// per-chunk timeout is shorter, so a healthy-but-slow download keeps
/// resetting this.
const WAIT_BUDGET: Duration = Duration::from_secs(20);

/// Same floor as the legacy path: yt-dlp/YouTube can hand out a
/// storyboard-only stub; never treat something this small as a track.
const MIN_TOTAL: u64 = 32 * 1024;

/// Retry schedule for a 403/network error on the current signed URL.
const URL_RETRIES: u32 = 3;

/// Filler download chunk: one ranged request per chunk (see fill()).
const FILL_CHUNK: u64 = 10 * 1024 * 1024;

/// serve_span stops waiting for the filler and fetches its window
/// directly when the fill mark hasn't moved for this long.
const STALL: Duration = Duration::from_secs(2);

/// UA sent to googlevideo. Anonymous ranged playback from the resolving
/// IP is what YouTube itself relies on for <video> tags; a mainstream
/// browser UA keeps us inside that well-trodden path.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/// Everything the filler needs to re-resolve a fresh signed URL when
/// the current one dies mid-download.
#[derive(Clone)]
pub struct ResolveCtx {
    pub ytdlp_program: PathBuf,
    pub video_id: String,
    pub format: String,
    /// True for muxed/video-only variants — switches the mime top level.
    pub video: bool,
    /// Netscape cookie file for the signed-in user, when there is one.
    /// Without it the resolve runs anonymously, which caps audio at itag
    /// 140 (130k) and refuses Premium-only tracks outright — the exact
    /// state 0.4.2 shipped to fix. Applies to the mid-download
    /// re-resolve too: a refreshed URL for a 774/141 stream can only be
    /// minted by an authenticated extraction.
    pub cookies: Option<PathBuf>,
}

/// Shared state of one in-flight proxied download.
pub struct ProxyState {
    /// Current signed googlevideo URL. The filler refreshes it after a
    /// re-resolve; passthrough fetches always read the latest.
    pub url: Mutex<String>,
    /// Exact file size, learned from the 1-byte probe.
    pub total: u64,
    pub mime: String,
    /// yt-dlp format_id of the FIRST extraction. A mid-download
    /// re-resolve pins -f to this exact format so a selector fallback
    /// can't splice a different representation onto the written prefix.
    pub format_id: Option<String>,
    /// Bytes contiguously written to the .part file from offset 0.
    pub filled: AtomicU64,
    /// Final file renamed into place; `filled == total`.
    pub complete: AtomicBool,
    /// Filler gave up (retries and re-resolve exhausted).
    pub failed: AtomicBool,
    /// Fires on every filler write, on completion and on failure.
    pub notify: Notify,
}

impl ProxyState {
    fn new(url: String, total: u64, mime: String, format_id: Option<String>) -> Self {
        ProxyState {
            url: Mutex::new(url),
            total,
            mime,
            format_id,
            filled: AtomicU64::new(0),
            complete: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
}

/// Resolve + probe + sanity floor: everything that must succeed before
/// a filler can start. Returns the ready-to-serve shared state.
pub async fn prepare(
    client: &reqwest::Client,
    ctx: &ResolveCtx,
) -> Result<Arc<ProxyState>, String> {
    let resolved = resolve(ctx).await?;
    let total = probe_total(client, &resolved.url).await?;
    if total < MIN_TOTAL {
        return Err(format!("suspiciously small stream ({total} bytes)"));
    }
    Ok(Arc::new(ProxyState::new(
        resolved.url,
        total,
        resolved.mime,
        resolved.format_id,
    )))
}

/// Map of in-flight proxy downloads, keyed like the legacy downloads
/// map. The OnceCell gives per-key single-flight on the (slow) resolve
/// + probe: concurrent requests for the same key await one init, and a
/// failed init leaves the cell empty so a later request may retry.
pub type ProxyMap = Arc<Mutex<HashMap<String, Arc<OnceCell<Arc<ProxyState>>>>>>;

pub fn new_proxy_map() -> ProxyMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn new_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(UA)
        .build()
        .expect("reqwest client")
}

// ---------------------------------------------------------------------
// Resolve + probe
// ---------------------------------------------------------------------

struct Resolved {
    url: String,
    mime: String,
    format_id: Option<String>,
}

/// Direct-URL resolution via `yt-dlp -j -f <format>`.
///
/// Authenticated first, then one anonymous retry when YouTube answers the
/// signed-in identity with NO formats. That is what "Requested format is
/// not available" means here: the selector ends in bare `bestaudio`, which
/// matches anything with audio, so it only fails when the extraction came
/// back with storyboards alone. Measured 2026-08-28 15:06-15:13: two public,
/// unrestricted videos returned nothing to the authenticated session for
/// seven minutes and 27 formats each ten minutes later. The old warning that
/// authenticated yt-dlp gets stripped to storyboards was not stale after
/// all, just intermittent. Anonymous is what shipped before 0.4.2 (130k,
/// no Premium tracks) - a downgrade, not a failure - so it is the right
/// floor to fall to for one track rather than a 502.
async fn resolve(ctx: &ResolveCtx) -> Result<Resolved, String> {
    match resolve_with(ctx, ctx.cookies.as_deref()).await {
        Ok(r) => Ok(r),
        Err(e) if ctx.cookies.is_some() && e.contains("Requested format is not available") => {
            eprintln!(
                "[proxy] {}: authenticated extraction returned no formats; retrying anonymously",
                ctx.video_id
            );
            resolve_with(ctx, None).await
        }
        Err(e) => Err(e),
    }
}

async fn resolve_with(ctx: &ResolveCtx, cookies: Option<&Path>) -> Result<Resolved, String> {
    let url = format!("https://www.youtube.com/watch?v={}", ctx.video_id);
    let mut cmd = tokio::process::Command::new(&ctx.ytdlp_program);
    cmd.args([
        "-j",
        "-f",
        &ctx.format,
        "--no-playlist",
        "--no-warnings",
    ]);
    if let Some(path) = cookies {
        cmd.arg("--cookies").arg(path);
    }
    cmd.arg(&url);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.stdin(Stdio::null());
    // The wrapping timeout (and a skipped track abandoning this future)
    // drops the child future — without kill_on_drop that leaks a live
    // yt-dlp process per abandonment.
    cmd.kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "yt-dlp -j timed out after 30s".to_string())?
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "yt-dlp -j exit {}: {}",
            out.status,
            stderr.chars().take(300).collect::<String>()
        ));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("yt-dlp -j parse: {e}"))?;
    // Single-format selections put url/ext/codec at the root; multi-format
    // ones nest under requested_formats. Our selectors never merge tracks,
    // but handle both shapes anyway.
    let fmt = if json.get("url").and_then(|v| v.as_str()).is_some() {
        &json
    } else {
        json.get("requested_formats")
            .and_then(|v| v.get(0))
            .ok_or("yt-dlp -j: no url and no requested_formats")?
    };
    let direct = fmt
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("yt-dlp -j: no stream url")?
        .to_string();
    if !direct.starts_with("https://") {
        return Err(format!("unexpected stream url scheme: {}", &direct[..direct.len().min(40)]));
    }
    let ext = fmt.get("ext").and_then(|v| v.as_str()).unwrap_or("");
    let acodec = fmt.get("acodec").and_then(|v| v.as_str()).unwrap_or("");
    let vcodec = fmt.get("vcodec").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Resolved {
        url: direct,
        mime: mime_for(ext, acodec, vcodec, ctx.video).to_string(),
        format_id: fmt
            .get("format_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Mirror of `sniff_stream_mime`'s mapping, driven by yt-dlp metadata
/// instead of magic bytes (the file doesn't exist yet).
fn mime_for(ext: &str, acodec: &str, vcodec: &str, video: bool) -> &'static str {
    let mp4ish = ext == "m4a" || ext == "mp4" || acodec.starts_with("mp4a") || vcodec.starts_with("avc1");
    let webmish = ext == "webm" || acodec == "opus" || vcodec.starts_with("vp") || vcodec.starts_with("av01");
    if video {
        if webmish && !mp4ish { "video/webm" } else { "video/mp4" }
    } else if mp4ish {
        "audio/mp4"
    } else if webmish {
        "audio/webm"
    } else {
        "audio/webm"
    }
}

/// 1-byte range probe: learns the exact total size and proves the URL
/// serves ranged requests to a plain HTTPS client. Retries transient
/// 403s on the same URL (measured: 9/9 recover within 3 attempts).
async fn probe_total(client: &reqwest::Client, url: &str) -> Result<u64, String> {
    let mut last = String::new();
    for attempt in 0..URL_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
        }
        let resp = match tokio::time::timeout(
            Duration::from_secs(10),
            client.get(url).header(reqwest::header::RANGE, "bytes=0-0").send(),
        )
        .await
        {
            Err(_) => {
                last = "probe timeout".into();
                continue;
            }
            Ok(Err(e)) => {
                last = format!("probe: {e}");
                continue;
            }
            Ok(Ok(r)) => r,
        };
        match resp.status().as_u16() {
            206 => {
                let cr = resp
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                // Require exactly the span we asked for and a concrete
                // total — a mislabeled or unsatisfied range here would
                // poison every offset downstream.
                match parse_content_range(cr) {
                    Some((0, 0, Some(total))) => return Ok(total),
                    _ => return Err(format!("bad probe Content-Range {cr:?}")),
                }
            }
            // 200 means the server ignored Range. The whole serving
            // model needs ranged access (tail probes, passthrough
            // windows), so this URL is unusable — legacy path instead.
            200 => return Err("origin ignores Range requests".into()),
            s => {
                last = format!("probe HTTP {s}");
                continue;
            }
        }
    }
    Err(last)
}

/// Parse `bytes S-E/T` into (S, E, T). Returns None for any other
/// shape, including `bytes */T` — an unsatisfied-range form that must
/// never be combined with cached data (RFC 9110 §14.4). T is None for
/// `bytes S-E/*`.
fn parse_content_range(v: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = v.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse::<u64>().ok()?),
    };
    let (s, e) = range.trim().split_once('-')?;
    let s: u64 = s.trim().parse().ok()?;
    let e: u64 = e.trim().parse().ok()?;
    if e < s {
        return None;
    }
    Some((s, e, total))
}

// ---------------------------------------------------------------------
// Filler
// ---------------------------------------------------------------------

/// Downloads the whole file sequentially into `part_path`, renaming to
/// `final_path` when the byte count matches `state.total` exactly. On
/// exit (success or failure) removes this key from both maps and flips
/// the legacy DownloadState so blocked legacy waiters wake up.
#[allow(clippy::too_many_arguments)]
pub fn spawn_filler(
    client: reqwest::Client,
    ctx: ResolveCtx,
    state: Arc<ProxyState>,
    part_path: PathBuf,
    final_path: PathBuf,
    proxies: ProxyMap,
    map_key: String,
    legacy_complete: Arc<AtomicBool>,
    legacy_notify: Arc<Notify>,
    on_exit: impl FnOnce() + Send + 'static,
) {
    tokio::spawn(async move {
        let ok = fill(&client, &ctx, &state, &part_path, &final_path).await;
        if ok {
            state.complete.store(true, Ordering::Release);
        } else {
            state.failed.store(true, Ordering::Release);
            let _ = tokio::fs::remove_file(&part_path).await;
            eprintln!("[proxy] {}: filler FAILED", ctx.video_id);
        }
        state.notify.notify_waiters();
        // Wake anything blocked on the legacy DownloadState for this key
        // (requests that fell back while we were running, prefetchers).
        legacy_complete.store(true, Ordering::Release);
        legacy_notify.notify_waiters();
        proxies.lock().await.remove(&map_key);
        on_exit();
    });
}

async fn fill(
    client: &reqwest::Client,
    ctx: &ResolveCtx,
    state: &ProxyState,
    part_path: &Path,
    final_path: &Path,
) -> bool {
    if let Some(dir) = part_path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    // Truncate any stale .part from a previous run — it may have been
    // produced by a different format/URL and offsets wouldn't line up.
    let mut file = match tokio::fs::File::create(part_path).await {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[proxy] create {part_path:?}: {e}");
            return false;
        }
    };
    let t0 = std::time::Instant::now();
    let total = state.total;
    let mut pos: u64 = 0;
    let mut url_retries_left = URL_RETRIES;
    let mut reresolves_left = 1u32;

    // Download in bounded chunks, one ranged request each, instead of a
    // single `bytes=pos-` connection: googlevideo gives every fresh
    // range request a full-speed burst but throttles a long-lived
    // connection down to roughly playback rate once it's a few MB in
    // (observed live: a 14.5MB 4K WebM stalled at 10.3MB for minutes on
    // the open-ended form while a 5MB audio file finished in 0.33s).
    // Chunking is the same trick yt-dlp's downloader uses.
    //
    // EVERY way an attempt can fall short — bad status, mislabeled
    // Content-Range, body error, stall, or a clean-but-early EOF —
    // lands in the same ladder: burn a same-URL retry, then one
    // identity-checked re-resolve, then fail. A clean early EOF MUST
    // consume budget too, or a server that keeps closing at the same
    // byte turns the filler into an infinite reconnect loop that owns
    // the .part forever. Only a fully delivered chunk refills the
    // budget.
    'outer: while pos < total {
        let chunk_end = pos.saturating_add(FILL_CHUNK).min(total) - 1;
        let url = state.url.lock().await.clone();
        let mut why: Option<String> = None;

        let sent = tokio::time::timeout(
            Duration::from_secs(15),
            client
                .get(&url)
                .header(reqwest::header::RANGE, format!("bytes={pos}-{chunk_end}"))
                .send(),
        )
        .await;
        match sent {
            Ok(Ok(mut resp)) if resp.status().as_u16() == 206 => {
                let cr = resp
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                match parse_content_range(&cr) {
                    Some((s, _e, t)) if s == pos && t.map_or(true, |t| t == total) => {
                        // Header checks out — drain the body into the file.
                        loop {
                            match tokio::time::timeout(Duration::from_secs(30), resp.chunk()).await
                            {
                                Err(_) => {
                                    why = Some(format!("body stalled at {pos}"));
                                    break;
                                }
                                Ok(Err(e)) => {
                                    why = Some(format!("body error at {pos}: {e}"));
                                    break;
                                }
                                Ok(Ok(None)) => {
                                    if pos <= chunk_end {
                                        why = Some(format!(
                                            "early EOF at {pos} (chunk end {chunk_end})"
                                        ));
                                    }
                                    break;
                                }
                                Ok(Ok(Some(chunk))) => {
                                    // Never write past the requested chunk
                                    // end: surplus bytes would corrupt the
                                    // offset math for readers.
                                    let take =
                                        chunk.len().min((chunk_end + 1 - pos) as usize);
                                    if let Err(e) = file.write_all(&chunk[..take]).await {
                                        eprintln!(
                                            "[proxy] {} write .part: {e}",
                                            ctx.video_id
                                        );
                                        return false;
                                    }
                                    pos += take as u64;
                                    state.filled.store(pos, Ordering::Release);
                                    state.notify.notify_waiters();
                                    if pos > chunk_end {
                                        url_retries_left = URL_RETRIES;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    _ => why = Some(format!("bad Content-Range {cr:?} for offset {pos}")),
                }
            }
            Ok(Ok(r)) => why = Some(format!("HTTP {}", r.status())),
            Ok(Err(e)) => why = Some(format!("{e}")),
            Err(_) => why = Some("connect timeout".into()),
        }

        let Some(why) = why else { continue 'outer };
        if url_retries_left > 0 {
            url_retries_left -= 1;
            eprintln!("[proxy] {} fill: {why}; retrying same url", ctx.video_id);
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue 'outer;
        }
        if reresolves_left > 0 {
            reresolves_left -= 1;
            url_retries_left = URL_RETRIES;
            eprintln!("[proxy] {} fill: {why}; re-resolving url", ctx.video_id);
            // Pin the exact format of the first extraction: the selector
            // has fallbacks, and splicing a different representation onto
            // the written prefix would cache a corrupt file. The probe
            // must agree on the byte count for the same reason.
            let pinned = ResolveCtx {
                format: state
                    .format_id
                    .clone()
                    .unwrap_or_else(|| ctx.format.clone()),
                ..ctx.clone()
            };
            match resolve(&pinned).await {
                Ok(fresh) => match probe_total(client, &fresh.url).await {
                    Ok(t2) if t2 == total => {
                        *state.url.lock().await = fresh.url;
                        continue 'outer;
                    }
                    Ok(t2) => {
                        eprintln!(
                            "[proxy] {} re-resolve changed size ({t2} vs {total}); aborting",
                            ctx.video_id
                        );
                        return false;
                    }
                    Err(e) => {
                        eprintln!("[proxy] {} re-resolve probe failed: {e}", ctx.video_id);
                        return false;
                    }
                },
                Err(e) => {
                    eprintln!("[proxy] {} re-resolve failed: {e}", ctx.video_id);
                    return false;
                }
            }
        }
        eprintln!("[proxy] {} fill: {why}; giving up", ctx.video_id);
        return false;
    }

    if let Err(e) = file.flush().await {
        eprintln!("[proxy] {} flush: {e}", ctx.video_id);
        return false;
    }
    drop(file);
    let on_disk = tokio::fs::metadata(part_path).await.map(|m| m.len()).unwrap_or(0);
    if on_disk != total {
        eprintln!(
            "[proxy] {} size mismatch: {on_disk} on disk vs {total} probed",
            ctx.video_id
        );
        return false;
    }
    if let Err(e) = tokio::fs::rename(part_path, final_path).await {
        eprintln!("[proxy] {} rename: {e}", ctx.video_id);
        return false;
    }
    eprintln!(
        "[proxy] cached {} ({total} bytes in {:.2}s)",
        ctx.video_id,
        t0.elapsed().as_secs_f32()
    );
    true
}

// ---------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------

/// One parsed request span. `end` is inclusive.
#[derive(Debug, PartialEq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

/// Parse a Range header against a known total. Returns Ok(None) for an
/// absent/unusable header (serve 200), Ok(Some) for a satisfiable span
/// (serve 206), Err(()) for an unsatisfiable one (serve 416). Multi-range
/// requests use the first span only — neither AVFoundation nor Chromium
/// sends them; answering with a single 206 span is spec-conformant
/// behavior for a server that doesn't do multipart.
pub fn parse_range(header: Option<&str>, total: u64) -> Result<Option<Span>, ()> {
    let Some(h) = header else { return Ok(None) };
    let Some(spec) = h.trim().strip_prefix("bytes=") else {
        return Ok(None);
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    if first.is_empty() {
        return Ok(None);
    }
    if let Some(suffix) = first.strip_prefix('-') {
        // bytes=-N : final N bytes
        let n: u64 = suffix.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        let start = total.saturating_sub(n);
        return Ok(Some(Span { start, end: total - 1 }));
    }
    // RFC 9110 grammar requires the hyphen ("500-", "0-99", "-100");
    // a bare "bytes=500" is malformed, and a malformed Range header is
    // ignored (serve 200), not answered with 416.
    let Some((start_part, end_part)) = first.split_once('-') else {
        return Ok(None);
    };
    let start: u64 = start_part.trim().parse().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }
    let end_part = end_part.trim();
    let end = if end_part.is_empty() {
        total - 1
    } else {
        end_part.parse::<u64>().map_err(|_| ())?.min(total - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some(Span { start, end }))
}

/// Clamp a span to the serving window. Saturating: HTTP range numerals
/// can legally be enormous and must not overflow (RFC 9110 §14.1.1).
pub fn window_span(s: &Span) -> Span {
    Span {
        start: s.start,
        end: s.end.min(s.start.saturating_add(WINDOW - 1)),
    }
}

/// Read `[start, start+len)` from the .part file (or the final file if
/// the rename has already happened — the two never coexist).
async fn read_span(
    part_path: &Path,
    final_path: &Path,
    start: u64,
    len: usize,
) -> std::io::Result<Vec<u8>> {
    let mut f = match tokio::fs::File::open(part_path).await {
        Ok(f) => f,
        Err(_) => tokio::fs::File::open(final_path).await?,
    };
    f.seek(SeekFrom::Start(start)).await?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Fetch exactly `[start, end]` from the current signed URL, with the
/// same-URL retry that recovers transient 403s. Bounded by WINDOW so the
/// whole span fits in memory.
async fn fetch_span(
    client: &reqwest::Client,
    state: &ProxyState,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    let want = (end - start + 1) as usize;
    let mut last = String::new();
    for attempt in 0..=URL_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
        }
        let url = state.url.lock().await.clone();
        let resp = match tokio::time::timeout(
            Duration::from_secs(15),
            client
                .get(&url)
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .send(),
        )
        .await
        {
            Err(_) => {
                last = "connect timeout".into();
                continue;
            }
            Ok(Err(e)) => {
                last = format!("{e}");
                continue;
            }
            Ok(Ok(r)) => r,
        };
        if resp.status().as_u16() != 206 {
            last = format!("HTTP {}", resp.status());
            continue;
        }
        // A 206 whose Content-Range names a different offset would hand
        // the caller mislabeled bytes — validate before reading. A
        // server MAY legally answer with a shorter span than requested;
        // deliver exactly what it declared and let the caller label the
        // response from the actual byte count.
        let cr = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let promised = match parse_content_range(&cr) {
            Some((s, e2, t))
                if s == start && e2 <= end && t.map_or(true, |t| t == state.total) =>
            {
                (e2 - start + 1) as usize
            }
            _ => {
                last = format!("bad Content-Range {cr:?}");
                continue;
            }
        };
        let mut buf = Vec::with_capacity(promised.min(want));
        let mut resp = resp;
        let mut ok = true;
        while buf.len() < promised {
            match tokio::time::timeout(Duration::from_secs(30), resp.chunk()).await {
                Ok(Ok(Some(c))) => {
                    let take = c.len().min(promised - buf.len());
                    buf.extend_from_slice(&c[..take]);
                }
                Ok(Ok(None)) => break,
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && buf.len() == promised {
            return Ok(buf);
        }
        last = format!("short body {}/{promised}", buf.len());
    }
    Err(last)
}

/// Serve one ranged request against an in-flight download. Returns the
/// bytes for the effective span, waiting briefly for the filler when the
/// span is just past the high-water mark (cheaper than fetching the same
/// bytes twice), passing through to googlevideo for far seeks and tail
/// probes.
pub async fn serve_span(
    client: &reqwest::Client,
    state: &ProxyState,
    part_path: &Path,
    final_path: &Path,
    span: &Span,
) -> Result<Vec<u8>, String> {
    let len = (span.end - span.start + 1) as usize;
    let deadline = tokio::time::Instant::now() + WAIT_BUDGET;
    let mut last_filled = state.filled.load(Ordering::Acquire);
    let mut last_progress = tokio::time::Instant::now();
    loop {
        let filled = state.filled.load(Ordering::Acquire);
        let done = state.complete.load(Ordering::Acquire);
        if done || span.end < filled {
            return read_span(part_path, final_path, span.start, len)
                .await
                .map_err(|e| format!("disk read: {e}"));
        }
        if state.failed.load(Ordering::Acquire) {
            return Err("download failed".into());
        }
        if filled > last_filled {
            last_filled = filled;
            last_progress = tokio::time::Instant::now();
        }
        let gap = span.end.saturating_sub(filled);
        // Fetch the window ourselves for a far seek, a filler that has
        // stopped moving (throttled/stuck), or when we've waited long
        // enough — a fresh bounded range request gets burst speed.
        if gap > NEAR_GAP
            || last_progress.elapsed() > STALL
            || tokio::time::Instant::now() >= deadline
        {
            match fetch_span(client, state, span.start, span.end).await {
                Ok(b) => return Ok(b),
                Err(e) => {
                    // The filler may have finished while the passthrough
                    // was failing — the file is then authoritative.
                    if state.complete.load(Ordering::Acquire) {
                        return read_span(part_path, final_path, span.start, len)
                            .await
                            .map_err(|e2| format!("disk read after passthrough: {e2}"));
                    }
                    return Err(e);
                }
            }
        }
        let notified = state.notify.notified();
        tokio::pin!(notified);
        let _ = tokio::time::timeout(Duration::from_millis(500), notified).await;
    }
}

/// Body producer for a rangeless 200: stream the whole file in order,
/// tailing the .part file as the filler writes it. Sends chunks into an
/// mpsc whose receiver backs the hyper Body; an error mid-stream drops
/// the sender, truncating the response so the client sees a broken
/// transfer instead of a silently short "complete" one.
pub fn spawn_tail_pump(
    state: Arc<ProxyState>,
    part_path: PathBuf,
    final_path: PathBuf,
) -> mpsc::Receiver<Result<Vec<u8>, std::io::Error>> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, std::io::Error>>(4);
    tokio::spawn(async move {
        const CHUNK: u64 = 512 * 1024;
        let total = state.total;
        let mut sent: u64 = 0;
        let mut idle = tokio::time::Instant::now();
        while sent < total {
            let filled = state.filled.load(Ordering::Acquire);
            let done = state.complete.load(Ordering::Acquire);
            let avail = if done { total } else { filled };
            if sent < avail {
                let len = (avail - sent).min(CHUNK) as usize;
                match read_span(&part_path, &final_path, sent, len).await {
                    Ok(buf) => {
                        sent += buf.len() as u64;
                        if tx.send(Ok(buf)).await.is_err() {
                            return; // client went away
                        }
                        idle = tokio::time::Instant::now();
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                }
                continue;
            }
            if state.failed.load(Ordering::Acquire) {
                let _ = tx
                    .send(Err(std::io::Error::other("download failed")))
                    .await;
                return;
            }
            if idle.elapsed() > WAIT_BUDGET {
                let _ = tx.send(Err(std::io::Error::other("stalled"))).await;
                return;
            }
            let notified = state.notify.notified();
            tokio::pin!(notified);
            let _ = tokio::time::timeout(Duration::from_secs(2), notified).await;
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_absent() {
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(Some("chunks=0-1"), 100), Ok(None));
    }

    #[test]
    fn range_normal() {
        assert_eq!(
            parse_range(Some("bytes=0-99"), 1000),
            Ok(Some(Span { start: 0, end: 99 }))
        );
        // end clamped to total
        assert_eq!(
            parse_range(Some("bytes=0-4999"), 1000),
            Ok(Some(Span { start: 0, end: 999 }))
        );
    }

    #[test]
    fn range_open_ended() {
        assert_eq!(
            parse_range(Some("bytes=500-"), 1000),
            Ok(Some(Span { start: 500, end: 999 }))
        );
    }

    #[test]
    fn range_suffix() {
        assert_eq!(
            parse_range(Some("bytes=-100"), 1000),
            Ok(Some(Span { start: 900, end: 999 }))
        );
        // suffix larger than file = whole file
        assert_eq!(
            parse_range(Some("bytes=-5000"), 1000),
            Ok(Some(Span { start: 0, end: 999 }))
        );
    }

    #[test]
    fn range_unsatisfiable() {
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), Err(()));
        assert_eq!(parse_range(Some("bytes=5-2"), 1000), Err(()));
        assert_eq!(parse_range(Some("bytes=-0"), 1000), Err(()));
    }

    #[test]
    fn range_multi_takes_first() {
        assert_eq!(
            parse_range(Some("bytes=0-1,500-"), 1000),
            Ok(Some(Span { start: 0, end: 1 }))
        );
    }

    #[test]
    fn range_missing_hyphen_is_ignored() {
        // Malformed per RFC 9110 grammar — ignore the header, don't 416.
        assert_eq!(parse_range(Some("bytes=500"), 1000), Ok(None));
    }

    #[test]
    fn window_caps() {
        let s = window_span(&Span { start: 0, end: 100 * 1024 * 1024 });
        assert_eq!(s.end, WINDOW - 1);
        let s = window_span(&Span { start: 10, end: 20 });
        assert_eq!(s, Span { start: 10, end: 20 });
    }

    #[test]
    fn content_range_parsing() {
        assert_eq!(
            parse_content_range("bytes 0-0/12345"),
            Some((0, 0, Some(12345)))
        );
        assert_eq!(
            parse_content_range("bytes 100-199/5000"),
            Some((100, 199, Some(5000)))
        );
        assert_eq!(parse_content_range("bytes 5-9/*"), Some((5, 9, None)));
        // Unsatisfied-range form must never be treated as data.
        assert_eq!(parse_content_range("bytes */999"), None);
        assert_eq!(parse_content_range("bytes 9-5/100"), None);
        assert_eq!(parse_content_range("chunks 0-0/1"), None);
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_for("m4a", "mp4a.40.2", "none", false), "audio/mp4");
        assert_eq!(mime_for("webm", "opus", "none", false), "audio/webm");
        assert_eq!(mime_for("mp4", "none", "avc1.64002a", true), "video/mp4");
        assert_eq!(mime_for("webm", "none", "vp9", true), "video/webm");
        assert_eq!(mime_for("", "", "", false), "audio/webm");
    }
}
