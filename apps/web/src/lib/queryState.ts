/**
 * URL state for a view's tabs, filters and sorting (rule F-15): `?tab=questions&q=refund`. The query string sits next to the hash route, so a reload or a pasted
 * link restores it. A value equal to its default is left out of the URL. Writes use `replaceState` (no history entry) and tell every reader in this window.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

const EVT = "gantry:querystate";

function read(key: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

function write(entries: Record<string, string | null>): void {
  try {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(entries)) {
      if (v === null || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
  } catch {
    /* a sandboxed frame without history access: the state still works, it is just not in the URL */
  }
  window.dispatchEvent(new Event(EVT));
}

const subscribe = (fn: () => void) => {
  window.addEventListener(EVT, fn);
  window.addEventListener("popstate", fn);
  return () => {
    window.removeEventListener(EVT, fn);
    window.removeEventListener("popstate", fn);
  };
};

/** One value in the query string; `fallback` (the default) is not written. */
export function useRouteState(key: string, fallback: string): [string, (v: string) => void] {
  const raw = useSyncExternalStore(subscribe, () => read(key) ?? "", () => "");
  const set = useCallback((v: string) => write({ [key]: v === fallback ? null : v }), [key, fallback]);
  return [raw || fallback, set];
}

/** Sets several keys at once (for a "Clear" that resets the filters and keeps the tab). Empty or null removes a key. */
export const setRouteState = (entries: Record<string, string | null>): void => write(entries);

/** Removes a view's keys from the URL when it unmounts, so they do not follow a person to the next screen. */
export function useClearRouteStateOnLeave(keys: string[]): void {
  const joined = keys.join(",");
  useEffect(
    () => () => {
      const e: Record<string, null> = {};
      for (const k of joined.split(",")) e[k] = null;
      try {
        const u = new URL(window.location.href);
        let hit = false;
        for (const k of Object.keys(e)) if (u.searchParams.has(k)) { u.searchParams.delete(k); hit = true; }
        if (hit) window.history.replaceState(window.history.state, "", u.href);
      } catch {
        /* nothing to clear */
      }
    },
    [joined],
  );
}
