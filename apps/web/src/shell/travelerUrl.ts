/**
 * The open traveler is part of the URL (rule F-15): `?traveler=WO-1005&ttab=history` next to the hash route, so a reload or a pasted link opens the same drawer.
 * It is a query string, not a hash segment: the hash is the route, and a route change closes the drawer. Writing it uses `replaceState` (no history entry, no `hashchange`).
 */
const WO = "traveler";
const TAB = "ttab";

export function travelerFromUrl(): { id: string; tab: string | null } | null {
  try {
    const q = new URLSearchParams(window.location.search);
    const id = q.get(WO);
    return id && /^[A-Za-z0-9_.-]{1,64}$/.test(id) ? { id: id.toUpperCase(), tab: q.get(TAB) } : null;
  } catch {
    return null;
  }
}

function write(mutate: (q: URLSearchParams) => void): void {
  try {
    // Only the query string changes: the rest of the URL (the hash route, even an empty `#`) is kept exactly as it is, so nothing sees a route change.
    const u = new URL(window.location.href);
    mutate(u.searchParams);
    if (u.href === window.location.href) return;
    window.history.replaceState(window.history.state, "", u.href);
  } catch {
    /* a sandboxed frame without history access: the drawer still works, it is just not in the URL */
  }
}

export const writeTravelerUrl = (id: string, tab: string | null): void => write((q) => { q.set(WO, id); if (tab) q.set(TAB, tab); else q.delete(TAB); });
/** Removes the traveler from the URL, but only if it still names this work order (a newer drawer may already have written its own). */
export const clearTravelerUrl = (id: string): void => write((q) => { if ((q.get(WO) ?? "").toUpperCase() === id.toUpperCase()) { q.delete(WO); q.delete(TAB); } });
