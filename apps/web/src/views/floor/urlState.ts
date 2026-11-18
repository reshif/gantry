/** A view's own query-string state (rule F-15): `?density=detail` next to the hash route, written with replaceState (no history entry). */
import { useCallback, useState } from "react";

const read = (name: string): string | null => {
  try {
    const fromSearch = new URLSearchParams(window.location.search).get(name);
    if (fromSearch !== null) return fromSearch;
    // a prototype deep link carries its state inside the hash: `#/security?tab=sessions`
    const at = window.location.hash.indexOf("?");
    return at < 0 ? null : new URLSearchParams(window.location.hash.slice(at + 1)).get(name);
  } catch {
    return null;
  }
};

export function useQueryParam(name: string): [string | null, (v: string | null) => void] {
  const [v, setV] = useState<string | null>(() => read(name));
  const set = useCallback(
    (next: string | null) => {
      setV(next);
      try {
        const u = new URL(window.location.href);
        if (next) u.searchParams.set(name, next);
        else u.searchParams.delete(name);
        if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
      } catch {
        /* no history access: the state still works in memory */
      }
    },
    [name],
  );
  return [v, set];
}
