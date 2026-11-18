/**
 * Route state lives in the hash (rule F-15). A few screens keep their state in `location.search` (`?tab=budget#project-config`);
 * that query belongs to the screen that wrote it, so when the route changes it is dropped instead of riding along to the next
 * screen (`/v3/?tab=budget#models`). A deep link that opens with its own query is kept until the person navigates away.
 */
import { useEffect } from "react";
import { parseHash } from "./router";

const routeKey = (): string => { const r = parseHash(window.location.hash); return `${r.project ?? ""}|${r.id}`; };

export function useDropStaleSearch(): void {
  useEffect(() => {
    let prev = routeKey();
    const on = () => {
      const next = routeKey();
      if (next === prev) return;
      prev = next;
      if (!window.location.search) return;
      try { window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.hash}`); } catch { /* no history access */ }
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
}
