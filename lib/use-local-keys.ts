"use client";

/**
 * BYOK keys in localStorage, shared between the playground and dashboard.
 * useSyncExternalStore keeps reads hydration-safe (server snapshot = "{}")
 * and re-renders every subscriber when keys change in any tab.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

export const KEYS_STORAGE = "qp-byok-keys";
const CHANGE_EVENT = "qp-keys-changed";

function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

function getSnapshot(): string {
  return localStorage.getItem(KEYS_STORAGE) ?? "{}";
}

export function useLocalKeys() {
  const json = useSyncExternalStore(subscribe, getSnapshot, () => "{}");

  const keys = useMemo<Record<string, string>>(() => {
    try {
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }, [json]);

  const setKey = useCallback(
    (id: string, value: string) => {
      localStorage.setItem(KEYS_STORAGE, JSON.stringify({ ...keys, [id]: value }));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [keys],
  );

  /** Keys with non-empty values — what actually gets sent as x-qp-keys. */
  const activeKeys = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(keys).filter(([, v]) => String(v).trim().length > 0),
      ),
    [keys],
  );

  return { keys, activeKeys, setKey };
}
