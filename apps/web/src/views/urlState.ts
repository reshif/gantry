/**
 * URL state for a screen's tab, search, filter, sort and open detail (rule F-15): `?tab=runs&q=plan` next to the hash route, so a reload or a pasted
 * link opens the same view. Like the traveler it is the query string, written with `replaceState` (no history entry, no route change); a value equal to
 * its default is left out. A screen's keys are removed when it unmounts, so they never leak into the next route.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

const EVT = "gantry:urlstate";
const subscribe = (fn: () => void): (() => void) => {
  window.addEventListener(EVT, fn);
  window.addEventListener("popstate", fn);
  return () => { window.removeEventListener(EVT, fn); window.removeEventListener("popstate", fn); };
};
const snap = (): string => { try { return window.location.search; } catch { return ""; } };

export function setUrlParams(patch: Record<string, string | null | undefined>): void {
  write((p) => { for (const k of Object.keys(patch)) { const v = patch[k]; if (v == null || v === "") p.delete(k); else p.set(k, v); } });
}

function write(mutate: (q: URLSearchParams) => void): void {
  try {
    const u = new URL(window.location.href);
    mutate(u.searchParams);
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
    window.dispatchEvent(new Event(EVT));
  } catch { /* no history access: the state still works for this render only */ }
}

/** Reads and writes the given keys of the query string. `defaults` name the keys this screen owns and their default values. */
export function useUrlState<K extends string>(defaults: Record<K, string>): [Record<K, string>, (patch: Partial<Record<K, string>>) => void] {
  const search = useSyncExternalStore(subscribe, snap, () => "");
  const keys = useRef(Object.keys(defaults) as K[]);
  const def = useRef(defaults);
  const q = new URLSearchParams(search);
  const state = {} as Record<K, string>;
  for (const k of keys.current) state[k] = q.get(k) ?? def.current[k];
  const set = useCallback((patch: Partial<Record<K, string>>) => {
    write((p) => { for (const k of Object.keys(patch) as K[]) { const v = patch[k]; if (v == null || v === "" || v === def.current[k]) p.delete(k); else p.set(k, v); } });
  }, []);
  useEffect(() => {
    const ks = keys.current;
    return () => write((p) => { for (const k of ks) p.delete(k); });
  }, []);
  return [state, set];
}
