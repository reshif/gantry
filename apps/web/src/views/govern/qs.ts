/** Query-string cleanup for the People and Access screens, kept apart from govern/kit so the shell can call it without pulling the whole kit into the entry. */
export const EVENT = "gantry-qs";

/** Screens that own each govern query prefix; any other screen drops the keys. */
const OWNERS: Record<string, string[]> = { "acc.": ["access"], "ppl.": ["people", "person"] };

/** Remove `acc.*` / `ppl.*` from the query string when the current route is not the one that owns them. */
export function clearGovernQS(routeId: string): void {
  const u = new URL(window.location.href);
  let hit = false;
  for (const k of Array.from(u.searchParams.keys())) {
    const owner = Object.entries(OWNERS).find(([pre]) => k.startsWith(pre));
    if (owner && !owner[1].includes(routeId)) {
      u.searchParams.delete(k);
      hit = true;
    }
  }
  if (!hit) return;
  window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  window.dispatchEvent(new Event(EVENT));
}
