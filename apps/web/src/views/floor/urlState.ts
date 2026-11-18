/** A view's own query-string state (rule F-15). It lives in the hash, next to the route (`#/p/payments/floor?view=board`), like the prototype's deep links. A plain `?x=y` before the hash is still read. */
import { useCallback, useEffect, useState } from "react";

const read = (name: string): string | null => {
  try {
    const h = window.location.hash;
    const qi = h.indexOf("?");
    const fromHash = qi < 0 ? null : new URLSearchParams(h.slice(qi + 1)).get(name);
    return fromHash ?? new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
};

/** Writes one key of the hash query with replaceState (no history entry, no route change). */
export function writeHashQuery(name: string, next: string | null): void {
  try {
    const h = window.location.hash;
    const qi = h.indexOf("?");
    const base = qi < 0 ? h : h.slice(0, qi);
    const q = new URLSearchParams(qi < 0 ? "" : h.slice(qi + 1));
    if (next) q.set(name, next);
    else q.delete(name);
    const qs = q.toString();
    const url = `${window.location.pathname}${window.location.search}${base}${qs ? `?${qs}` : ""}`;
    if (url !== `${window.location.pathname}${window.location.search}${h}`) window.history.replaceState(window.history.state, "", url);
  } catch {
    /* no history access: the state still works in memory */
  }
}

export function useQueryParam(name: string): [string | null, (v: string | null) => void] {
  const [v, setV] = useState<string | null>(() => read(name));
  useEffect(() => {
    const on = () => setV(read(name));
    window.addEventListener("hashchange", on);
    window.addEventListener("popstate", on);
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener("popstate", on);
    };
  }, [name]);
  const set = useCallback(
    (next: string | null) => {
      setV(next);
      writeHashQuery(name, next);
    },
    [name],
  );
  return [v, set];
}
