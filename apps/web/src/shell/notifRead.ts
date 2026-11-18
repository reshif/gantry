/** The bell's unread dot: on until the drawer is opened, back when something newer arrives (in memory; the server keeps no read state). */
import { useSyncExternalStore } from "react";

let seen = "";
const subs = new Set<() => void>();
const sub = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

export const markNotificationsRead = (signature: string): void => {
  seen = signature;
  for (const fn of [...subs]) fn();
};
export const useSeenSignature = (): string => useSyncExternalStore(sub, () => seen);
