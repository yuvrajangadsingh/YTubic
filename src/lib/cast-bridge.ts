import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePlaybackStore } from "@/lib/store/playback";
import { useCastStore } from "@/lib/store/cast";
import { castUrlFor, streamUrlFor } from "@/lib/stream";
import { artistLineFromSubtitle } from "@/lib/utils";
import {
  getHighResVariant,
  pickThumbnail,
} from "@/components/shared/thumbnail";

/**
 * Hands the current track to the receiver and keeps exactly one of the two
 * players making sound.
 *
 * A cast session is the TV pulling bytes for itself, not us pushing audio, so
 * "casting" means: silence the local element, ask Rust for a LAN-reachable URL
 * for the same stream, and LOAD it on the receiver. The local element stays
 * paused rather than muted — a muted element still holds the audio session and
 * would keep the system Now Playing entry pointing at a track we are not the
 * ones playing.
 *
 * Mounted once, next to `useCastEvents`.
 */
/**
 * Block until the stream server can state a total size for this track, or give
 * up. A receiver will not take media it cannot get a definite Content-Length
 * for, and a track that yt-dlp is still downloading is served progressively
 * with an open-ended range. That is the whole difference between a song that
 * casts instantly (already on disk) and a new one that silently never plays.
 *
 * Probed over loopback; the CSP forbids reaching the LAN address from here.
 */
async function waitForCastableLength(
  loopbackUrl: string,
  isCancelled: () => boolean,
): Promise<string | undefined> {
  const deadline = Date.now() + 90_000;
  while (!isCancelled() && Date.now() < deadline) {
    try {
      const r = await fetch(loopbackUrl, { headers: { Range: "bytes=0-1" } });
      // `bytes 0-1/12345` means the server knows the whole file. `bytes 0-1/*`
      // means it is still arriving and the receiver would choke on it.
      const total = r.headers.get("content-range")?.split("/")[1];
      if (total && total !== "*") {
        return r.headers.get("content-type")?.split(";")[0].trim();
      }
    } catch {
      /* server not up yet, or the track is still resolving */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return undefined;
}

export function useCastBridge(): void {
  const deviceId = useCastStore((s) => s.deviceId);
  // Not the same as deviceId: that only means the user picked a device.
  // Loading before Rust holds a session fails with "not connected".
  const ready = useCastStore((s) => s.ready);
  const track = usePlaybackStore((s) => s.queue[s.index]);

  // Receiver -> app. Mirroring its state into the playback store means the
  // whole existing UI (progress bar, play button, fullscreen player) keeps
  // reading one source and needs to know nothing about casting. Position is
  // the receiver's, not ours, so scrubbing on the TV shows up here too.
  useEffect(() => {
    if (!deviceId) return;
    return useCastStore.subscribe((s, prev) => {
      if (s.state === prev.state && s.position === prev.position) return;
      const pb = usePlaybackStore.getState();
      if (s.position !== prev.position) pb.setPosition(s.position);
      if (s.duration > 0 && s.duration !== prev.duration) {
        pb.setDuration(s.duration);
      }
      if (s.state !== prev.state) pb.setPlaying(s.state === "playing");
      // The receiver reaching the end of a track is our cue to advance,
      // since the local element is paused and will never fire `ended`.
      if (s.state === "idle" && prev.state === "playing") pb.next();
    });
  }, [deviceId]);
  // What the receiver is confirmed to be holding. Re-LOADing the same id would
  // restart it from zero every time an unrelated bit of playback state changed.
  const loadedRef = useRef<string | null>(null);
  // What is being handed over right now, so overlapping runs do not both send.
  const inFlightRef = useRef<string | null>(null);
  const videoId = track?.videoId;

  useEffect(() => {
    if (!deviceId) {
      // Session gone: drop the LAN listener so we are not reachable off this
      // machine while nobody is casting. Best-effort — a failure here must not
      // stop local playback resuming.
      loadedRef.current = null;
      void invoke("stream_lan_stop").catch(() => {});
      return;
    }
    if (!ready) return;
    if (!track) return;
    if (loadedRef.current === videoId) return;
    // Already being loaded. Without this the dedupe below would let a second
    // run fire another LOAD for the same track while the first is in flight.
    if (inFlightRef.current === videoId) return;

    let cancelled = false;
    inFlightRef.current = videoId;

    void (async () => {
      // Stop making noise here before the TV starts making it there.
      usePlaybackStore.getState().setPlaying(false);

      try {
        const url = await castUrlFor(track.videoId);
        if (cancelled) return;
        // The receiver fetches the artwork itself, so this has to be a URL it
        // can reach. Thumbnails are already remote googleusercontent URLs, not
        // our loopback cover cache, so they work as-is.
        //
        // Ask for far more pixels than a thumbnail: the receiver paints this
        // near-fullscreen on a 4K panel, and the ~500px art the queue rows use
        // arrives there as visible blocks. The upgrade is a URL size token, so
        // it costs nothing when the source has one and falls back when it
        // doesn't.
        const base = pickThumbnail(track.thumbnails, 1200);
        const artwork = base ? (getHighResVariant(base, 1200) ?? base) : null;
        // Ask the server what it is actually going to serve rather than
        // declaring a type. yt-dlp picks per track, so the same endpoint
        // answers audio/mp4 for one song and audio/webm for the next, and a
        // receiver handed a content type that disagrees with the bytes just
        // refuses the media, without ever fetching it. LOAD still reports
        // success, so it fails silently from our side.
        //
        // Probed over LOOPBACK, not the LAN url the TV gets. Same server and
        // same file, so the same content type, but the app's CSP only allows
        // connect-src to 127.0.0.1 — fetching the LAN address from here is
        // blocked outright and takes cast_load down with it.
        // Tell the UI we are waiting rather than leaving it looking idle: a
        // fresh track has to finish downloading before the receiver will take
        // it, and that is seconds, not milliseconds.
        useCastStore.setState({ state: "buffering" });
        const contentType = await waitForCastableLength(
          await streamUrlFor(track.videoId),
          () => cancelled,
        );
        if (cancelled) return;
        if (!contentType) {
          throw new Error(
            "timed out waiting for the track to finish downloading",
          );
        }
        await invoke("cast_load", {
          url,
          contentType,
          title: track.title,
          artist:
            track.artists?.map((a) => a.name).join(", ") ||
            artistLineFromSubtitle(track.subtitle),
          artworkUrl: artwork,
          duration: track.duration ?? 0,
        });
        // Marked loaded only once the receiver has actually taken it. Setting
        // this up front looked equivalent and was not: any re-render that
        // cancelled the effect mid-flight left the id recorded as loaded with
        // nothing on the receiver, and every later run then short-circuited on
        // it. The result was a track that never played and a play button that
        // did nothing, because cast_play on a receiver with no media is a
        // no-op.
        if (!cancelled) loadedRef.current = videoId;
      } catch (e) {
        if (cancelled) return;
        useCastStore.setState({
          lastError: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (inFlightRef.current === videoId) inFlightRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
    // Keyed on the id, not the track object. The engine rewrites queue entries
    // as durations resolve, which produced a new object for the same song and
    // re-ran this constantly.
  }, [deviceId, ready, videoId, track]);
}
