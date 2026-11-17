/**
 * The connection store: one place that knows whether live updates work.
 *
 *   live          the stream is open and alive (or no stream is wanted, e.g. signed out)
 *   reconnecting  the stream dropped (or went silent and the probe failed); the stream backs off and retries
 *   offline       the browser reports no network (online/offline events)
 *
 * Heartbeat watchdog: the server's keep-alive comments are invisible to EventSource, so silence alone proves nothing on a quiet
 * factory. After `staleMs` without any sign of life the watchdog probes the server; only a failed probe flips the state to
 * `reconnecting` and asks the stream to restart. Views read `useConnection()` and may poll only while `streamDown` is true
 * (`pollWhenStreamDown`). The slow health poll stays: a silent worker emits no events.
 */
import { useSyncExternalStore } from "react";

export type ConnectionState = "live" | "reconnecting" | "offline";
export interface ConnectionSnapshot {
  state: ConnectionState;
  /** True when a stream is wanted but not delivering, so a view may poll as a fallback. */
  streamDown: boolean;
  /** ms since epoch of the last sign of life, or null before the first open. */
  lastAlive: number | null;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let wanted = false;
let open = false;
let online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
let silent = false;
let lastAlive: number | null = null;
let restart: (() => void) | null = null;

function compute(): ConnectionSnapshot {
  const down = wanted && (!online || !open || silent);
  const state: ConnectionState = !online ? "offline" : down ? "reconnecting" : "live";
  return { state, streamDown: down, lastAlive };
}
let snap: ConnectionSnapshot = compute();

function publish(): void {
  const next = compute();
  if (next.state === snap.state && next.streamDown === snap.streamDown && next.lastAlive === snap.lastAlive) return;
  snap = next;
  for (const l of [...listeners]) l();
}

export const connection = {
  get: (): ConnectionSnapshot => snap,
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** startStream() began or stopped. `restartFn` closes and reopens the EventSource. */
  streamWanted(on: boolean, restartFn?: () => void): void {
    wanted = on;
    restart = on ? (restartFn ?? null) : null;
    if (!on) {
      open = false;
      silent = false;
      lastAlive = null;
    }
    publish();
  },
  streamOpened(now: number = Date.now()): void {
    open = true;
    silent = false;
    lastAlive = now;
    publish();
  },
  streamDropped(): void {
    open = false;
    publish();
  },
  /** Any evidence the link works: a change event, a successful probe. */
  alive(now: number = Date.now()): void {
    lastAlive = now;
    silent = false;
    publish();
  },
  setOnline(v: boolean): void {
    online = v;
    publish();
  },
  /** Watchdog verdict: silent and the probe failed. */
  stale(): void {
    silent = true;
    publish();
    restart?.();
  },
  /** Test seam. */
  reset(): void {
    wanted = open = silent = false;
    online = true;
    lastAlive = null;
    restart = null;
    snap = compute();
    for (const l of [...listeners]) l();
  },
  isWanted: (): boolean => wanted,
  isOpen: (): boolean => open,
};

export function useConnection(): ConnectionSnapshot {
  return useSyncExternalStore(connection.subscribe, connection.get, connection.get);
}

/**
 * TanStack `refetchInterval` value: poll every `ms` only while the stream is down, never while it is live.
 * Usage: `useQuery({ ..., refetchInterval: pollWhenStreamDown(5000) })`.
 */
export function pollWhenStreamDown(ms: number): () => number | false {
  return () => (connection.get().streamDown ? ms : false);
}

export interface WatchdogOptions {
  staleMs?: number;
  checkMs?: number;
  now?: () => number;
  /** Resolves when the server answers at all (any HTTP status), rejects when unreachable. */
  probe?: () => Promise<unknown>;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (t: ReturnType<typeof setInterval>) => void;
}

/** Starts the heartbeat watchdog and the online/offline listeners. Returns the stop function. */
export function startConnectionWatch(o: WatchdogOptions = {}): () => void {
  const staleMs = o.staleMs ?? 60_000;
  const now = o.now ?? Date.now;
  const probe = o.probe ?? (() => fetch("/healthz", { cache: "no-store", credentials: "omit" }));
  const setI = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = o.clearInterval ?? ((t) => clearInterval(t));
  let probing = false;
  const tick = (): void => {
    const s = connection.get();
    if (probing || !wanted || !open || !online || s.lastAlive === null) return;
    if (now() - s.lastAlive < staleMs) return;
    probing = true;
    probe().then(
      () => {
        probing = false;
        connection.alive(now());
      },
      () => {
        probing = false;
        connection.stale();
      },
    );
  };
  const timer = setI(tick, o.checkMs ?? 15_000);
  const on = (): void => connection.setOnline(true);
  const off = (): void => connection.setOnline(false);
  if (typeof window !== "undefined") {
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    connection.setOnline(navigator.onLine !== false);
  }
  return () => {
    clearI(timer);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    }
  };
}
