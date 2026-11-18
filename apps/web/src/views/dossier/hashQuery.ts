/**
 * View state kept in the hash, the way the prototype addresses it: `#/p/payments/record/WO-2399?tab=gates`, `#/p/payments/changes/WO-2404?file=a.go`.
 * The router hands the part after the route id as one param; this splits the id from its query and writes changes back with replaceHash (no history entry).
 */
import { useCallback } from "react";
import { hashFor, replaceHash, useHash } from "../../lib/router";

export function splitQuery(param: string | null | undefined): { id: string; q: URLSearchParams } {
  const s = param ?? "";
  const i = s.indexOf("?");
  return i < 0 ? { id: s, q: new URLSearchParams() } : { id: s.slice(0, i), q: new URLSearchParams(s.slice(i + 1)) };
}

export function useHashQuery(name: string): [string | null, (v: string | null) => void] {
  const h = useHash();
  const { id, q } = splitQuery(h.param);
  const set = useCallback(
    (v: string | null) => {
      const next = new URLSearchParams(q);
      if (v) next.set(name, v);
      else next.delete(name);
      const qs = next.toString();
      replaceHash(hashFor(h.id, id || null, h.project) + (qs ? `?${qs}` : ""));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, h.id, h.project, id, q.toString()],
  );
  return [q.get(name), set];
}
