import type pg from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CHANGES_CHANNEL, parseChange, type Change } from "./changes.js";

export interface Subscriber {
  personId: string;
  sessionId: string | null;
  /** Project ids the person can see, or "all" (factory-wide roles). Refreshed when people, roles or projects change. */
  visible: Set<string> | "all";
  write(chunk: string): boolean;
  close(): void;
}

export interface HubHooks {
  /** Recomputes a subscriber's visible projects. Returns null if the person or session is gone (the stream is closed). */
  refresh(s: Subscriber): Promise<Set<string> | "all" | null>;
}

export const STREAMS_PER_PERSON = 5;
export const STREAMS_TOTAL = 2000;

const VISIBILITY_KEYS = new Set(["people", "projects", "matrix", "roles", "session", "sessions", "factory", "*"]);

/**
 * Slices only factory-wide readers (Factory Admin, Auditor, Security Reviewer) can read. A factory-wide change (no project)
 * is sent to everyone else without these names, and not at all if nothing remains: knowing that API keys, security
 * settings or the ledger just changed is itself information a project-only person should not get.
 */
const FACTORY_ONLY_KEYS = new Set(["apiKeys", "apiConfig", "security", "signins", "sessions", "chatLinks", "audit", "policies", "freezes"]);

/** The change as one subscriber may see it, or null when there is nothing for them. */
export function changeFor(ch: Change, visible: Set<string> | "all"): { keys: string[]; project?: string } | null {
  if (visible === "all") return { keys: ch.keys, ...(ch.project ? { project: ch.project } : {}) };
  if (ch.project) return visible.has(ch.project) ? { keys: ch.keys, project: ch.project } : null;
  const keys = ch.keys.filter((k) => !FACTORY_ONLY_KEYS.has(k));
  return keys.length ? { keys } : null;
}

/** Fans Postgres LISTEN/NOTIFY messages out to SSE subscribers, filtered per person by visible project. */
export class Hub {
  private subs = new Set<Subscriber>();
  private client: pg.PoolClient | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly orgId: string,
    private readonly hooks: HubHooks,
    private readonly sweepMs = 60_000,
    /** Open streams one person may hold (a further one is refused) and in all. Every stream costs a policy load on each visibility change. */
    private readonly limits: { perPerson: number; total: number } = { perPerson: STREAMS_PER_PERSON, total: STREAMS_TOTAL },
  ) {}

  /** One refresh per person and session for a whole fan-out, not one per open stream. */
  private refresher(): (s: Subscriber) => Promise<Set<string> | "all" | null> {
    const done = new Map<string, Promise<Set<string> | "all" | null>>();
    return (s) => {
      const k = `${s.personId}\u0000${s.sessionId ?? ""}`;
      let p = done.get(k);
      if (!p) done.set(k, (p = this.hooks.refresh(s)));
      return p;
    };
  }

  get size(): number {
    return this.subs.size;
  }

  async start(): Promise<void> {
    await this.listen();
    this.sweeper = setInterval(() => void this.sweep(), this.sweepMs);
    this.sweeper.unref();
  }

  /** Closes the streams of people whose session or account ended (expiry and idle timeout produce no notification). */
  async sweep(): Promise<void> {
    const refresh = this.refresher();
    await Promise.all(
      [...this.subs].map(async (s) => {
        const v = await refresh(s).catch(() => s.visible);
        if (v === null) s.close();
        else s.visible = v;
      }),
    );
  }

  private async listen(): Promise<void> {
    if (this.closed) return;
    try {
      const c = await this.pool.connect();
      const drop = (): void => {
        if (this.client !== c) return;
        this.client = null;
        c.removeAllListeners("notification");
        try {
          c.release(true);
        } catch {
          /* already released */
        }
        if (!this.closed) this.retry = setTimeout(() => void this.listen(), 1000);
        // Events may have been missed while disconnected: tell everyone to refetch.
        void this.dispatch({ org: this.orgId, keys: ["*"] });
      };
      c.on("error", drop);
      c.on("end", drop);
      c.on("notification", (m) => {
        if (m.channel !== CHANGES_CHANNEL) return;
        const ch = parseChange(m.payload);
        if (ch && ch.org === this.orgId) void this.dispatch(ch);
      });
      await c.query(`LISTEN ${CHANGES_CHANNEL}`);
      this.client = c;
    } catch {
      if (!this.closed) this.retry = setTimeout(() => void this.listen(), 1000);
    }
  }

  async dispatch(ch: Change): Promise<void> {
    const needsRefresh = ch.keys.some((k) => VISIBILITY_KEYS.has(k));
    const refresh = this.refresher();
    await Promise.all(
      [...this.subs].map(async (s) => {
        if (needsRefresh) {
          const v = await refresh(s).catch(() => s.visible);
          if (v === null) return s.close();
          s.visible = v;
        }
        const out = changeFor(ch, s.visible);
        if (out) s.write(`event: change\ndata: ${JSON.stringify(out)}\n\n`);
      }),
    );
  }

  /**
   * False when the hub is full or this person already holds their limit: the caller refuses the NEW stream. Evicting the oldest instead
   * would make a person with more tabs than the limit trade streams forever, each tab reconnecting and closing another.
   */
  hasRoom(personId?: string): boolean {
    if (this.subs.size >= this.limits.total) return false;
    if (personId === undefined) return true;
    let n = 0;
    for (const x of this.subs) if (x.personId === personId) n++;
    return n < this.limits.perPerson;
  }

  add(s: Subscriber): () => void {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.sweeper) clearInterval(this.sweeper);
    for (const s of this.subs) s.close();
    this.subs.clear();
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners();
      c.on("error", () => undefined);
      await c.query(`UNLISTEN *`).catch(() => undefined);
      c.release();
    }
  }
}

/** Opens an SSE response for a person: headers, retry hint, 15 s heartbeat comments, cleanup on disconnect. */
export function openStream(req: FastifyRequest, reply: FastifyReply, hub: Hub, sub: Omit<Subscriber, "write" | "close">, heartbeatMs = 15_000): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-request-id": req.id,
  });
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearInterval(timer);
    remove();
    if (!res.writableEnded) res.end();
  };
  const subscriber: Subscriber = { ...sub, write: (c) => !done && res.write(c), close: finish };
  const remove = hub.add(subscriber);
  const timer = setInterval(() => subscriber.write(`: hb\n\n`), heartbeatMs);
  req.raw.on("close", finish);
  res.on("error", finish);
  res.write(`retry: 3000\n: connected\n\n`);
}
