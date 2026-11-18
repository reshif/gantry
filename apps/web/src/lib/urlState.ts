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
/** The query string the page reads: `?tab=` before the hash, plus a prototype-style `?tab=` after it (`#/inbox?tab=stuck`), which wins. */
const snap = () => {
  try {
    const h = window.location.hash;
    const i = h.indexOf("?");
    if (i < 0) return window.location.search;
    const merged = new URLSearchParams(window.location.search);
    new URLSearchParams(h.slice(i + 1)).forEach((v, k) => merged.set(k, v));
    const out = merged.toString();
    return out ? `?${out}` : "";
  } catch { return ""; }
};

/** Writes (or, for an empty value, removes) query keys; notifies readers. */
export function writeQuery(patch: Record<string, string | null | undefined>): void {
  try {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
    // a `?` in the hash (a prototype-style link) would override what is written: the written keys leave it
    const i = u.hash.indexOf("?");
    if (i >= 0) {
      const hq = new URLSearchParams(u.hash.slice(i + 1));
      for (const k of Object.keys(patch)) hq.delete(k);
      const rest = hq.toString();
      u.hash = u.hash.slice(0, i) + (rest ? `?${rest}` : "");
    }
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
