/**
 * Live updates: EventSource on /api/v1/stream. Each `change` event names the store slices that
 * changed ({"keys":["workOrders","audit"],"project":"p1"}); the client invalidates those query
 * keys and whatever depends on them. Reconnects with exponential backoff and jitter; on every
 * reconnect it invalidates everything active, because events may have been missed meanwhile.
 */
import { API_BASE } from "./client";
import { invalidateSlices, getQueryClient } from "./keys";
import type { ChangeEvent } from "./types";

export const STREAM_URL = `${API_BASE}/stream`;
const MIN_DELAY = 1000;
const MAX_DELAY = 30_000;

export function parseChange(data: string): ChangeEvent | null {
  try {
    const v = JSON.parse(data) as unknown;
    if (v && typeof v === "object" && Array.isArray((v as { keys?: unknown }).keys)) {
      const keys = (v as { keys: unknown[] }).keys.filter((k): k is string => typeof k === "string");
      const project = (v as { project?: unknown }).project;
      return typeof project === "string" ? { keys, project } : { keys };
    }
  } catch {
    /* malformed event: ignore */
  }
  return null;
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_DELAY, MIN_DELAY * 2 ** attempt);
  return Math.round(base / 2 + random() * (base / 2));
}

export type EventSourceLike = Pick<EventSource, "close" | "addEventListener"> & {
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
};

export interface StreamOptions {
  create?: (url: string) => EventSourceLike;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  onChange?: (e: ChangeEvent) => void;
}

/** Starts the stream. Returns a stop function. */
export function startStream(o: StreamOptions = {}): () => void {
  const create = o.create ?? ((url: string) => new EventSource(url, { withCredentials: true }));
  const rnd = o.random ?? Math.random;
  const setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((t) => clearTimeout(t));
  let es: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  let everOpened = false;

  const connect = () => {
    if (stopped) return;
    const src = create(STREAM_URL);
    es = src;
    src.onopen = () => {
      attempt = 0;
      // After a drop, events may have been missed: refetch what is on screen.
      if (everOpened) void getQueryClient()?.invalidateQueries();
      everOpened = true;
    };
    src.addEventListener("change", (ev) => {
      const parsed = parseChange((ev as MessageEvent<string>).data);
      if (!parsed) return;
      invalidateSlices(parsed.keys);
      o.onChange?.(parsed);
    });
    // The server capped this person's open streams and closed this one: do not reconnect, or tabs would evict each other in a loop.
    // Polling keeps the page current; a reload opens a fresh stream.
    src.addEventListener("superseded", () => {
      stopped = true;
      src.close();
      if (es === src) es = null;
    });
    src.onerror = () => {
      src.close();
      if (es === src) es = null;
      if (stopped) return;
      timer = setT(connect, backoffDelay(attempt++, rnd));
    };
  };
  connect();
  return () => {
    stopped = true;
    if (timer) clearT(timer);
    es?.close();
    es = null;
  };
}
