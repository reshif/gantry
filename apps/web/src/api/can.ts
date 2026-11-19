/**
 * Display-only permission cache (spec 15.1). `useCan(action, ctx)` answers from a per-session
 * cache; misses are collected in a microtask and sent as one POST /api/v1/can. The server decides
 * every command; this only lets controls render disabled with a reason. The cache is cleared when
 * matrix, policies, people (and the other decision inputs) change, and when the session changes.
 */
import { useSyncExternalStore } from "react";
import { ApiError, api, post } from "./client";
import { onCanInvalidated } from "./keys";
import { usePrefs } from "../lib/prefs";
import type { CanCheck, CanResult } from "./types";

export interface CanContext {
  project?: string | null | undefined;
  repo?: string | null | undefined;
  time?: number | undefined;
}

/** Shown on a control whose only blocker is the step-up rail: it stays usable and the command asks for a fresh sign-in. */
export const STEP_UP_HINT = "You'll be asked to sign in again to confirm.";

/**
 * A decision whose only blocker is `needs: "step_up"` is not a denial: the person may do it after a fresh sign-in, and api/client routes the
 * refused command to ui/stepup, which prompts and retries. So the control stays enabled (the server still decides every command).
 */
export function softenStepUp(r: CanResult): CanResult {
  return !r.allowed && r.needs === "step_up" ? { ...r, allowed: true, reason: STEP_UP_HINT, needs: "step_up" } : r;
}

/** Before the server answers a control stays usable-looking but unresolved. */
export const PENDING: CanResult = { allowed: true, reason: "", needs: "" };

export function canKey(session: string, check: CanCheck): string {
  return JSON.stringify([session, check.action, check.project ?? null, check.repo ?? null, check.time ?? null]);
}

type Sender = (checks: CanCheck[]) => Promise<CanResult[] | null>;

async function defaultSender(checks: CanCheck[]): Promise<CanResult[] | null> {
  const r = await post<{ results: CanResult[] }>(api("can"), { checks });
  return r.ok && Array.isArray(r.results) ? r.results : null;
}

export class CanBatcher {
  private cache = new Map<string, CanResult>();
  private pending = new Map<string, CanCheck>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();
  private scheduled = false;
  private epoch = 0;
  private session = "";
  private version = 0;
  batches = 0;

  constructor(private send: Sender = defaultSender) {}

  setSession(id: string | null): void {
    const next = id ?? "";
    if (next === this.session) return;
    this.session = next;
    this.reset(); // silent: called during render, and every consumer re-renders with the new session anyway
  }

  /** Drop cached decisions; subscribers re-request what they still show. */
  clear(): void {
    this.reset();
    this.emit();
  }

  private reset(): void {
    this.epoch++;
    this.cache.clear();
    this.pending.clear();
    this.inflight.clear();
  }

  /** Cached answer, or null after queueing the check for the next microtask batch. */
  peek(check: CanCheck): CanResult | null {
    const key = canKey(this.session, check);
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (!this.inflight.has(key) && !this.pending.has(key)) {
      this.pending.set(key, check);
      this.schedule();
    }
    return null;
  }

  /** The decision, waiting for the batch when it is not cached yet. */
  ask(check: CanCheck): Promise<CanResult> {
    const hit = this.peek(check);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        const r = this.get(check);
        if (r) {
          off();
          resolve(r);
        } else if (!this.pending.has(canKey(this.session, check)) && !this.inflight.has(canKey(this.session, check))) this.peek(check); // cleared meanwhile: ask again
      });
    });
  }

  get(check: CanCheck): CanResult | null {
    return this.cache.get(canKey(this.session, check)) ?? null;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => void this.flush());
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    if (!this.pending.size) return;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    const epoch = this.epoch;
    for (const [k] of entries) this.inflight.add(k);
    this.batches++;
    const results = await this.send(entries.map(([, c]) => c));
    if (epoch !== this.epoch) return; // invalidated while in flight: the answers are stale
    for (const [k] of entries) this.inflight.delete(k);
    if (results && results.length === entries.length) {
      entries.forEach(([k], i) => {
        const r = results[i];
        if (r) this.cache.set(k, softenStepUp(r));
      });
    } else {
      // The server did not answer: show locked rather than guess "allowed" for a control.
      for (const [k] of entries) this.cache.set(k, { allowed: false, reason: "Permissions could not be checked. Try again.", needs: "" });
      setTimeout(() => {
        if (epoch === this.epoch) for (const [k] of entries) this.cache.delete(k);
      }, 5000);
    }
    this.emit();
  }
}

export const canBatcher = new CanBatcher();
onCanInvalidated(() => canBatcher.clear());

const VIEW_AS_LOCK = "Your role is read-only for this action.";
const READ_ACTION = /\.(view|read)$/;

/**
 * "View as" preview: a person can look at the sheet as a less privileged role. It only ever takes rights away from the
 * server's decision, never adds one, and the server still decides every command.
 */
export function previewDecision(action: string, r: CanResult, viewAs: "" | "approver" | "viewer"): CanResult {
  if (!viewAs || !r.allowed) return r;
  const read = READ_ACTION.test(action);
  const deny =
    viewAs === "viewer"
      ? !read || /^(policy|audit)\./.test(action)
      : !read && /^(people|policy|security|integration|api|mcp|agent|model|flow|kill|halt|line|restore)/.test(action);
  return deny ? { allowed: false, reason: VIEW_AS_LOCK, needs: "" } : r;
}

/** Decision for one action. Returns PENDING-allowed shape until the batch answers, with `pending: true`. */
export function useCan(action: string, ctx: CanContext = {}): CanResult & { pending: boolean } {
  const viewAs = usePrefs().viewAs;
  useSyncExternalStore(canBatcher.subscribe, canBatcher.snapshot);
  const check: CanCheck = { action };
  if (ctx.project) check.project = ctx.project;
  if (ctx.repo) check.repo = ctx.repo;
  if (ctx.time !== undefined) check.time = ctx.time;
  const r = canBatcher.peek(check);
  return r ? { ...previewDecision(action, r, viewAs), pending: false } : { ...PENDING, pending: true };
}

/** Several checks at once (e.g. a toolbar). Results are in the order asked. */
export function useCanMany(checks: Array<{ action: string } & CanContext>, opts: { raw?: boolean } = {}): Array<CanResult & { pending: boolean }> {
  useSyncExternalStore(canBatcher.subscribe, canBatcher.snapshot);
  const pref = usePrefs().viewAs;
  const viewAs = opts.raw ? "" : pref;
  return checks.map((c) => {
    const check: CanCheck = { action: c.action };
    if (c.project) check.project = c.project;
    if (c.repo) check.repo = c.repo;
    if (c.time !== undefined) check.time = c.time;
    const r = canBatcher.peek(check);
    return r ? { ...previewDecision(c.action, r, viewAs), pending: false } : { ...PENDING, pending: true };
  });
}

/** Keeps the cache keyed to the signed-in session. Mount once under the shell. */
export function useCanSession(sessionId: string | null): void {
  canBatcher.setSession(sessionId); // idempotent; must run before children call useCan in the same render
}

/**
 * A read the person may not be allowed: ask first, and when the answer is no, fail like a 403 without sending the request (the
 * page shows "Not visible to you", and the network and console stay clean). Any one of `actions` allowed is enough.
 */
export async function readIfAllowed<T>(actions: readonly string[], read: () => Promise<T>): Promise<T> {
  const results = await Promise.all(actions.map((action) => canBatcher.ask({ action })));
  if (results.some((r) => r.allowed)) return read();
  const first = results[0];
  throw new ApiError(403, first?.reason || "Your roles don't include this.", { ok: false, msg: first?.reason, needs: first?.needs });
}
