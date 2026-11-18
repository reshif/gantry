/**
 * Floor filters in the URL (rule F-15): `?q=&cls=&pri=&st=` next to the hash route. Written with `replaceState` (no history entry, no route
 * change), read with a store so every reader sees the write at once, and a pasted or reloaded link restores the same belt.
 */
import { useCallback, useSyncExternalStore } from "react";
import { NO_FILTER, type BeltFilter } from "./conveyor";

const KEYS = ["q", "cls", "pri", "st"] as const;
const EVENT = "gantry:floor-url";

const read = (): string => {
  try {
    return window.location.search;
  } catch {
    return "";
  }
};
const subscribe = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  window.addEventListener("popstate", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("popstate", fn);
  };
};

export function filterFromSearch(search: string): BeltFilter {
  const q = new URLSearchParams(search);
  return { q: q.get("q") ?? "", cls: q.get("cls") || "all", pri: q.get("pri") || "all", st: q.get("st") || "all" };
}

function write(next: BeltFilter): void {
  try {
    const u = new URL(window.location.href);
    for (const k of KEYS) {
      const v = next[k];
      if (v && v !== "all") u.searchParams.set(k, v);
      else u.searchParams.delete(k);
    }
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
  } catch {
    /* no history access: the filter still works, it is just not in the URL */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The belt filter and its setters, held in the URL. */
export function useFloorFilter(): { filter: BeltFilter; set: (k: keyof BeltFilter, v: string) => void; clear: () => void } {
  const search = useSyncExternalStore(subscribe, read, () => "");
  const filter = filterFromSearch(search);
  const set = useCallback((k: keyof BeltFilter, v: string) => write({ ...filterFromSearch(read()), [k]: v }), []);
  const clear = useCallback(() => write(NO_FILTER), []);
  return { filter, set, clear };
}
