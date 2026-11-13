/**
 * Hash router matching the legacy app: `#home`, `#floor`, `#record/WO-1042`.
 * A route is `#<id>` optionally followed by `/<param>`. Unknown ids resolve to home.
 * (react-router is not used: its hash mode writes `#/path`, which would break legacy links.)
 */
import { useSyncExternalStore } from "react";

export interface RouteLocation {
  /** The raw id from the hash, "" when empty. */
  id: string;
  /** The segment after the id, decoded; null when absent. */
  param: string | null;
}

export function parseHash(hash: string): RouteLocation {
  const raw = hash.replace(/^#\/?/, "");
  const [head = "", ...rest] = raw.split("/");
  const tail = rest.join("/");
  let param: string | null = null;
  if (tail) {
    try {
      param = decodeURIComponent(tail);
    } catch {
      param = tail;
    }
  }
  return { id: head, param };
}

export function formatHash(id: string, param?: string | null): string {
  return param ? `#${id}/${encodeURIComponent(param)}` : `#${id}`;
}

const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};
const snapshot = () => window.location.hash;

/** Current location parsed from the hash. */
export function useHash(): RouteLocation {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  return parseHash(hash);
}

export function navigate(id: string, param?: string | null): void {
  const next = formatHash(id, param);
  if (window.location.hash === next) return;
  window.location.hash = next;
}

export function openRecordRoute(woId: string): void {
  navigate("record", woId);
}
