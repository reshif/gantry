import { useCallback } from "react";
import Traveler from "../views/traveler";
import { useUI } from "../ui/overlay-context";

/** Opens the work order traveler drawer (legacy G.openTraveler). */
export function useOpenTraveler(): (woId: string) => void {
  const ui = useUI();
  return useCallback(
    (woId) => ui.drawer.open(`traveler:${woId}`, (close) => <Traveler woId={woId} onClose={close} />),
    [ui],
  );
}
