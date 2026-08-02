import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A Cast receiver found on the LAN. Mirrors the Rust `CastDevice`. */
export type CastDevice = {
  /** mDNS instance name — stable across scans for the same box. */
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
};

/**
 * State of the receiver's media player, which is not the same thing as
 * the connection: a freshly connected device sits at "idle" until we
 * load something into it. `deviceId` is the connection signal.
 */
export type CastPlayerState =
  "idle" | "connecting" | "buffering" | "playing" | "paused" | "error";

/**
 * Payload of the `cast-status` event and the `cast_status` command. The
 * Rust struct is plain serde, so `device_id` stays snake_case on the
 * wire; `applyStatus` is the one place that maps it.
 */
export type CastStatus = {
  device_id: string | null;
  state: CastPlayerState;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  error: string | null;
};

// Long enough for a TV that's asleep on wifi to answer, short enough
// that the picker doesn't feel hung while it scans.
const DISCOVER_TIMEOUT_MS = 5000;

type State = {
  /** Receivers from the latest scan. Cleared when a new scan starts. */
  devices: CastDevice[];
  discovering: boolean;

  /**
   * Set while a cast session is live, `null` when playback belongs to
   * this machine. Transport routing keys off this, not off `state`.
   */
  deviceId: string | null;
  state: CastPlayerState;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  /** Error reported by the receiver itself. */
  error: string | null;
  /**
   * Why the last cast command failed (scan, connect, disconnect). Kept
   * apart from `error` so a failed scan doesn't render as a broken
   * session.
   */
  lastError: string | null;

  discover: () => Promise<void>;
  connect: (deviceId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  setDevices: (devices: CastDevice[]) => void;
  applyStatus: (status: CastStatus) => void;
};

/**
 * Cast session state, mirrored from the Rust side. Deliberately not
 * persisted: a session belongs to one run of the app and one LAN, so a
 * restored "connected to the living room TV" would be a lie every time.
 *
 * The store never drives the receiver on its own — it issues the
 * commands the picker asks for and otherwise waits for `cast-status`
 * events, so Rust stays the single source of truth about the session.
 */
export const useCastStore = create<State>()((set, get) => ({
  devices: [],
  discovering: false,
  deviceId: null,
  state: "idle",
  position: 0,
  duration: 0,
  volume: 1,
  muted: false,
  error: null,
  lastError: null,

  discover: async () => {
    if (get().discovering) return;
    set({ discovering: true, devices: [], lastError: null });
    try {
      // Devices also arrive incrementally over `cast-devices` while this
      // is in flight; the resolved list is the authoritative final set.
      const found = await invoke<CastDevice[]>("cast_discover", {
        timeoutMs: DISCOVER_TIMEOUT_MS,
      });
      set({ devices: found });
    } catch (e) {
      set({ lastError: String(e) });
    } finally {
      set({ discovering: false });
    }
  },

  connect: async (deviceId) => {
    // Optimistic: the handshake with a cold receiver takes a moment, and
    // the first `cast-status` only lands after it completes.
    set({ deviceId, state: "connecting", error: null, lastError: null });
    try {
      await invoke("cast_connect", { deviceId });
    } catch (e) {
      set({ deviceId: null, state: "idle", lastError: String(e) });
    }
  },

  disconnect: async () => {
    try {
      await invoke("cast_disconnect");
    } catch (e) {
      set({ lastError: String(e) });
    }
    // Local state resets either way — a disconnect that errored still
    // means we're no longer driving that device. A late `cast-status`
    // will correct us if Rust disagrees.
    set({
      deviceId: null,
      state: "idle",
      position: 0,
      duration: 0,
      error: null,
    });
  },

  setDevices: (devices) => set({ devices }),

  applyStatus: (status) =>
    set({
      // A status that names no device is not proof the session ended — the
      // mount re-sync reports the default snapshot, and that would drop a
      // live cast out of the UI. Only an explicit idle says disconnected;
      // anything else keeps the device we already have. Otherwise the
      // session flickers, and everything keyed off it (the LAN listener,
      // the local-playback mute) flickers with it.
      deviceId:
        status.device_id ??
        (status.state === "idle" ? null : get().deviceId),
      state: status.state,
      position: status.position,
      duration: status.duration,
      volume: status.volume,
      muted: status.muted,
      error: status.error,
    }),
}));

/** The receiver we're connected to, when it's still in the scan list. */
export function connectedDevice(s: State): CastDevice | undefined {
  if (!s.deviceId) return undefined;
  return s.devices.find((d) => d.id === s.deviceId);
}

/**
 * Synchronous read for non-React callers. True from the moment we ask
 * to connect, so transport can hand off before the receiver is ready
 * rather than briefly playing out of both.
 */
export function isCasting(): boolean {
  return useCastStore.getState().deviceId !== null;
}

/**
 * Mount once, wherever the cast button lives. Mirrors the backend's
 * `cast-devices` and `cast-status` broadcasts into the store.
 *
 * Also pulls the current status on mount: the player bar remounts when
 * the user switches layouts, and a session outlives that, so assuming
 * "idle" would silently drop a live cast from the UI.
 */
export function useCastEvents(): void {
  useEffect(() => {
    let cancelled = false;
    const disposers: UnlistenFn[] = [];
    const keep = (p: Promise<UnlistenFn>) => {
      void p.then((un) => (cancelled ? un() : disposers.push(un)));
    };

    keep(
      listen<CastDevice[]>("cast-devices", (e) => {
        useCastStore.getState().setDevices(e.payload);
      }),
    );
    keep(
      listen<CastStatus>("cast-status", (e) => {
        useCastStore.getState().applyStatus(e.payload);
      }),
    );

    // Ignore the failure: this also runs in builds without cast support,
    // where the command simply isn't registered, and "no session" is the
    // right answer there anyway.
    void invoke<CastStatus>("cast_status")
      .then((status) => {
        if (!cancelled) useCastStore.getState().applyStatus(status);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      for (const un of disposers) un();
    };
  }, []);
}
