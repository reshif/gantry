import { useCallback, useEffect } from "react";
import Traveler from "../views/traveler";
import { rememberTravelerOpen } from "../views/traveler/state";
import { useUI } from "../ui/overlay-context";
import { travelerFromUrl } from "./travelerUrl";

/** Opens the work order traveler drawer (legacy G.openTraveler). `tab` picks a tab; without it a work order opens at Journey and the same one reopens where it was left. */
export function useOpenTraveler(): (woId: string, tab?: string) => void {
  const ui = useUI();
  return useCallback(
    (woId, tab) => {
      const id = String(woId || "").toUpperCase();
      rememberTravelerOpen(id, tab);
      ui.drawer.open(`wo:${id}`, (close) => <Traveler woId={id} onClose={close} />);
    },
    [ui],
  );
}

/** A pasted or reloaded link that names a traveler (`?traveler=WO-1005`) opens it once the shell is up. */
export function useRestoreTraveler(): void {
  const open = useOpenTraveler();
  useEffect(() => {
    const t = travelerFromUrl();
    if (!t) return;
    // After the shell's own URL redirect: a hash change closes the drawer, so the open waits a tick.
    const h = setTimeout(() => open(t.id, t.tab ?? undefined), 0);
    return () => clearTimeout(h);
    // once, on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
