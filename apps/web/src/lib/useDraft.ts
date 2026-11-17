/**
 * Editing without silently reverting a colleague's change.
 *
 * `useDraft` keeps a draft of one entity next to the server copy it was started from (`base`, at `baseRev`).
 *  - Saving sends ONLY the keys this person changed (draft vs base), with the revision they loaded as If-Match.
 *    A key nobody here touched is never in the patch, so it cannot overwrite someone else's edit.
 *  - When the server copy moves on while a draft is open: keys the person did not touch follow the server;
 *    if they edited a key that also changed remotely, `conflict` lists it and save is refused until they choose
 *    `keepMine()` (their value wins, rebased on the new revision) or `discard()` (take the latest).
 *  - A 409/412 from the server (a race) puts the draft in the same conflict state and asks for a refresh.
 * Drafts live in a module store keyed by scope and id, so they survive switching tabs and screens.
 * The session reset must call `clearDrafts()` (sign-out and user switch).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { ApiResult } from "../api/client";

export type Rev = number | string | null | undefined;
type Result = ApiResult;

interface Entry {
  values: Record<string, unknown>;
  base: Record<string, unknown>;
  baseRev: Rev;
  /** The server refused the last save as stale (409/412). */
  rejected: boolean;
  saving: boolean;
}

const store = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const notify = (): void => {
  version++;
  for (const l of [...listeners]) l();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const keyOf = (scope: string, id: string): string => `${scope}\u0000${id}`;

const clone = <V,>(v: V): V => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as V));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Drop one draft (or every draft in a scope). */
export function dropDraft(scope: string, id?: string): void {
  if (id !== undefined) store.delete(keyOf(scope, id));
  else for (const k of [...store.keys()]) if (k.startsWith(`${scope}\u0000`)) store.delete(k);
  notify();
}
/** Forget every draft: sign-out and user switch. */
export function clearDrafts(): void {
  store.clear();
  notify();
}
export const hasDraft = (scope: string, id: string): boolean => store.has(keyOf(scope, id));

const changedOf = (e: Entry): string[] => Object.keys(e.values).filter((k) => !same(e.values[k], e.base[k]));

/** Bring an entry in line with the latest server copy. Returns the keys that changed on both sides (with different values). */
function sync(e: Entry, server: Record<string, unknown>, rev: Rev): string[] {
  const changed = changedOf(e);
  const behind = e.baseRev !== rev || Object.keys(server).some((k) => !same(e.base[k], server[k]));
  if (!behind) return [];
  if (!changed.length) {
    e.values = clone(server);
    e.base = clone(server);
    e.baseRev = rev;
    e.rejected = false;
    return [];
  }
  const overlap = changed.filter((k) => !same(e.base[k], server[k]) && !same(e.values[k], server[k]));
  if (overlap.length) return overlap;
  for (const k of Object.keys(server)) if (!changed.includes(k) || same(e.values[k], server[k])) e.values[k] = clone(server[k]);
  e.base = clone(server);
  e.baseRev = rev;
  e.rejected = false;
  return [];
}

export interface UseDraftOptions<T extends Record<string, unknown>> {
  scope: string;
  id: string;
  /** The editable fields as the server has them now. A new object each render is fine. */
  server: T;
  /** The server's current revision of the entity (sent back as If-Match). */
  rev: Rev;
  /** Sends the changed keys. `ifMatch` is the revision to send. Must return the command result. */
  save: (patch: Partial<T>, ifMatch: number | string | undefined) => Promise<Result>;
  /** Called after a 409/412 so the entity is read again. */
  refresh?: () => void;
}

export interface DraftConflict {
  /** Keys edited here that also changed on the server. Empty when the server only rejected the save as stale. */
  keys: string[];
}

export interface UseDraft<T extends Record<string, unknown>> {
  /** The live draft object. Sub-forms may mutate it inside `edit`. */
  values: T;
  edit: (fn: (values: T) => void) => void;
  set: <K extends keyof T>(key: K, value: T[K]) => void;
  dirty: boolean;
  changedKeys: string[];
  conflict: DraftConflict | null;
  saving: boolean;
  /** Sends only the changed keys. Resolves null when there is nothing to save or a save is running. */
  save: () => Promise<Result | null>;
  /** Keep my value for every conflicting key and rebase on the latest server copy. */
  keepMine: () => void;
  /** Throw the draft away and show the server copy. */
  discard: () => void;
}

export function useDraft<T extends Record<string, unknown>>(o: UseDraftOptions<T>): UseDraft<T> {
  useSyncExternalStore(subscribe, () => version, () => 0);
  const k = keyOf(o.scope, o.id);
  let e = store.get(k);
  if (!e) {
    e = { values: clone(o.server), base: clone(o.server), baseRev: o.rev, rejected: false, saving: false };
    store.set(k, e);
  }
  const overlap = sync(e, o.server, o.rev);
  const changedKeys = changedOf(e);
  const conflict: DraftConflict | null = overlap.length ? { keys: overlap } : e.rejected ? { keys: [] } : null;

  const { scope, id, save: saveFn, refresh } = o;
  const server = o.server;
  const rev = o.rev;

  const edit = useCallback((fn: (v: T) => void) => {
    const cur = store.get(keyOf(scope, id));
    if (!cur) return;
    fn(cur.values as T);
    notify();
  }, [scope, id]);
  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => edit((v) => void (v[key] = value)), [edit]);

  const save = async (): Promise<Result | null> => {
    const cur = store.get(keyOf(scope, id));
    if (!cur || cur.saving) return null;
    const keys = changedOf(cur);
    if (!keys.length) return null;
    if (conflict) return { ok: false, status: 409, kind: "conflict", msg: "Someone changed this while you were editing. Keep your version or load theirs before saving." };
    const patch: Record<string, unknown> = {};
    for (const key of keys) patch[key] = clone(cur.values[key]);
    cur.saving = true;
    notify();
    let r: Result;
    try {
      r = await saveFn(patch as Partial<T>, rev ?? undefined);
    } finally {
      cur.saving = false;
    }
    if (r.ok) {
      cur.base = clone(cur.values);
      cur.baseRev = rev;
      cur.rejected = false;
    } else if (r.status === 409 || r.status === 412) {
      cur.rejected = true;
      refresh?.();
    }
    notify();
    return r;
  };

  const keepMine = (): void => {
    const cur = store.get(keyOf(scope, id));
    if (!cur) return;
    const mine = changedOf(cur);
    for (const key of Object.keys(server)) if (!mine.includes(key)) cur.values[key] = clone(server[key]);
    cur.base = clone(server);
    cur.baseRev = rev;
    cur.rejected = false;
    notify();
  };
  const discard = (): void => dropDraft(scope, id);

  return { values: e.values as T, edit, set, dirty: changedKeys.length > 0, changedKeys, conflict, saving: e.saving, save, keepMine, discard };
}
