//! Casting to Google TV / Chromecast receivers.
//!
//! Two halves, and neither of them can live on the async runtime:
//!
//!   * Discovery browses `_googlecast._tcp` over mDNS. `mdns-sd` hands us a
//!     blocking channel, so the browse runs on a blocking task and streams
//!     partial results out as `cast-devices` — the TV that answered in 200ms
//!     should appear immediately, not when the whole window expires.
//!   * A session is one CASTv2 connection owned end to end by a dedicated
//!     thread. `rust_cast` builds its channels on `Rc` (its `thread_safe`
//!     feature is off), so the connection is `!Send` and cannot be parked in
//!     shared state at all: every read and write has to happen on the thread
//!     that created it. Commands post a message to that thread and await a
//!     one-shot reply; managed state only holds the sending end.
//!
//! The session thread also drives the status poll, which is what keeps the
//! link alive. `rust_cast`'s request helpers park every message they were not
//! waiting for in an internal buffer, so a receiver PING would sit there
//! unanswered and the device would hang up after ~10s. Each tick therefore
//! pings and then reads until its own PONG comes back, which answers the
//! heartbeat and drains that buffer in one pass.
//!
//! Media is fetched by the receiver straight off our LAN stream server: plain
//! http, opus in webm, no transcoding. Verified against a 4K Google TV Stick.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::{Duration, Instant};

use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent};
use rust_cast::channels::heartbeat::HeartbeatResponse;
use rust_cast::channels::media::{
    Image, Media, Metadata, MusicTrackMediaMetadata, PlayerState, StreamType,
};
use rust_cast::channels::receiver::CastDeviceApp;
use rust_cast::{CastDevice as Connection, ChannelMessage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

/// A receiver found on the LAN.
#[derive(Serialize, Clone, Debug)]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    pub model: String,
    pub host: String,
    pub port: u16,
}

/// Current session state, mirrored to the frontend on every change. `PartialEq`
/// is what decides whether a poll tick is worth an event at all.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CastStatus {
    pub device_id: Option<String>,
    pub state: String,
    pub position: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
    pub error: Option<String>,
}

impl Default for CastStatus {
    fn default() -> Self {
        Self {
            device_id: None,
            state: "idle".to_string(),
            position: 0.0,
            duration: 0.0,
            volume: 1.0,
            muted: false,
            error: None,
        }
    }
}

// ── Discovery ───────────────────────────────────────────────────────────────

const SERVICE_TYPE: &str = "_googlecast._tcp.local.";

/// Browse until `timeout` elapses, publishing the list every time it grows.
fn discover_blocking(app: &AppHandle, timeout: Duration) -> Result<Vec<CastDevice>, String> {
    let daemon = ServiceDaemon::new().map_err(|err| err.to_string())?;
    let events = daemon.browse(SERVICE_TYPE).map_err(|err| err.to_string())?;

    let deadline = Instant::now() + timeout;
    let mut found: Vec<CastDevice> = Vec::new();

    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        // An error here is either the window closing or the daemon dying;
        // either way there is nothing further to wait for.
        let Ok(event) = events.recv_timeout(deadline - now) else {
            break;
        };
        let ServiceEvent::ServiceResolved(service) = event else {
            continue;
        };
        let Some(device) = to_device(&service) else {
            continue;
        };

        // Receivers re-announce themselves constantly; only an actual change
        // is worth another event.
        match found.iter().position(|known| known.id == device.id) {
            Some(index) => {
                if found[index].host == device.host && found[index].name == device.name {
                    continue;
                }
                found[index] = device;
            }
            None => found.push(device),
        }
        let _ = app.emit("cast-devices", &found);
    }

    let _ = daemon.shutdown();
    Ok(found)
}

/// Google's TXT keys: `fn` is the name the user gave the device, `md` the
/// hardware model. Entries without an IPv4 address are dropped — CASTv2 is
/// reachable over v4 in practice and a v6-only entry would only fail later.
fn to_device(service: &ResolvedService) -> Option<CastDevice> {
    let mut addresses: Vec<_> = service
        .addresses
        .iter()
        .filter(|address| address.is_ipv4())
        .map(|address| address.to_ip_addr())
        .collect();
    // `addresses` is a HashSet, so pick deterministically or a device with two
    // interfaces would appear to change address on every announcement.
    addresses.sort();
    let host = addresses.first()?.to_string();

    let instance = service
        .fullname
        .strip_suffix(&format!(".{SERVICE_TYPE}"))
        .unwrap_or(&service.fullname);

    let name = service
        .txt_properties
        .get_property_val_str("fn")
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(instance);

    Some(CastDevice {
        id: service.fullname.clone(),
        name: name.to_string(),
        model: service
            .txt_properties
            .get_property_val_str("md")
            .unwrap_or_default()
            .trim()
            .to_string(),
        host,
        port: service.port,
    })
}

// ── Session ─────────────────────────────────────────────────────────────────

/// `rust_cast` keeps this private: the fixed id of the platform receiver, which
/// is the only thing addressable before an app has been launched.
const PLATFORM_RECEIVER: &str = "receiver-0";

const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// How long a command waits on the session thread. A receiver that loses power
/// without closing its socket leaves our read blocked until the OS gives up on
/// the TCP connection, which takes minutes; the UI must not wait that out.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

type Reply = oneshot::Sender<Result<(), String>>;

struct LoadRequest {
    url: String,
    content_type: String,
    title: String,
    artist: String,
    artwork_url: Option<String>,
    duration: f64,
}

enum Cmd {
    Load(Box<LoadRequest>, Reply),
    Play(Reply),
    Pause(Reply),
    Stop(Reply),
    Seek(f64, Reply),
    SetVolume(f64, Reply),
    Disconnect(Reply),
}

/// The receiver app we launched and everything needed to address it.
#[derive(Clone)]
struct Launched {
    transport_id: String,
    session_id: String,
    /// Only exists once something has been loaded.
    media_session_id: Option<i32>,
    /// Duration we were handed at LOAD. The receiver reports its own once it
    /// has buffered enough, but until then this is all the UI can draw with.
    duration: f64,
}

fn session_thread(
    app: AppHandle,
    device_id: String,
    host: String,
    port: u16,
    commands: mpsc::Receiver<Cmd>,
    slot: Arc<SyncMutex<CastStatus>>,
    ready: Reply,
) {
    // Cast devices present a certificate chained to Google's own cast CA,
    // which is in no OS trust store, so verifying the name can only ever fail.
    // The transport is still encrypted and the peer is one we just found on
    // the local link.
    let connection: Connection<'static> =
        match Connection::connect_without_host_verification(host, port) {
            Ok(connection) => connection,
            Err(err) => {
                let _ = ready.send(Err(err.to_string()));
                return;
            }
        };

    if let Err(err) = connection.connection.connect(PLATFORM_RECEIVER.to_string()) {
        let _ = ready.send(Err(err.to_string()));
        return;
    }

    let mut launched: Option<Launched> = None;

    // Prove the link answers before reporting success, so a device that
    // accepts the socket and then goes quiet fails at connect time instead of
    // looking connected.
    let mut last = match poll(&connection, &device_id, &mut launched) {
        Ok(status) => status,
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };
    publish(&app, &slot, &last);
    let _ = ready.send(Ok(()));

    loop {
        match commands.recv_timeout(POLL_INTERVAL) {
            Ok(cmd) => {
                if !run(&connection, &mut launched, cmd) {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            // Managed state was dropped: the app is shutting down.
            Err(RecvTimeoutError::Disconnected) => return,
        }

        match poll(&connection, &device_id, &mut launched) {
            Ok(status) => {
                if status != last {
                    publish(&app, &slot, &status);
                    last = status;
                }
            }
            Err(err) => {
                // Terminal. The socket is gone or the receiver stopped
                // answering; say so once and let the thread die, because the
                // next cast_connect builds a fresh session anyway.
                let status = CastStatus {
                    device_id: Some(device_id),
                    state: "error".to_string(),
                    error: Some(err),
                    ..CastStatus::default()
                };
                publish(&app, &slot, &status);
                return;
            }
        }
    }
}

/// Runs one command. Returns false when the session should end.
fn run(connection: &Connection<'static>, launched: &mut Option<Launched>, cmd: Cmd) -> bool {
    match cmd {
        Cmd::Load(request, reply) => {
            let _ = reply.send(load(connection, launched, *request));
        }
        Cmd::Play(reply) => {
            let _ = reply.send(addressed(launched).and_then(|(to, session)| {
                connection
                    .media
                    .play(to, session)
                    .map(|_| ())
                    .map_err(|err| err.to_string())
            }));
        }
        Cmd::Pause(reply) => {
            let _ = reply.send(addressed(launched).and_then(|(to, session)| {
                connection
                    .media
                    .pause(to, session)
                    .map(|_| ())
                    .map_err(|err| err.to_string())
            }));
        }
        Cmd::Stop(reply) => {
            let _ = reply.send(addressed(launched).and_then(|(to, session)| {
                connection
                    .media
                    .stop(to, session)
                    .map(|_| ())
                    .map_err(|err| err.to_string())
            }));
        }
        Cmd::Seek(seconds, reply) => {
            let _ = reply.send(addressed(launched).and_then(|(to, session)| {
                // No resume state: seeking must not decide for the user
                // whether playback carries on.
                connection
                    .media
                    .seek(to, session, Some(seconds.max(0.0) as f32), None)
                    .map(|_| ())
                    .map_err(|err| err.to_string())
            }));
        }
        Cmd::SetVolume(level, reply) => {
            let _ = reply.send(
                connection
                    .receiver
                    .set_volume(level.clamp(0.0, 1.0) as f32)
                    .map(|_| ())
                    .map_err(|err| err.to_string()),
            );
        }
        Cmd::Disconnect(reply) => {
            // Stopping the app returns the TV to its backdrop instead of
            // leaving our idle receiver on screen.
            if let Some(session) = launched.as_ref() {
                let _ = connection.receiver.stop_app(session.session_id.clone());
            }
            let _ = connection
                .connection
                .disconnect(PLATFORM_RECEIVER.to_string());
            let _ = reply.send(Ok(()));
            return false;
        }
    }
    true
}

/// Transport and media session for the playback commands, or an error the UI
/// can show when nothing is loaded yet.
fn addressed(launched: &Option<Launched>) -> Result<(String, i32), String> {
    let session = launched
        .as_ref()
        .ok_or_else(|| "nothing is loaded on the cast device".to_string())?;
    let media_session_id = session
        .media_session_id
        .ok_or_else(|| "nothing is loaded on the cast device".to_string())?;
    Ok((session.transport_id.clone(), media_session_id))
}

fn load(
    connection: &Connection<'static>,
    launched: &mut Option<Launched>,
    request: LoadRequest,
) -> Result<(), String> {
    // Launch once and reuse. A second LAUNCH restarts the receiver app on
    // screen and invalidates the session we are already streaming into.
    let session = match launched.as_ref() {
        Some(session) => session.clone(),
        None => {
            let wanted = CastDeviceApp::DefaultMediaReceiver;
            connection
                .receiver
                .launch_app(&wanted)
                .map_err(|err| err.to_string())?;
            // rust_cast's launcher hands back whichever app happens to be
            // first in the receiver's list, which is not ours if the TV had
            // something else up. Ask again and pick by id.
            let wanted = wanted.to_string();
            let started = connection
                .receiver
                .get_status()
                .map_err(|err| err.to_string())?
                .applications
                .into_iter()
                .find(|running| running.app_id == wanted)
                .ok_or_else(|| "the receiver did not start the media app".to_string())?;
            // Media messages are addressed to the app, not the platform, and
            // the app drops anything sent before its own CONNECT.
            connection
                .connection
                .connect(started.transport_id.clone())
                .map_err(|err| err.to_string())?;
            Launched {
                transport_id: started.transport_id,
                session_id: started.session_id,
                media_session_id: None,
                duration: 0.0,
            }
        }
    };

    let media = Media {
        content_id: request.url,
        stream_type: StreamType::Buffered,
        content_type: request.content_type,
        // MusicTrack rather than Generic: it is what makes the receiver draw
        // the art full-bleed with the title and artist under it.
        metadata: Some(Metadata::MusicTrack(MusicTrackMediaMetadata {
            title: Some(request.title),
            artist: Some(request.artist.clone()),
            album_artist: Some(request.artist),
            images: request
                .artwork_url
                .filter(|url| !url.is_empty())
                .map(|url| vec![Image::new(url)])
                .unwrap_or_default(),
            ..MusicTrackMediaMetadata::default()
        })),
        duration: (request.duration > 0.0).then_some(request.duration as f32),
    };

    let status = connection
        .media
        .load(
            session.transport_id.clone(),
            session.session_id.clone(),
            &media,
        )
        .map_err(|err| err.to_string())?;

    *launched = Some(Launched {
        media_session_id: status.entries.first().map(|entry| entry.media_session_id),
        duration: request.duration,
        ..session
    });
    Ok(())
}

/// One status sweep, and the heartbeat that keeps the connection open.
fn poll(
    connection: &Connection<'static>,
    device_id: &str,
    launched: &mut Option<Launched>,
) -> Result<CastStatus, String> {
    let receiver = connection
        .receiver
        .get_status()
        .map_err(|err| err.to_string())?;

    // The app can go away without the socket closing — someone presses home on
    // the TV. Let go of it rather than addressing a dead transport, which would
    // leave us waiting on a reply that is never coming.
    if let Some(session) = launched.as_ref() {
        if !receiver
            .applications
            .iter()
            .any(|running| running.session_id == session.session_id)
        {
            *launched = None;
        }
    }

    let mut state = "idle";
    let mut position = 0.0;
    let mut duration = 0.0;

    if let Some(session) = launched.clone() {
        duration = session.duration;
        let media = connection
            .media
            .get_status(session.transport_id, session.media_session_id)
            .map_err(|err| err.to_string())?;

        if let Some(entry) = media.entries.first() {
            state = match entry.player_state {
                PlayerState::Playing => "playing",
                PlayerState::Buffering => "buffering",
                PlayerState::Paused => "paused",
                PlayerState::Idle => "idle",
            };
            position = entry.current_time.unwrap_or(0.0) as f64;
            if let Some(reported) = entry.media.as_ref().and_then(|media| media.duration) {
                duration = reported as f64;
            }
            // Adopt whatever session the receiver is actually on, which also
            // covers a load whose reply we never matched.
            if let Some(current) = launched.as_mut() {
                current.media_session_id = Some(entry.media_session_id);
            }
        }
    }

    // Ping, then read until our own PONG: answers the receiver's heartbeat,
    // empties the buffer the status calls above just filled, and fails loudly
    // the moment the socket is gone.
    connection.heartbeat.ping().map_err(|err| err.to_string())?;
    loop {
        match connection.receive().map_err(|err| err.to_string())? {
            ChannelMessage::Heartbeat(HeartbeatResponse::Pong) => break,
            ChannelMessage::Heartbeat(HeartbeatResponse::Ping) => connection
                .heartbeat
                .pong()
                .map_err(|err| err.to_string())?,
            _ => {}
        }
    }

    Ok(CastStatus {
        device_id: Some(device_id.to_string()),
        state: state.to_string(),
        position,
        duration,
        volume: receiver.volume.level.unwrap_or(1.0) as f64,
        muted: receiver.volume.muted.unwrap_or(false),
        error: None,
    })
}

/// Mirror a status into the shared slot and out to the frontend.
fn publish(app: &AppHandle, slot: &SyncMutex<CastStatus>, status: &CastStatus) {
    // The guard only ever wraps a struct copy, so a poisoned lock has nothing
    // left to protect — recover it instead of taking the session down with it.
    *slot.lock().unwrap_or_else(|err| err.into_inner()) = status.clone();
    let _ = app.emit("cast-status", status);
}

// ── Managed state ───────────────────────────────────────────────────────────

/// Register with `.manage(cast::CastState::default())`.
#[derive(Default)]
pub struct CastState {
    inner: Mutex<Inner>,
    /// Latest status. Separate from `inner` because the session thread writes
    /// it from outside the async runtime, where the tokio mutex is unusable.
    status: Arc<SyncMutex<CastStatus>>,
}

#[derive(Default)]
struct Inner {
    /// Everything discovery has seen this run, so `cast_connect` can turn an id
    /// from the UI back into an address.
    devices: HashMap<String, CastDevice>,
    session: Option<mpsc::Sender<Cmd>>,
}

impl CastState {
    fn snapshot(&self) -> CastStatus {
        self.status
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}

/// Hand a command to the session thread and wait for its answer.
async fn dispatch<F>(app: &AppHandle, state: &CastState, build: F) -> Result<(), String>
where
    F: FnOnce(Reply) -> Cmd,
{
    let (reply, answer) = oneshot::channel();
    {
        let inner = state.inner.lock().await;
        let session = inner
            .session
            .as_ref()
            .ok_or_else(|| "not connected to a cast device".to_string())?;
        session
            .send(build(reply))
            .map_err(|_| "cast session ended".to_string())?;
    }

    match tokio::time::timeout(COMMAND_TIMEOUT, answer).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("cast session ended".to_string()),
        Err(_) => {
            // The thread is stuck in a socket read that only unblocks when the
            // OS times the connection out, so treat the device as gone: report
            // it, forget the session, and let the thread unwind on its own.
            let lost = CastStatus {
                device_id: state.snapshot().device_id,
                state: "error".to_string(),
                error: Some("cast device stopped responding".to_string()),
                ..CastStatus::default()
            };
            state.inner.lock().await.session = None;
            publish(app, &state.status, &lost);
            Err("cast device stopped responding".to_string())
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Browse for receivers, emitting `cast-devices` as they answer.
#[tauri::command]
pub async fn cast_discover(
    app: AppHandle,
    state: State<'_, CastState>,
    timeout_ms: u64,
) -> Result<Vec<CastDevice>, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(500, 30_000));
    let emitter = app.clone();
    let found = tauri::async_runtime::spawn_blocking(move || discover_blocking(&emitter, timeout))
        .await
        .map_err(|err| err.to_string())??;

    // Merge rather than replace: a device that skipped this round is still
    // reachable, and an id the UI is already holding has to keep resolving.
    let mut inner = state.inner.lock().await;
    for device in &found {
        inner.devices.insert(device.id.clone(), device.clone());
    }
    Ok(found)
}

/// Open a CASTv2 connection. Does not launch anything on the TV yet — that
/// happens on the first `cast_load`.
#[tauri::command]
pub async fn cast_connect(
    app: AppHandle,
    state: State<'_, CastState>,
    device_id: String,
) -> Result<(), String> {
    let device = state
        .inner
        .lock()
        .await
        .devices
        .get(&device_id)
        .cloned()
        .ok_or_else(|| format!("unknown cast device: {device_id}"))?;

    // Tear the old session down first. Two live connections would both poll
    // and both emit, and the UI has no way to tell them apart.
    //
    // WAIT for it to finish. A receiver accepts one sender connection, so
    // opening the new socket while the old one is still closing gets refused
    // — which showed up as "the first click never connects, the second one
    // does". Bounded, because a wedged session must not block reconnecting
    // forever; by the time that timeout expires the socket is gone anyway.
    let previous = state.inner.lock().await.session.take();
    if let Some(previous) = previous {
        let (reply, closed) = oneshot::channel();
        if previous.send(Cmd::Disconnect(reply)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(3), closed).await;
        }
    }

    publish(
        &app,
        &state.status,
        &CastStatus {
            device_id: Some(device_id.clone()),
            state: "connecting".to_string(),
            ..CastStatus::default()
        },
    );

    let (commands, inbox) = mpsc::channel::<Cmd>();
    let (ready, started) = oneshot::channel();
    let worker = app.clone();
    let slot = state.status.clone();
    let id = device_id.clone();
    std::thread::Builder::new()
        .name("cast-session".into())
        .spawn(move || session_thread(worker, id, device.host, device.port, inbox, slot, ready))
        .map_err(|err| err.to_string())?;

    match started
        .await
        .unwrap_or_else(|_| Err("cast session ended before it connected".to_string()))
    {
        Ok(()) => {
            state.inner.lock().await.session = Some(commands);
            Ok(())
        }
        Err(err) => {
            publish(
                &app,
                &state.status,
                &CastStatus {
                    device_id: Some(device_id),
                    state: "error".to_string(),
                    error: Some(err.clone()),
                    ..CastStatus::default()
                },
            );
            Err(err)
        }
    }
}

/// Stop the receiver app and close the connection.
#[tauri::command]
pub async fn cast_disconnect(app: AppHandle, state: State<'_, CastState>) -> Result<(), String> {
    let session = state.inner.lock().await.session.take();
    if let Some(session) = session {
        let (reply, answer) = oneshot::channel();
        if session.send(Cmd::Disconnect(reply)).is_ok() {
            let _ = tokio::time::timeout(COMMAND_TIMEOUT, answer).await;
        }
    }
    publish(&app, &state.status, &CastStatus::default());
    Ok(())
}

/// Launch the Default Media Receiver if needed and start `url` on it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cast_load(
    app: AppHandle,
    state: State<'_, CastState>,
    url: String,
    content_type: String,
    title: String,
    artist: String,
    artwork_url: Option<String>,
    duration: f64,
) -> Result<(), String> {
    let request = LoadRequest {
        url,
        content_type,
        title,
        artist,
        artwork_url,
        duration,
    };
    dispatch(&app, &state, move |reply| {
        Cmd::Load(Box::new(request), reply)
    })
    .await
}

#[tauri::command]
pub async fn cast_play(app: AppHandle, state: State<'_, CastState>) -> Result<(), String> {
    dispatch(&app, &state, Cmd::Play).await
}

#[tauri::command]
pub async fn cast_pause(app: AppHandle, state: State<'_, CastState>) -> Result<(), String> {
    dispatch(&app, &state, Cmd::Pause).await
}

/// Stop playback. The receiver app stays up; `cast_disconnect` closes it.
#[tauri::command]
pub async fn cast_stop(app: AppHandle, state: State<'_, CastState>) -> Result<(), String> {
    dispatch(&app, &state, Cmd::Stop).await
}

#[tauri::command]
pub async fn cast_seek(
    app: AppHandle,
    state: State<'_, CastState>,
    seconds: f64,
) -> Result<(), String> {
    dispatch(&app, &state, move |reply| Cmd::Seek(seconds, reply)).await
}

/// Device volume, 0.0..1.0. This is the receiver's own level, so on a TV stick
/// it moves the TV.
#[tauri::command]
pub async fn cast_set_volume(
    app: AppHandle,
    state: State<'_, CastState>,
    level: f64,
) -> Result<(), String> {
    dispatch(&app, &state, move |reply| Cmd::SetVolume(level, reply)).await
}

/// Last known status. The poll loop pushes `cast-status` on every change, so
/// this is only for a frontend that needs to (re)synchronise.
#[tauri::command]
pub fn cast_status(state: State<'_, CastState>) -> Result<CastStatus, String> {
    Ok(state.snapshot())
}
