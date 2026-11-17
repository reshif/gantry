/**
 * A small MCP client for the edge (spec 12.4): streamable HTTP and the older HTTP+SSE transport, tools only.
 * Written against the protocol rather than an SDK so the edge keeps full control of the connection: every socket goes through one guarded
 * agent that refuses private addresses at connect time (so a rebound DNS name cannot reach the control network), and credentials are injected
 * here, per request, and never leave this process.
 */
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as ufetch } from "undici";
import { isPrivateAddress } from "../proxy.js";
import { sseEvents } from "./sse.js";

export const LATEST_PROTOCOL = "2025-06-18";
export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface UpstreamAuth {
  mode: "none" | "bearer" | "header";
  header?: string | null | undefined;
  secret?: string | null | undefined;
}
export interface UpstreamTarget {
  url: string;
  transport: "http" | "sse";
  auth: UpstreamAuth;
}

export type UpstreamErrorKind = "network" | "http" | "protocol" | "rpc" | "timeout";

export class UpstreamError extends Error {
  constructor(
    msg: string,
    readonly kind: UpstreamErrorKind,
    readonly status?: number,
    readonly rpc?: { code: number; message: string; data?: unknown },
  ) {
    super(msg);
  }
  /** Worth sending again, for a read call: the server did not answer, or said it was busy. A tool's own error is final. */
  get transient(): boolean {
    return this.kind === "network" || this.kind === "timeout" || (this.kind === "http" && (this.status === 429 || (this.status ?? 0) >= 500));
  }
}

export interface Upstream {
  protocolRevision: string;
  serverName: string;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** The largest answer the edge reads from a registered MCP server (one JSON body, or one stream event). A hostile server cannot fill the edge's memory inside the timeout. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface UpstreamOptions {
  timeoutMs: number;
  /** Cap on one answer from the server (default MAX_RESPONSE_BYTES). */
  maxBytes?: number;
  /** Refuse loopback, link-local and private addresses (the SSRF guard). */
  blockPrivate: boolean;
  /** One guarded agent per gateway, shared by every session. */
  agent: Agent;
}

/** An undici agent whose DNS lookup rejects private addresses, so the checked address is the one connected to. */
export function guardedAgent(blockPrivate: boolean): Agent {
  const lookup = ((hostname: string, options: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = (addrs as dns.LookupAddress[]).filter((a) => !blockPrivate || !isPrivateAddress(a.address));
      if (!list.length) return cb(new Error(`${hostname} resolves to a private address`));
      return options.all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as net.LookupFunction;
  return new Agent({ connect: { lookup }, bodyTimeout: 0, headersTimeout: 60_000 });
}

export const authHeaders = (a: UpstreamAuth): Record<string, string> =>
  a.mode === "bearer" && a.secret ? { authorization: `Bearer ${a.secret}` } : a.mode === "header" && a.secret ? { [a.header || "x-api-key"]: a.secret } : {};

/** Error text with the credential removed, in case a server or a proxy echoes it. */
export const redact = (msg: string, secret?: string | null): string => (secret && secret.length >= 4 ? msg.split(secret).join("[redacted]") : msg);

interface Rpc { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

/** Reads a body as text, stopping (and cancelling the transfer) once it passes `max` bytes. */
async function readCapped(res: { body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null }, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      const e = new Error(`The answer is larger than ${max} bytes.`);
      e.name = "ResponseTooLarge";
      throw e;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

abstract class Base implements Upstream {
  protocolRevision = "";
  serverName = "";
  protected seq = 0;
  constructor(protected readonly t: UpstreamTarget, protected readonly o: UpstreamOptions, protected readonly agent: Agent) {}
  protected abstract send(msg: Rpc, id: number | null): Promise<Rpc | null>;
  abstract close(): Promise<void>;
  protected fail(e: unknown): never {
    if (e instanceof UpstreamError) throw new UpstreamError(redact(e.message, this.t.auth.secret), e.kind, e.status, e.rpc);
    const err = e as { name?: string; message?: string; cause?: { message?: string } };
    if (err?.name === "SseLimitError" || err?.name === "ResponseTooLarge") throw new UpstreamError(`The server's answer is larger than ${Math.round((this.o.maxBytes ?? MAX_RESPONSE_BYTES) / 1024)} KiB; it was cut off.`, "protocol");
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new UpstreamError(`The server did not answer within ${Math.round(this.o.timeoutMs / 1000)} s.`, "timeout");
    throw new UpstreamError(redact(`Could not reach the server: ${err?.cause?.message ?? err?.message ?? String(e)}`, this.t.auth.secret), "network");
  }
  async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.seq;
    let r: Rpc | null;
    try {
      r = await this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, id);
    } catch (e) {
      this.fail(e);
    }
    if (!r) throw new UpstreamError("The server sent no answer.", "protocol");
    if (r.error) throw new UpstreamError(redact(`The server answered with an error: ${r.error.message}`, this.t.auth.secret), "rpc", undefined, r.error);
    return r.result;
  }
  async notify(method: string, params?: unknown): Promise<void> {
    try {
      await this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, null);
    } catch (e) {
      this.fail(e);
    }
  }
  async initialize(): Promise<void> {
    const r = (await this.request("initialize", { protocolVersion: LATEST_PROTOCOL, capabilities: {}, clientInfo: { name: "gantry-edge", version: "1.0.0" } })) as { protocolVersion?: unknown; serverInfo?: { name?: unknown } } | undefined;
    const v = typeof r?.protocolVersion === "string" ? r.protocolVersion : "";
    if (!SUPPORTED_PROTOCOLS.includes(v)) throw new UpstreamError(`The server speaks protocol revision ${v || "(none)"}, which Gantry does not support.`, "protocol");
    this.protocolRevision = v;
    this.serverName = typeof r?.serverInfo?.name === "string" ? r.serverInfo.name : "";
    await this.notify("notifications/initialized");
  }
}

class HttpUpstream extends Base {
  private session: string | null = null;
  protected async send(msg: Rpc, id: number | null): Promise<Rpc | null> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...authHeaders(this.t.auth) };
    if (this.protocolRevision) headers["mcp-protocol-version"] = this.protocolRevision;
    if (this.session) headers["mcp-session-id"] = this.session;
    const res = await ufetch(this.t.url, { method: "POST", headers, body: JSON.stringify(msg), dispatcher: this.agent, redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (id === null) {
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new UpstreamError(`The server answered ${res.status}.`, "http", res.status);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamError(`The server answered ${res.status}.`, "http", res.status);
    }
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && res.body) {
      for await (const ev of sseEvents(res.body as unknown as ReadableStream<Uint8Array>, { maxEventBytes: this.o.maxBytes ?? MAX_RESPONSE_BYTES, maxTotalBytes: 4 * (this.o.maxBytes ?? MAX_RESPONSE_BYTES) })) {
        try {
          const m = JSON.parse(ev.data) as Rpc;
          if (m.id === id && (m.result !== undefined || m.error)) return m;
        } catch {
          // not JSON: skip
        }
      }
      throw new UpstreamError("The server's stream ended without an answer.", "protocol");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readCapped(res, this.o.maxBytes ?? MAX_RESPONSE_BYTES));
    } catch (e) {
      if ((e as { name?: string })?.name === "ResponseTooLarge") throw e;
      throw new UpstreamError("The server answered with something that is not JSON.", "protocol");
    }
    const list = Array.isArray(parsed) ? (parsed as Rpc[]) : [parsed as Rpc];
    return list.find((m) => m && m.id === id) ?? null;
  }
  async close(): Promise<void> {
    if (!this.session) return;
    await ufetch(this.t.url, { method: "DELETE", headers: { "mcp-session-id": this.session, ...(this.protocolRevision ? { "mcp-protocol-version": this.protocolRevision } : {}), ...authHeaders(this.t.auth) }, dispatcher: this.agent, redirect: "error", signal: AbortSignal.timeout(5000) })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }
}

/** The 2024-11 HTTP+SSE transport: a GET stream carries the answers, an `endpoint` event names where to POST. */
class SseUpstream extends Base {
  private endpoint: string | null = null;
  private readonly pending = new Map<number, { resolve: (m: Rpc) => void; reject: (e: unknown) => void }>();
  private ctl = new AbortController();
  private streamError: unknown = null;
  private ready: Promise<void> | null = null;

  async open(): Promise<void> {
    let signal: () => void = () => undefined;
    let fail: (e: unknown) => void = () => undefined;
    this.ready = new Promise<void>((res, rej) => { signal = res; fail = rej; });
    this.ready.catch(() => undefined);
    const res = await ufetch(this.t.url, { method: "GET", headers: { accept: "text/event-stream", ...authHeaders(this.t.auth) }, dispatcher: this.agent, redirect: "error", signal: AbortSignal.any([this.ctl.signal, AbortSignal.timeout(this.o.timeoutMs)]) }).catch((e: unknown) => this.fail(e));
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamError(`The server answered ${res.status}.`, "http", res.status);
    }
    void (async () => {
      try {
        for await (const ev of sseEvents(res.body as unknown as ReadableStream<Uint8Array>, { maxEventBytes: this.o.maxBytes ?? MAX_RESPONSE_BYTES })) {
          if (ev.event === "endpoint") {
            const u = new URL(ev.data, this.t.url);
            // The credential goes only where the server was registered.
            if (u.origin !== new URL(this.t.url).origin) throw new UpstreamError("The server pointed its message endpoint at another host.", "protocol");
            this.endpoint = u.toString();
            signal();
          } else if (ev.event === "message") {
            const m = JSON.parse(ev.data) as Rpc;
            if (typeof m.id === "number") this.pending.get(m.id)?.resolve(m);
          }
        }
        throw new UpstreamError("The server closed its event stream.", "protocol");
      } catch (e) {
        this.streamError = e;
        fail(e);
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
      }
    })();
    await Promise.race([this.ready, new Promise<never>((_, rej) => setTimeout(() => rej(new UpstreamError("The server sent no endpoint event.", "timeout")), this.o.timeoutMs).unref())]);
  }
  protected async send(msg: Rpc, id: number | null): Promise<Rpc | null> {
    if (!this.endpoint) throw this.streamError ?? new UpstreamError("The event stream is not open.", "protocol");
    let wait: Promise<Rpc> | null = null;
    if (id !== null) {
      wait = new Promise<Rpc>((resolve, reject) => this.pending.set(id, { resolve, reject }));
      wait.catch(() => undefined);
    }
    const res = await ufetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(this.t.auth) }, body: JSON.stringify(msg), dispatcher: this.agent, redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) {
      if (id !== null) this.pending.delete(id);
      throw new UpstreamError(`The server answered ${res.status}.`, "http", res.status);
    }
    if (!wait || id === null) return null;
    const timer = setTimeout(() => this.pending.get(id)?.reject(new UpstreamError(`The server did not answer within ${Math.round(this.o.timeoutMs / 1000)} s.`, "timeout")), this.o.timeoutMs);
    try {
      return await wait;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
  async close(): Promise<void> {
    this.ctl.abort();
  }
}

function preflight(t: UpstreamTarget, o: UpstreamOptions): void {
  let u: URL;
  try {
    u = new URL(t.url);
  } catch {
    throw new UpstreamError("The server address is not a valid URL.", "protocol");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UpstreamError("Only http and https servers are supported.", "protocol");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (o.blockPrivate && net.isIP(host) && isPrivateAddress(host)) throw new UpstreamError(`${host} is a private address.`, "network");
}

/** Connects, initialises and returns a session. The caller closes it. */
export async function openUpstream(t: UpstreamTarget, o: UpstreamOptions): Promise<Upstream> {
  preflight(t, o);
  const up = t.transport === "sse" ? new SseUpstream(t, o, o.agent) : new HttpUpstream(t, o, o.agent);
  try {
    if (up instanceof SseUpstream) await up.open();
    await up.initialize();
  } catch (e) {
    await up.close().catch(() => undefined);
    throw e;
  }
  return up;
}

export interface ListedTool { name: string; title?: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }

export async function listTools(up: Upstream): Promise<ListedTool[]> {
  const out: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = (await up.request("tools/list", cursor ? { cursor } : {})) as { tools?: unknown; nextCursor?: unknown } | undefined;
    if (!Array.isArray(r?.tools)) throw new UpstreamError("The server's tool list was not an array.", "protocol");
    for (const t of r.tools as ListedTool[]) if (t && typeof t.name === "string" && t.name) out.push(t);
    if (typeof r?.nextCursor !== "string" || !r.nextCursor) return out;
    cursor = r.nextCursor;
  }
  return out;
}
