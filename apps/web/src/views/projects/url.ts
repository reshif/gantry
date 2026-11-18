/**
 * URL state for the Portfolio screens (rule F-15): tabs, filters, sort and layout live in the query string next to the hash route
 * (`?tab=members`, `?q=pay&st=halted&view=cards`), so a reload or a pasted link opens the same view. Writing uses `replaceState`
 * (no history entry, no `hashchange`). Defaults are never written, so a clean URL means the default view.
 */
import { useCallback, useSyncExternalStore } from "react";

const EVT = "gantry:qs";
const subscribe = (fn: () => void) => {
  window.addEventListener("popstate", fn);
  window.addEventListener(EVT, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(EVT, fn);
  };
};
const snapshot = (): string => {
  try {
    return window.location.search;
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
