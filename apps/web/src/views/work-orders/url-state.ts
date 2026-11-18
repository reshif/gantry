/**
 * Screen state in the URL (rule F-15): tabs, filters, sort and page of a list live in the query string next to the hash route, as
 * `?view=gate&st=running&q=retry`, so a reload or a pasted link shows the same list. It is written with `replaceState` (no history
 * entry, no route change) and removed again when the screen goes away, so it never leaks onto the next route.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

const EVENT = "gantry:urlstate";
const read = (): string => {
  try {
    return window.location.search;
  } catch {
    return "";
  }
};
const subscribe = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  window.addEventListener("popstate", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("popstate", fn);
  };
};

function write(mutate: (q: URLSearchParams) => void): void {
  try {
    const u = new URL(window.location.href);
    mutate(u.searchParams);
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
  } catch {
    /* a sandboxed frame: the screen still works, it is just not in the URL */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Reads and writes the named query keys. An empty value (or the key's default) removes the key. */
export function useUrlState<K extends string>(keys: readonly K[], defaults: Partial<Record<K, string>> = {}): [Record<K, string>, (patch: Partial<Record<K, string>>) => void] {
  const search = useSyncExternalStore(subscribe, read, () => "");
  const q = new URLSearchParams(search);
  const values = Object.fromEntries(keys.map((k) => [k, q.get(k) ?? defaults[k] ?? ""])) as Record<K, string>;
  const set = useCallback(
    (patch: Partial<Record<K, string>>) =>
      write((p) => {
        for (const [k, v] of Object.entries(patch) as Array<[K, string]>) {
          if (!v || v === (defaults[k] ?? "")) p.delete(k);
          else p.set(k, v);
        }
      }),
    // defaults are constants of the caller
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const sig = keys.join(",");
  // leaving the screen takes its keys out of the URL
  useEffect(() => () => write((p) => sig.split(",").forEach((k) => p.delete(k))), [sig]);
  return [values, set];
}
