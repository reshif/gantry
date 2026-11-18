/**
 * View state in the URL (rule F-15): `?tab=access&q=meera`, next to the hash route. Writing uses `replaceState` (no history entry, no `hashchange`),
 * so a reload or a pasted link restores the same tab, filter, sort and page. A default value is never written (clean URLs).
 */
import { useCallback, useEffect, useState } from "react";

const EVENT = "gantry:urlstate";

const read = (key: string): string | null => {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
};

export function writeUrlState(patch: Record<string, string | null>): void {
  try {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
  } catch {
    /* a sandboxed frame without history access: the state still works, it is just not in the URL */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** `[value, set]` for one query-string key; `def` is the value when the key is absent and is never written. */
export function useUrlState(key: string, def: string): [string, (v: string) => void] {
  const [v, setV] = useState<string>(() => read(key) ?? def);
  useEffect(() => {
    const sync = (): void => setV(read(key) ?? def);
    window.addEventListener(EVENT, sync);
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    sync();
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [key, def]);
  const set = useCallback((next: string) => writeUrlState({ [key]: next === def ? null : next }), [key, def]);
  return [v, set];
}
