/**
 * Page state in the URL (rule F-15): tabs, filters, sort and page live in the query string next to the hash route
 * (`?tab=stuck&q=refund#inbox`), so a reload or a pasted link restores the same view. Writes use `replaceState` (no history
 * entry, no route change); readers re-render through a small event. The hash stays the route and is never touched here.
 */
import { useCallback, useSyncExternalStore } from "react";

const EVT = "gantry:urlstate";

const subscribe = (fn: () => void) => {
  window.addEventListener(EVT, fn);
  window.addEventListener("popstate", fn);
  window.addEventListener("hashchange", fn);
  return () => {
    window.removeEventListener(EVT, fn);
    window.removeEventListener("popstate", fn);
    window.removeEventListener("hashchange", fn);
  };
};
const snap = () => {
  try { return window.location.search; } catch { return ""; }
};

/** Writes (or, for an empty value, removes) query keys; notifies readers. */
export function writeQuery(patch: Record<string, string | null | undefined>): void {
  try {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
  } catch { /* a sandboxed frame without history access: the state still works, it is just not in the URL */ }
  window.dispatchEvent(new Event(EVT));
}

/** Goes to another route with its own query (`?tab=proposals` on Trust): the query is set first, then the hash changes. */
export function gotoWithQuery(route: string, query: Record<string, string>, project?: string | null): void {
  try {
    const u = new URL(window.location.href);
    u.search = "";
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    u.hash = project ? `#/p/${encodeURIComponent(project)}/${route}` : `#${route}`;
    window.history.pushState(null, "", u.href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch {
    window.location.hash = `#${route}`;
  }
}

/** One query key as state: `[value, set]`; the default is the empty value (kept out of the URL). */
export function useUrlParam(key: string, dflt = ""): [string, (v: string | null) => void] {
  const search = useSyncExternalStore(subscribe, snap, () => "");
  let value = dflt;
  try { value = new URLSearchParams(search).get(key) ?? dflt; } catch { /* default */ }
  const set = useCallback((v: string | null) => writeQuery({ [key]: v && v !== dflt ? v : null }), [key, dflt]);
  return [value, set];
}
