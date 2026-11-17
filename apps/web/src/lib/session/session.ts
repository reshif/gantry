/**
 * The session state machine: one place decides what "who am I" means for the whole app.
 *
 *   unknown  first /me load, nothing to show yet
 *   in       a person is signed in. A failed refetch keeps this state (`stale: true`): the app never unmounts on a blip
 *   out      the server said sign in (401); the sign-in screen shows
 *   offline  /me failed and there is nothing cached to show (hard error with Retry)
 *
 * `resetSessionState` is the single clean-up: query cache, module-level stores, and gantry.* storage. It runs when the session
 * ends (401 or sign-out) and when the identity behind the session changes (a different person in the same tab).
 */
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { MeState } from "../../api/queries";

export type SessionState = "unknown" | "in" | "out" | "offline";

export interface MeQueryLike {
  data: MeState | undefined;
  isPending: boolean;
  isError: boolean;
}

export interface SessionView {
  state: SessionState;
  /** Signed in, but the latest refresh of /me failed: show a reconnect banner, keep the app. */
  stale: boolean;
}

/** Branches on data FIRST: a refetch error with data never hides the app. */
export function deriveSession(q: MeQueryLike): SessionView {
  if (q.data) return { state: q.data.status === "in" ? "in" : "out", stale: q.isError && q.data.status === "in" };
  if (q.isError) return { state: "offline", stale: false };
  return { state: "unknown", stale: false };
}

/* ---------- reset ---------- */

export type ResetReason = "expired" | "signed_out" | "identity_changed";

const resets = new Set<() => void>();

/** Module-level stores (caches, drafts, subscriptions held outside React) register their clear function here. Returns unregister. */
export function registerSessionReset(fn: () => void): () => void {
  resets.add(fn);
  return () => {
    resets.delete(fn);
  };
}

/** Storage keys that hold unsent work. They survive an expired session (so the person can sign in again and continue). */
const DRAFT_KEY = /^gantry\.(stepup\.draft|draft\.)/;

function wipe(s: Storage | null, keepDrafts: boolean): void {
  if (!s) return;
  try {
    for (const k of Object.keys(s)) if (k.startsWith("gantry.") && !(keepDrafts && DRAFT_KEY.test(k))) s.removeItem(k);
  } catch {
    /* storage blocked: nothing to clear */
  }
}
const storage = (kind: "localStorage" | "sessionStorage"): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window[kind];
  } catch {
    return null;
  }
};

/**
 * Clears everything that belongs to the previous session.
 *  - expired: cache and stores go, unsent drafts stay (sign in again and carry on)
 *  - signed_out: everything goes, zero gantry.* keys remain
 *  - identity_changed: like signed_out, but the /me query is kept (it already holds the new person)
 */
export function resetSessionState(client: QueryClient | null, reason: ResetReason): void {
  const keepDrafts = reason === "expired";
  if (client) {
    if (reason === "identity_changed") {
      void client.cancelQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    } else {
      void client.cancelQueries();
      client.clear();
    }
  }
  for (const fn of [...resets]) {
    try {
      fn();
    } catch {
      /* one store failing to clear must not stop the others */
    }
  }
  wipe(storage("localStorage"), keepDrafts);
  wipe(storage("sessionStorage"), keepDrafts);
}

/* ---------- lifecycle ---------- */

let unauthorizedAt = 0;
/** Called by the API client's 401 handler: the next transition to "out" is an expiry, not a deliberate sign-out. */
export function noteUnauthorized(now: number = Date.now()): void {
  unauthorizedAt = now;
}

/** Watches the /me result: in -> out resets the session, and a different person id resets it too. */
export function useSessionLifecycle(client: QueryClient, data: MeState | undefined): void {
  const prev = useRef<{ status: "in" | "out"; person: string | null } | null>(null);
  const status = data?.status;
  const person = data?.status === "in" ? data.me.person.id : null;
  useEffect(() => {
    if (!status) return;
    const before = prev.current;
    prev.current = { status, person };
    if (!before) return;
    if (status === "out" && before.status === "in") {
      resetSessionState(client, Date.now() - unauthorizedAt < 30_000 ? "expired" : "signed_out");
    } else if (status === "in" && before.status === "in" && before.person && person && before.person !== person) {
      resetSessionState(client, "identity_changed");
    }
  }, [client, status, person]);
}
