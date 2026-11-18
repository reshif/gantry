/**
 * URL state for the Portfolio screens (rule F-15): tabs, filters, sort and layout live in the query string next to the hash route
 * (`?tab=members`, `?q=pay&st=halted&view=cards`), so a reload or a pasted link opens the same view. Writing uses `replaceState`
 * (no history entry, no `hashchange`). Defaults are never written, so a clean URL means the default view.
 */
import { useCallback, useSyncExternalStore } from "react";

const EVT = "gantry:qs";
const subscribe = (fn: () => void) => {
  window.addEventListener("popstate", fn);
  window.addEventListener("hashchange", fn);
  window.addEventListener(EVT, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener("hashchange", fn);
    window.removeEventListener(EVT, fn);
  };
};
/** The query after the route inside the hash (`#/project-config/storefront?tab=members`), the prototype's link form. */
const hashQuery = (): string => {
  try {
    const h = window.location.hash;
    const i = h.indexOf("?");
    return i < 0 ? "" : h.slice(i + 1);
  } catch {
    return "";
  }
};
/** `location.search` and the hash's query as one string; the hash's keys win when both name one. */
const snapshot = (): string => {
  try {
    const hq = hashQuery();
    if (!hq) return window.location.search;
    const m = new URLSearchParams(window.location.search);
    for (const [k, v] of new URLSearchParams(hq)) m.set(k, v);
    const s = m.toString();
    return s ? `?${s}` : "";
  } catch {
    return "";
  }
};

/** Writes the given keys (null or "" removes one) and tells every subscriber. */
export function writeParams(patch: Record<string, string | null>): void {
  try {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    // a query inside the hash is the same state: writing a key moves it to the search so there is one place for it
    const hi = u.hash.indexOf("?");
    if (hi >= 0) {
      const hq = new URLSearchParams(u.hash.slice(hi + 1));
      for (const k of Object.keys(patch)) hq.delete(k);
      const rest = hq.toString();
      u.hash = u.hash.slice(0, hi) + (rest ? `?${rest}` : "");
    }
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
  } catch {
    /* a sandboxed frame without history access: the view still works, it is just not in the URL */
  }
  window.dispatchEvent(new Event(EVT));
}

/** The query string as a URLSearchParams, re-read whenever it is written, plus a setter. */
export function useParams(): [URLSearchParams, (patch: Record<string, string | null>) => void] {
  const search = useSyncExternalStore(subscribe, snapshot, () => "");
  const set = useCallback((patch: Record<string, string | null>) => writeParams(patch), []);
  return [new URLSearchParams(search), set];
}

/** One parameter with a default and an optional allow-list; anything else reads as the default. */
export function useParam(key: string, dflt: string, allowed?: readonly string[]): [string, (v: string) => void] {
  const [p, set] = useParams();
  const raw = p.get(key);
  const v = raw !== null && (!allowed || allowed.includes(raw)) ? raw : dflt;
  return [v, (n: string) => set({ [key]: n === dflt ? null : n })];
}
