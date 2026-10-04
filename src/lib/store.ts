// Small localStorage helpers for reader preferences and reading progress.

import { useCallback, useState } from "react";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: preferences just don't persist
  }
}

/** useState that persists to localStorage under `key` (re-read when the key changes). */
export function useStored<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState(() => ({ key, value: load(key, fallback) }));
  const value = state.key === key ? state.value : load(key, fallback);
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setState((s) => {
        const prev = s.key === key ? s.value : load(key, fallback);
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        save(key, next);
        return { key, value: next };
      }),
    // `fallback` is a literal at every call site; only the key matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}

/** Where the reader was in a book. */
export interface Progress {
  unit: string;
  section: string;
  page: string;
  /** 0..1 through the unit's pages. */
  fraction: number;
}

export const progressKey = (book: string) => `yagami.progress.${book}`;
export const LAST_BOOK = "yagami.lastBook";
