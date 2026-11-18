/**
 * Route state in the hash query (rule F-15), the prototype's form: `#/models?tab=prices`, `#/agents/ag-build?tab=versions`.
 * `useRouteTab` reads one key against a list of allowed values (an unknown value falls back to the default) and writes it
 * back as a history entry, so the back button walks through tabs and a pasted link restores the same tab.
 */
import { useCallback } from "react";
import { useHash } from "./router";

/** The hash without its query, e.g. `#/agents/ag-build`. */
export const hashPath = (hash: string): string => { const at = hash.indexOf("?"); return at < 0 ? hash : hash.slice(0, at); };

/** The hash with `key` set (or removed when `value` is null or empty), other keys kept. */
export function withQuery(hash: string, key: string, value: string | null): string {
  const at = hash.indexOf("?");
  const q = new URLSearchParams(at < 0 ? "" : hash.slice(at + 1));
  if (value) q.set(key, value); else q.delete(key);
  const s = q.toString();
  return (hashPath(hash) || "#") + (s ? `?${s}` : "");
}

export function setRouteQuery(key: string, value: string | null): void {
  const next = withQuery(window.location.hash, key, value);
  if (next !== window.location.hash) window.location.hash = next;
}

/** `[tab, setTab]` for `?<key>=`; the default tab keeps the URL clean. */
export function useRouteTab(allowed: readonly string[], def: string, key = "tab"): [string, (t: string) => void] {
  const { q } = useHash();
  const raw = q[key];
  const tab = raw && allowed.includes(raw) ? raw : def;
  const set = useCallback((t: string) => setRouteQuery(key, t === def ? null : t), [key, def]);
  return [tab, set];
}
