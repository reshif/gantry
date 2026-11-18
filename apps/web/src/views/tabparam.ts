import { navigate, useHash } from "../lib/router";

/** A screen's tab lives in the URL (`#evals/suites`): link-restorable, an unknown value falls back to the first tab. */
export function useTabParam<T extends string>(route: string, ids: readonly T[]): [T, (t: string) => void] {
  const hash = useHash();
  const tab = (hash.id === route && ids.includes(hash.param as T) ? hash.param : ids[0]) as T;
  return [tab, (t) => navigate(route, t)];
}
