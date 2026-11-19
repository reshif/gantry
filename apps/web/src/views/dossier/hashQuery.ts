/**
 * View state kept in the hash, the way the prototype addresses it: `#/p/payments/record/WO-2399?tab=gates`, `#/p/payments/changes/WO-2404?file=a.go`.
 * The router parses the query into `q` and leaves the route's param clean; this writes changes back with replaceHash (no history entry).
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
  const qs0 = new URLSearchParams(h.q).toString();
  const set = useCallback(
    (v: string | null) => {
      const next = new URLSearchParams(qs0);
      if (v) next.set(name, v);
      else next.delete(name);
      const qs = next.toString();
      replaceHash(hashFor(h.id, h.param, h.project) + (qs ? `?${qs}` : ""));
    },
    [name, h.id, h.project, h.param, qs0],
  );
  return [new URLSearchParams(h.q).get(name), set];
}
