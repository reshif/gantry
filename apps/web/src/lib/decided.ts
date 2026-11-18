/**
 * Decisions this person made in this browser session, for the Inbox "Decided" tab. The server has no per-person list of decided approvals
 * (a backend gap), so this is session memory only and the tab says so.
 */
import { useSyncExternalStore } from "react";

export interface Decided {
  key: string;
  title: string;
  decision: "approved" | "rejected" | "changes";
  note: string;
  at: number;
}

let list: Decided[] = [];
const subs = new Set<() => void>();

export function recordDecision(d: Decided): void {
  list = [d, ...list.filter((x) => x.key !== d.key)];
  for (const fn of subs) fn();
}
export const clearDecided = (): void => { list = []; for (const fn of subs) fn(); };
export const useDecided = (): Decided[] => useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn); }; }, () => list, () => list);
