import type net from "node:net";
import { inCidr } from "./proxy.js";

/**
 * Per-source caps on the shared edge (S-92, S-102). One edge process serves the model gateway and the forward proxy for every run; a run is identified
 * by its source address (each run has its own network and the edge is attached to it, so the address cannot be shared or forged), never by the run id in
 * its credentials. A source inside the run subnet is held to these caps; control-plane callers are not.
 */
export interface SourceCaps {
  /** Open connections one source may hold on one listener. Over it: the connection is answered 429 and closed. */
  maxConnections: number;
  /** HTTP requests (and CONNECTs) one source may make per minute, across both listeners. Over it: 429 with Retry-After. */
  requestsPerMinute: number;
  /** Failed edge-token compares one source may make per minute on the token routes (/service/v1, /mcp-admin/v1). Over it: 429 for every attempt until the minute is out. */
  tokenFailuresPerMinute: number;
}
/** Spec fetches (a run's first call) per source per minute, apart from the general window. */
export const SPEC_PER_MINUTE = 30;
export const DEFAULT_SOURCE_CAPS: SourceCaps = { maxConnections: 128, requestsPerMinute: 1200, tokenFailuresPerMinute: 20 };

export interface GuardLog { warn(obj: object, msg: string): void }
export interface GuardMetrics { connectionsRefused: number; requestsRefused: number; tokenAttemptsRefused: number }

const plain = (ip: string): string => ip.replace(/^::ffff:/i, "");
const REFUSAL = (msg: string) => `HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain\r\nRetry-After: 5\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(msg) + 1}\r\n\r\n${msg}\n`;

export class SourceGuard {
  readonly metrics: GuardMetrics = { connectionsRefused: 0, requestsRefused: 0, tokenAttemptsRefused: 0 };
  private readonly conns = new Map<string, number>();
  private readonly rate = new Map<string, number[]>();
  private readonly specRate = new Map<string, number[]>();
  private readonly lastRun = new Map<string, string>();
  private readonly fails = new Map<string, { since: number; n: number }>();
  private readonly logged = new Map<string, number>();

  constructor(
    private readonly caps: SourceCaps,
    private readonly runSubnet: string,
    private readonly log: GuardLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the caps apply to this address (a run network address; everything else is the control plane). */
  governs(ip: string | undefined): boolean {
    return !!ip && inCidr(ip, this.runSubnet);
  }


  /** One log line per source, kind and ten seconds: a flood must not become a log flood. */
  private note(kind: string, source: string, limit: number): void {
    const key = `${kind}|${source}`;
    const t = this.now();
    if ((this.logged.get(key) ?? 0) > t - 10_000) return;
    this.logged.set(key, t);
    if (this.logged.size > 5000) this.logged.delete(this.logged.keys().next().value as string);
    this.log.warn({ source, kind, limit }, "edge source over its cap");
  }

  /** Counts connections per source on one listener; an over-cap connection is answered 429 and closed before the HTTP parser sees it. */
  attach(server: net.Server, listener: string): void {
    const held = new Map<string, number>();
    server.prependListener("connection", (socket: net.Socket) => {
      const raw = socket.remoteAddress;
      if (!raw || !this.governs(raw)) return;
      const ip = plain(raw);
      const n = held.get(ip) ?? 0;
      if (n >= this.caps.maxConnections) {
        this.metrics.connectionsRefused++;
        this.note(`connections:${listener}`, ip, this.caps.maxConnections);
        socket.on("error", () => undefined);
        socket.end(REFUSAL(`Too many connections from this run (limit ${this.caps.maxConnections}).`));
        socket.destroy();
        return;
      }
      held.set(ip, n + 1);
      socket.once("close", () => {
        const m = (held.get(ip) ?? 1) - 1;
        if (m <= 0) held.delete(ip);
        else held.set(ip, m);
      });
    });
  }

  /**
   * Counts one request from `ip` in a true sliding 60 s window; false when the source is over its rate (the caller answers 429). The run's first call,
   * the spec, has its own small window, so a new run on an address an earlier flooding run used up can still get in and be recognised (runStarted).
   */
  request(ip: string | undefined, kind: "general" | "spec" = "general"): boolean {
    if (!ip || !this.governs(ip)) return true;
    ip = plain(ip);
    const t = this.now();
    const map = kind === "spec" ? this.specRate : this.rate;
    const limit = kind === "spec" ? SPEC_PER_MINUTE : this.caps.requestsPerMinute;
    let w = map.get(ip);
    if (!w) map.set(ip, (w = []));
    while (w.length && w[0]! <= t - 60_000) w.shift();
    if (map.size > 5000) map.delete(map.keys().next().value as string);
    if (w.length >= limit) {
      this.metrics.requestsRefused++;
      this.note(`requests:${kind}`, ip, limit);
      return false;
    }
    w.push(t);
    return true;
  }

  /**
   * A run was verified by the API on this address (its spec call answered 200). When it is a different run from the one last seen here, the address was
   * released and reused (the launcher gives out the lowest free /28): the earlier run's request count is cleared (G-S2, R3). A hostile run cannot use this
   * to reset itself: only a valid token of another run, which it does not hold, changes the run id.
   */
  runStarted(ip: string | undefined, runId: string): void {
    if (!ip || !this.governs(ip)) return;
    ip = plain(ip);
    if (this.lastRun.get(ip) === runId) return;
    this.lastRun.set(ip, runId);
    if (this.lastRun.size > 5000) this.lastRun.delete(this.lastRun.keys().next().value as string);
    this.rate.delete(ip);
  }

  /** True when this source has used up its failed token attempts for the minute (any address, runs or not). */
  tokenBlocked(ip: string | undefined): boolean {
    if (!ip) return false;
    ip = plain(ip);
    const f = this.fails.get(ip);
    const blocked = !!f && f.since > this.now() - 60_000 && f.n >= this.caps.tokenFailuresPerMinute;
    if (blocked) {
      this.metrics.tokenAttemptsRefused++;
      this.note("token-attempts", ip, this.caps.tokenFailuresPerMinute);
    }
    return blocked;
  }

  tokenFailed(ip: string | undefined): void {
    if (!ip) return;
    ip = plain(ip);
    const t = this.now();
    let f = this.fails.get(ip);
    if (!f || f.since <= t - 60_000) this.fails.set(ip, (f = { since: t, n: 0 }));
    if (this.fails.size > 5000) this.fails.delete(this.fails.keys().next().value as string);
    f.n++;
  }
}
