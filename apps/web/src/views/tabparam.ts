import { useHash } from "../lib/router";
import { usePrefs } from "../lib/prefs";
import { useMe } from "../api/queries";

/** The prototype's tab link: `#/evals?tab=suites`. The router reads it as the route's param. */
export function tabHash(route: string, tab: string): string {
  return `#/${route}?tab=${encodeURIComponent(tab)}`;
}

export function navigateTab(route: string, tab: string): void {
  const next = tabHash(route, tab);
  if (window.location.hash !== next) window.location.hash = next;
}

/** A screen's tab lives in the URL (`#/evals?tab=suites`): link-restorable, an unknown value falls back to the first tab. */
export function useTabParam<T extends string>(route: string, ids: readonly T[]): [T, (t: string) => void] {
  const hash = useHash();
  const tab = (hash.id === route && ids.includes(hash.param as T) ? hash.param : ids[0]) as T;
  return [tab, (t) => navigateTab(route, t)];
}

/** The project chosen in the switcher (null = all lines) with its key, for the eyebrow and the ladder filter. */
export function useScope(): { id: string | null; key: string | null; kicker: string } {
  const id = usePrefs().project;
  const me = useMe();
  const p = id ? me?.projects.find((x) => x.id === id) : undefined;
  return { id: p ? p.id : null, key: p?.key ?? null, kicker: p?.key ?? "All lines" };
}
