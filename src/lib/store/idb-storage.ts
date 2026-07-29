import { createStore, del, get, set } from "idb-keyval";
import type { StateStorage } from "zustand/middleware";

const idbStore =
  typeof window !== "undefined"
    ? createStore("ytubic-stores", "kv")
    : undefined;

/** IndexedDB-backed zustand storage that never propagates I/O failures. */
export const safeIdbStorage: StateStorage = {
  getItem: async (name) => {
    if (!idbStore) return null;
    try {
      return (await get<string>(name, idbStore)) ?? null;
    } catch (error) {
      console.warn(`[idb-storage] failed to read "${name}":`, error);
      return null;
    }
  },
  setItem: async (name, value) => {
    if (!idbStore) return;
    try {
      await set(name, value, idbStore);
    } catch (error) {
      console.warn(`[idb-storage] failed to persist "${name}":`, error);
    }
  },
  removeItem: async (name) => {
    if (!idbStore) return;
    try {
      await del(name, idbStore);
    } catch (error) {
      console.warn(`[idb-storage] failed to remove "${name}":`, error);
    }
  },
};

export function dropLegacyLocalStorageKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to reclaim when localStorage itself is unavailable.
  }
}
