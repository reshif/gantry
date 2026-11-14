import { useCallback } from "react";
import Traveler from "../views/traveler";
import { rememberTravelerOpen } from "../views/traveler/state";
import { useUI } from "../ui/overlay-context";

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
