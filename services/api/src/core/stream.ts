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

const VISIBILITY_KEYS = new Set(["people", "projects", "matrix", "roles", "session", "sessions", "factory", "*"]);

/** Fans Postgres LISTEN/NOTIFY messages out to SSE subscribers, filtered per person by visible project. */
export class Hub {
  private subs = new Set<Subscriber>();
  private client: pg.PoolClient | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly pool: pg.Pool, private readonly orgId: string, private readonly hooks: HubHooks, private readonly sweepMs = 60_000) {}

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
    await Promise.all(
      [...this.subs].map(async (s) => {
        const v = await this.hooks.refresh(s).catch(() => s.visible);
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
    const refresh = ch.keys.some((k) => VISIBILITY_KEYS.has(k));
    const msg = `event: change\ndata: ${JSON.stringify({ keys: ch.keys, ...(ch.project ? { project: ch.project } : {}) })}\n\n`;
    await Promise.all(
      [...this.subs].map(async (s) => {
        if (refresh) {
          const v = await this.hooks.refresh(s).catch(() => s.visible);
          if (v === null) return s.close();
          s.visible = v;
        }
        if (ch.project && s.visible !== "all" && !s.visible.has(ch.project)) return;
        s.write(msg);
      }),
    );
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
