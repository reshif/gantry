/**
 * The last breadcrumb item for a detail page. A page that shows one record (an agent, a skill) calls `useCrumbTail(name)`; the shell appends it to the
 * breadcrumb. It clears itself when the page unmounts or the name goes away.
 */
import { useEffect, useSyncExternalStore } from "react";

let tail: string | null = null;
const listeners = new Set<() => void>();
const set = (next: string | null): void => {
  if (tail === next) return;
  tail = next;
  listeners.forEach((l) => l());
};

export function useCrumbTail(name: string | null | undefined): void {
  useEffect(() => {
    set(name ?? null);
    return () => set(null);
  }, [name]);
}

export const useCrumbTailValue = (): string | null => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => tail, () => null);
