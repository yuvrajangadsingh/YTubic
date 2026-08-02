import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePlaybackStore } from "@/lib/store/playback";
import { useCastStore } from "@/lib/store/cast";
import { castUrlFor } from "@/lib/stream";
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
export function useCastBridge(): void {
  const deviceId = useCastStore((s) => s.deviceId);
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
  // What we last handed the receiver. Re-LOADing the same id would restart it
  // from zero every time an unrelated bit of playback state changed.
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!deviceId) {
      // Session gone: drop the LAN listener so we are not reachable off this
      // machine while nobody is casting. Best-effort — a failure here must not
      // stop local playback resuming.
      loadedRef.current = null;
      void invoke("stream_lan_stop").catch(() => {});
      return;
    }
    if (!track) return;
    if (loadedRef.current === track.videoId) return;

    let cancelled = false;
    loadedRef.current = track.videoId;

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
        await invoke("cast_load", {
          url,
          contentType: "audio/webm",
          title: track.title,
          artist:
            track.artists?.map((a) => a.name).join(", ") ||
            artistLineFromSubtitle(track.subtitle),
          artworkUrl: artwork,
          duration: track.duration ?? 0,
        });
      } catch (e) {
        if (cancelled) return;
        // Let the next track try again rather than latching a failed id.
        loadedRef.current = null;
        useCastStore.setState({
          lastError: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deviceId, track]);
}
