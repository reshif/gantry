/**
 * Tabs, filters and sort in the URL (rule F-15): `?tab=sessions&cat=access` next to the hash route, so a reload or a pasted link
 * shows the same screen. Like the open traveler, it is a query string written with `replaceState` (no history entry). A route change
 * (a `hashchange`) clears the keys a screen registered, so a filter never leaks into the next screen.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { parseHash } from "./router";

const EVT = "gantry:querystate";
const subscribe = (fn: () => void) => {
  window.addEventListener(EVT, fn);
  window.addEventListener("popstate", fn);
  return () => {
    window.removeEventListener(EVT, fn);
    window.removeEventListener("popstate", fn);
  };
};
const snapshot = (): string => {
  try {
    return window.location.search;
  } catch {
    return "";
  }
};

function write(mutate: (q: URLSearchParams) => void): void {
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
  const set = useCallback((patch: Partial<Record<K, string | null>>) => write((p) => { for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v as string); else p.delete(k); } }), []);
  const clear = useCallback((except: readonly K[] = []) => write((p) => { for (const k of keys) if (!except.includes(k)) p.delete(k); }), [keys]);
  useEffect(() => {
    const route = parseHash(window.location.hash).id;
    const onHash = () => { if (parseHash(window.location.hash).id !== route) write((p) => { for (const k of keys) p.delete(k); }); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [keys]);
  return { values, set, clear };
}
