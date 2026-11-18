/**
 * URL state for a view's tabs, filters and sorting (rule F-15): `?tab=questions&q=refund`. The query string sits next to the hash route, so a reload or a pasted
 * link restores it. A value equal to its default is left out of the URL. Writes use `replaceState` (no history entry) and tell every reader in this window.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { parseHash } from "./router";

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

const snapshot = (): string => {
  try {
    return window.location.search;
  } catch {
    return "";
  }
};

function writeWith(mutate: (q: URLSearchParams) => void): void {
  try {
    const u = new URL(window.location.href);
    mutate(u.searchParams);
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
  } catch {
    /* a sandboxed frame without history access: the state still works, it is just not in the URL */
  }
  window.dispatchEvent(new Event(EVT));
}

/** The values of `keys` from the URL (empty string when absent), a setter that merges a patch (empty or null removes a key) and `clear`. */
export function useQueryState<K extends string>(keys: readonly K[]): { values: Record<K, string>; set: (patch: Partial<Record<K, string | null>>) => void; clear: (except?: readonly K[]) => void } {
  const search = useSyncExternalStore(subscribe, snapshot, () => "");
  const q = new URLSearchParams(search);
  const values = Object.fromEntries(keys.map((k) => [k, q.get(k) ?? ""])) as Record<K, string>;
  const set = useCallback((patch: Partial<Record<K, string | null>>) => writeWith((p) => { for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v as string); else p.delete(k); } }), []);
  const clear = useCallback((except: readonly K[] = []) => writeWith((p) => { for (const k of keys) if (!except.includes(k)) p.delete(k); }), [keys]);
  useEffect(() => {
    const route = parseHash(window.location.hash).id;
    const onHash = () => { if (parseHash(window.location.hash).id !== route) writeWith((p) => { for (const k of keys) p.delete(k); }); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [keys]);
  return { values, set, clear };
}
