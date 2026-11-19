/** A view's own query state (rule F-15). It lives in the hash after the route (`#/p/payments/floor?view=board`), so a link restores it; an older link that carries it before the hash (`?view=board#/...`) is still read. */
import { useCallback, useEffect, useState } from "react";

const read = (name: string): string | null => {
  try {
    const h = window.location.hash;
    const qi = h.indexOf("?");
    const fromHash = qi < 0 ? null : new URLSearchParams(h.slice(qi + 1)).get(name);
    if (fromHash !== null) return fromHash;
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
};

/** Writes one key of the query into the hash (`#/floor?view=board`) with replaceState (no history entry, no route change). An older copy of the key before the hash is dropped so the two never disagree. */
export function writeHashQuery(name: string, next: string | null): void {
  try {
    const h = window.location.hash;
    const qi = h.indexOf("?");
    const base = (qi < 0 ? h : h.slice(0, qi)) || "#"; // a bare address still gets a hash to hold the query
    const hq = new URLSearchParams(qi < 0 ? "" : h.slice(qi + 1));
    if (next) hq.set(name, next);
    else hq.delete(name);
    const hqs = hq.toString();
    const sq = new URLSearchParams(window.location.search);
    sq.delete(name);
    const sqs = sq.toString();
    const url = `${window.location.pathname}${sqs ? `?${sqs}` : ""}${base}${hqs ? `?${hqs}` : ""}`;
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
