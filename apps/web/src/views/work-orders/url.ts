/**
 * The work orders list keeps its tab, view, filters, sort and page in the URL (rule F-15): `?view=board&tab=mine&state=waiting&station=intake&page=2`
 * next to the hash route, so a reload, a pasted link or a link from another screen (`?station=`, `?state=`) opens the same list.
 * Written with replaceState (no history entry, no hashchange); a value equal to its default is left out of the address.
 */
import { useCallback, useState } from "react";

const readAll = (keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  try {
    const q = new URLSearchParams(window.location.search);
    for (const k of keys) { const v = q.get(k); if (v !== null) out[k] = v; }
  } catch { /* no location access: defaults */ }
  return out;
};

export function useUrlState<K extends string>(defaults: Record<K, string>): [Record<K, string>, (patch: Partial<Record<K, string>>) => void] {
  const keys = Object.keys(defaults);
  const [state, setState] = useState<Record<K, string>>(() => ({ ...defaults, ...readAll(keys) }));
  const set = useCallback((patch: Partial<Record<K, string>>) => {
    setState((prev) => ({ ...prev, ...patch }));
    try {
      const u = new URL(window.location.href);
      for (const [k, v] of Object.entries(patch) as Array<[K, string | undefined]>) {
        if (v === undefined || v === defaults[k]) u.searchParams.delete(k);
        else u.searchParams.set(k, v);
      }
      if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
    } catch { /* the state still works in memory */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [state, set];
}
