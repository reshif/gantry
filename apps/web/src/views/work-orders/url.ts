/**
 * The work orders list keeps its tab, view, filters, sort and page in the URL (rule F-15): `?view=board&tab=mine&state=waiting&station=intake&page=2`
 * after the hash route (`#/work-orders?view=board`, as the prototype writes it; a query before the hash is still read), so a reload, a pasted link or a link from another screen (`?station=`, `?state=`) opens the same list.
 * Written with replaceState (no history entry, no hashchange); a value equal to its default is left out of the address.
 */
import { useCallback, useState } from "react";

const readAll = (keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  try {
    // The prototype's address is `#/work-orders?view=board`; a query before the hash (older links) still works.
    const h = window.location.hash;
    const hq = new URLSearchParams(h.includes("?") ? h.slice(h.indexOf("?") + 1) : "");
    const q = new URLSearchParams(window.location.search);
    for (const k of keys) { const v = hq.get(k) ?? q.get(k); if (v !== null) out[k] = v; }
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
      const h = u.hash;
      const at = h.indexOf("?");
      const route = at < 0 ? h : h.slice(0, at);
      const hq = new URLSearchParams(at < 0 ? "" : h.slice(at + 1));
      // Values written by an older link (before the hash) move into the hash on the first change.
      for (const k of keys) { const old = u.searchParams.get(k); if (old !== null) { if (!hq.has(k)) hq.set(k, old); u.searchParams.delete(k); } }
      for (const [k, v] of Object.entries(patch) as Array<[K, string | undefined]>) {
        if (v === undefined || v === defaults[k]) hq.delete(k);
        else hq.set(k, v);
      }
      const qs = hq.toString();
      u.hash = qs ? `${route}?${qs}` : route;
      if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
    } catch { /* the state still works in memory */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [state, set];
}
