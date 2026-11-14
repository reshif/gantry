/** Which tab the traveler shows: module state like legacy `t.tab`, so a work order reopens where it was left and Conversation can be asked for. */
import { useSyncExternalStore } from "react";
import { TRAVELER_TABS, type TravelerTab } from "./model";

interface S {
  wo: string | null;
  tab: TravelerTab;
}
let s: S = { wo: null, tab: "journey" };
const subs = new Set<() => void>();
const set = (n: S): void => {
  s = n;
  subs.forEach((f) => f());
};
const isTab = (t: string | undefined): t is TravelerTab => !!t && (TRAVELER_TABS as readonly string[]).includes(t);

export function rememberTravelerOpen(woId: string, tab?: string): void {
  if (isTab(tab)) set({ wo: woId, tab });
  else if (s.wo !== woId) set({ wo: woId, tab: "journey" });
}
export function setTravelerTab(tab: TravelerTab): void {
  set({ ...s, tab });
}
export function useTravelerTab(): TravelerTab {
  return useSyncExternalStore((f) => {
    subs.add(f);
    return () => void subs.delete(f);
  }, () => s.tab);
}
/** Journey scrubber position (null = current), per work order. */
let scrub: { wo: string | null; i: number | null } = { wo: null, i: null };
const ssubs = new Set<() => void>();
export function setScrub(wo: string, i: number | null): void {
  scrub = { wo, i };
  ssubs.forEach((f) => f());
}
export function useScrub(wo: string): number | null {
  return useSyncExternalStore((f) => {
    ssubs.add(f);
    return () => void ssubs.delete(f);
  }, () => (scrub.wo === wo ? scrub.i : null));
}
