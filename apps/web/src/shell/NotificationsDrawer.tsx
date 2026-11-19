/** The bell's right-hand drawer (prototype notesDrawer): gate requests with Review, recent events, and the two footer actions. */
import { Suspense, lazy, useSyncExternalStore } from "react";
import type { useUI } from "../ui/overlay-context";

// The drawer's list loads when it is first opened.
const NotificationsBody = lazy(() => import("./NotificationsBody").then((m) => ({ default: m.NotificationsBody })));

/** Local read marker: how many waiting items the person has already seen. Cleared by opening the drawer; never sent anywhere. */
let seen = 0;
const listeners = new Set<() => void>();
export const markSeen = (n: number) => {
  seen = n;
  listeners.forEach((l) => l());
};
/** Number of waiting items not yet seen in the drawer. */
export function useUnread(waiting: number): number {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => void listeners.delete(l); }, () => seen);
  return Math.max(0, waiting - s);
}

export function openNotifications(ui: ReturnType<typeof useUI>, waiting: number): void {
  markSeen(waiting);
  ui.drawer.open("notifications", (close) => (
    <Suspense fallback={null}>
      <NotificationsBody close={close} />
    </Suspense>
  ));
}
