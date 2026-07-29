import type { StateStorage } from "zustand/middleware";

/** localStorage wrapper that prevents quota failures from blanking the UI. */
export const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      window.localStorage.setItem(name, value);
    } catch (error) {
      console.warn(`[safe-storage] failed to persist "${name}":`, error);
    }
  },
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name);
    } catch {
      // Best effort only.
    }
  },
};
