/**
 * URL state for tabs, filters, sort and paging (rule F-15): the values live in the query string next to the hash route
 * (`?tab=guardrails&station=build#agents/ag-build`), so a reload or a pasted link restores the view. Writing uses `replaceState`
 * (no history entry, no `hashchange`). A value equal to its default is left out of the URL. A route change clears every key a
 * screen has registered, so `?station=` on Agents never leaks onto Skills.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

const EVENT = "gantry:routestate";
const managed = new Set<string>();
let installed = false;

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("hashchange", (e) => {
    try {
      // an event whose old and new fragments are the same navigated nowhere (`location.hash = ""` on a URL with no fragment): keep the state
      if (e.oldURL && e.newURL && new URL(e.oldURL).hash === new URL(e.newURL).hash) return;
      const u = new URL(window.location.href);
      let changed = false;
      for (const k of managed) if (u.searchParams.has(k)) { u.searchParams.delete(k); changed = true; }
      if (changed) { window.history.replaceState(window.history.state, "", u.href); window.dispatchEvent(new Event(EVENT)); }
    } catch { /* no history access: the state just stays */ }
  });
}

const subscribe = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  window.addEventListener("popstate", fn);
  return () => { window.removeEventListener(EVENT, fn); window.removeEventListener("popstate", fn); };
};
/** The hash's own query (`#agents/ag-build?tab=tools`, the prototype's link shape), "" when none. */
const hashSearch = (): string => { const h = window.location.hash, i = h.indexOf("?"); return i >= 0 ? h.slice(i) : ""; };
const snapshot = (): string => { try { return window.location.search + "\u0000" + hashSearch(); } catch { return ""; } };

/** Reads `defaults` keys from the query string and returns a setter that writes them back. */
export function useRouteState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void] {
  install();
  const search = useSyncExternalStore(subscribe, snapshot, () => "");
  const keys = Object.keys(defaults);
  for (const k of keys) managed.add(k);
  const defRef = useRef(defaults);
  defRef.current = defaults;
  const [qs = "", hs = ""] = search.split("\u0000");
  const params = new URLSearchParams(qs);
  new URLSearchParams(hs).forEach((v, k) => params.set(k, v));
  const value = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? defaults[k]])) as T;
  const set = useCallback((patch: Partial<T>) => {
    try {
      const hi = window.location.hash.indexOf("?");
      if (hi >= 0) {
        // A link in the hash carries its state there: keep it in the hash so the two never disagree.
        const hp = new URLSearchParams(window.location.hash.slice(hi + 1));
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === "" || v === defRef.current[k]) hp.delete(k);
          else hp.set(k, v as string);
        }
        const u2 = new URL(window.location.href);
        u2.hash = window.location.hash.slice(0, hi) + (hp.toString() ? `?${hp.toString()}` : "");
        if (u2.href === window.location.href) return;
        window.history.replaceState(window.history.state, "", u2.href);
        window.dispatchEvent(new Event(EVENT));
        return;
      }
      const u = new URL(window.location.href);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "" || v === defRef.current[k]) u.searchParams.delete(k);
        else u.searchParams.set(k, v as string);
      }
      if (u.href === window.location.href) return;
      window.history.replaceState(window.history.state, "", u.href);
      window.dispatchEvent(new Event(EVENT));
    } catch { /* a sandboxed frame without history access */ }
  }, []);
  return [value, set];
}

/** A text box value that is shown at once and written to the URL after `ms` of quiet (the prototype debounces search at 140 ms). */
export function useDebouncedParam(value: string, write: (v: string) => void, ms = 140): [string, (v: string) => void] {
  const [local, setLocal] = useState(value);
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setLocal(value); } }, [value]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (v: string): void => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { last.current = v; write(v); }, ms);
  };
  return [local, change];
}
