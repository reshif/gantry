/** A view's own query-string state (rule F-15). It lives in the query before the hash (`?view=board`); a prototype deep link that carries it after the route (`#/p/payments/floor?view=board`) is read too. */
import { useCallback, useEffect, useState } from "react";

const read = (name: string): string | null => {
  try {
    const h = window.location.hash;
    const qi = h.indexOf("?");
    const fromSearch = new URLSearchParams(window.location.search).get(name);
    if (fromSearch !== null) return fromSearch;
    // a prototype deep link carries its state inside the hash: `#/security?tab=sessions`
    return qi < 0 ? null : new URLSearchParams(h.slice(qi + 1)).get(name);
  } catch {
    return null;
  }
};

/** Writes one key of the query (`?view=board`, before the hash) with replaceState (no history entry, no route change). A value the address carried in the hash query (`#/floor?view=board`) is dropped from there so the two never disagree. */
export function writeHashQuery(name: string, next: string | null): void {
  try {
    const h = window.location.hash;
    const qi = h.indexOf("?");
    const base = qi < 0 ? h : h.slice(0, qi);
    const hq = new URLSearchParams(qi < 0 ? "" : h.slice(qi + 1));
    hq.delete(name);
    const hqs = hq.toString();
    const sq = new URLSearchParams(window.location.search);
    if (next) sq.set(name, next);
    else sq.delete(name);
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
