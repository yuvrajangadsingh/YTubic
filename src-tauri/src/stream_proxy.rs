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
//! Every error in this module falls back to the legacy blocking path in
//! the caller, so the worst case is exactly today's behavior.

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
}

/// Shared state of one in-flight proxied download.
pub struct ProxyState {
    /// Current signed googlevideo URL. The filler refreshes it after a
    /// re-resolve; passthrough fetches always read the latest.
    pub url: Mutex<String>,
    /// Exact file size, learned from the 1-byte probe.
    pub total: u64,
    pub mime: String,
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
    fn new(url: String, total: u64, mime: String) -> Self {
        ProxyState {
            url: Mutex::new(url),
            total,
            mime,
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
    let (url, mime) = resolve(ctx).await?;
    let total = probe_total(client, &url).await?;
    if total < MIN_TOTAL {
        return Err(format!("suspiciously small stream ({total} bytes)"));
    }
    Ok(Arc::new(ProxyState::new(url, total, mime)))
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

/// Direct-URL resolution via `yt-dlp -j -f <format>`.
async fn resolve(ctx: &ResolveCtx) -> Result<(String, String), String> {
    let url = format!("https://www.youtube.com/watch?v={}", ctx.video_id);
    let mut cmd = tokio::process::Command::new(&ctx.ytdlp_program);
    cmd.args([
        "-j",
        "-f",
        &ctx.format,
        "--no-playlist",
        "--no-warnings",
        &url,
    ]);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.stdin(Stdio::null());
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
    Ok((direct, mime_for(ext, acodec, vcodec, ctx.video).to_string()))
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
                match parse_content_range_total(cr) {
                    Some(total) => return Ok(total),
                    None => return Err(format!("unparseable Content-Range {cr:?}")),
                }
            }
            // A server that ignores Range answers 200 with the full length.
            200 => {
                if let Some(len) = resp.content_length() {
                    return Ok(len);
                }
                return Err("probe 200 without Content-Length".into());
            }
            s => {
                last = format!("probe HTTP {s}");
                continue;
            }
        }
    }
    Err(last)
}

/// `bytes 0-0/12345` → 12345
fn parse_content_range_total(v: &str) -> Option<u64> {
    v.rsplit('/').next()?.trim().parse::<u64>().ok()
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
    'outer: while pos < total {
        let chunk_end = (pos + FILL_CHUNK).min(total) - 1;
        let url = state.url.lock().await.clone();
        let resp = tokio::time::timeout(
            Duration::from_secs(15),
            client
                .get(&url)
                .header(reqwest::header::RANGE, format!("bytes={pos}-{chunk_end}"))
                .send(),
        )
        .await;
        let mut resp = match resp {
            Ok(Ok(r)) if r.status().as_u16() == 206 || (r.status().as_u16() == 200 && pos == 0 && chunk_end == total - 1) => r,
            other => {
                let why = match other {
                    Ok(Ok(r)) => format!("HTTP {}", r.status()),
                    Ok(Err(e)) => format!("{e}"),
                    Err(_) => "connect timeout".into(),
                };
                if url_retries_left > 0 {
                    url_retries_left -= 1;
                    eprintln!("[proxy] {} fill@{pos}: {why}; retrying same url", ctx.video_id);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue 'outer;
                }
                if reresolves_left > 0 {
                    reresolves_left -= 1;
                    url_retries_left = URL_RETRIES;
                    eprintln!("[proxy] {} fill@{pos}: {why}; re-resolving url", ctx.video_id);
                    match resolve(ctx).await {
                        Ok((fresh, _mime)) => {
                            *state.url.lock().await = fresh;
                            continue 'outer;
                        }
                        Err(e) => {
                            eprintln!("[proxy] {} re-resolve failed: {e}", ctx.video_id);
                            return false;
                        }
                    }
                }
                eprintln!("[proxy] {} fill@{pos}: {why}; giving up", ctx.video_id);
                return false;
            }
        };
        loop {
            match tokio::time::timeout(Duration::from_secs(30), resp.chunk()).await {
                Err(_) | Ok(Err(_)) => {
                    // Stalled or errored mid-body: reconnect from current
                    // offset via the retry ladder above.
                    if url_retries_left == 0 && reresolves_left == 0 {
                        eprintln!("[proxy] {} fill@{pos}: body stalled; giving up", ctx.video_id);
                        return false;
                    }
                    url_retries_left = url_retries_left.saturating_sub(1);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue 'outer;
                }
                Ok(Ok(None)) => {
                    // Body ended: at the chunk boundary this is normal —
                    // the outer loop requests the next chunk; short of it
                    // the outer loop resumes from pos either way.
                    continue 'outer;
                }
                Ok(Ok(Some(chunk))) => {
                    // Never write past the requested chunk end: a surplus
                    // body would corrupt the offset math for readers.
                    let take = chunk.len().min((chunk_end + 1 - pos) as usize);
                    if let Err(e) = file.write_all(&chunk[..take]).await {
                        eprintln!("[proxy] {} write .part: {e}", ctx.video_id);
                        return false;
                    }
                    pos += take as u64;
                    state.filled.store(pos, Ordering::Release);
                    state.notify.notify_waiters();
                    if pos > chunk_end {
                        // Chunk done: refill the retry budget so long
                        // files don't exhaust it on scattered blips.
                        url_retries_left = URL_RETRIES;
                        continue 'outer;
                    }
                }
            }
        }
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
    let mut it = first.splitn(2, '-');
    let start: u64 = it.next().unwrap_or("").parse().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }
    let end_part = it.next().unwrap_or("").trim();
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

/// Clamp a span to the serving window.
pub fn window_span(s: &Span) -> Span {
    Span {
        start: s.start,
        end: s.end.min(s.start + WINDOW - 1),
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
        let mut buf = Vec::with_capacity(want);
        let mut resp = resp;
        let mut ok = true;
        while buf.len() < want {
            match tokio::time::timeout(Duration::from_secs(30), resp.chunk()).await {
                Ok(Ok(Some(c))) => {
                    let take = c.len().min(want - buf.len());
                    buf.extend_from_slice(&c[..take]);
                }
                Ok(Ok(None)) => break,
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && buf.len() == want {
            return Ok(buf);
        }
        last = format!("short body {}/{want}", buf.len());
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
            return fetch_span(client, state, span.start, span.end).await;
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
    fn window_caps() {
        let s = window_span(&Span { start: 0, end: 100 * 1024 * 1024 });
        assert_eq!(s.end, WINDOW - 1);
        let s = window_span(&Span { start: 10, end: 20 });
        assert_eq!(s, Span { start: 10, end: 20 });
    }

    #[test]
    fn content_range_total() {
        assert_eq!(parse_content_range_total("bytes 0-0/12345"), Some(12345));
        assert_eq!(parse_content_range_total("bytes */999"), Some(999));
        assert_eq!(parse_content_range_total("bytes 0-0/*"), None);
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
