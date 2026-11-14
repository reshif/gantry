/**
 * Outbound HTTP for connector tests and delivery (spec 12.2): chat and webhook traffic leaves through the edge's forward proxy (`GANTRY_EGRESS_PROXY`,
 * `http://gantry-edge:8444`), so the system allow-list applies. With no proxy configured it connects directly, which only local development and tests do.
 * HTTPS goes by CONNECT, plain HTTP by an absolute-URI request.
 */
import http from "node:http";
import https from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

export interface HttpRequest {
  method: "POST" | "GET" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
export interface HttpResponse {
  status: number;
  body: string;
}
export interface OutboundHttp {
  request(r: HttpRequest): Promise<HttpResponse>;
}

/** The request never reached an answer: DNS, refused, proxy refusal, timeout. Retryable. */
export class NetworkError extends Error {
  constructor(msg: string, readonly code: string) {
    super(msg);
  }
}

const MAX_BODY = 256 * 1024;

function collect(res: http.IncomingMessage, resolve: (r: HttpResponse) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  res.on("data", (c: Buffer) => {
    if (size < MAX_BODY) chunks.push(c);
    size += c.length;
  });
  res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
  res.on("error", () => resolve({ status: res.statusCode ?? 0, body: "" }));
}

function tunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname, port: Number(proxy.port || 80), method: "CONNECT", path: `${host}:${port}`, timeout: timeoutMs,
      headers: { host: `${host}:${port}`, ...(proxy.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {}) },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(new NetworkError(`The egress proxy refused ${host}:${port} (${res.statusCode}). Is the host on the system allow-list?`, `proxy_${res.statusCode}`));
    });
    req.on("timeout", () => req.destroy(new Error("proxy timeout")));
    req.on("error", (e) => reject(new NetworkError(`The egress proxy is unreachable: ${e.message}`, "proxy_unreachable")));
    req.end();
  });
}

export function proxiedHttp(o: { proxy: string | null; ca?: string | null }): OutboundHttp {
  const proxy = o.proxy ? new URL(o.proxy) : null;
  return {
    request(r) {
      const u = new URL(r.url);
      const timeoutMs = r.timeoutMs ?? 15_000;
      const headers = { ...r.headers, connection: "close", ...(r.body !== undefined ? { "content-length": String(Buffer.byteLength(r.body)) } : {}) };
      return new Promise<HttpResponse>((resolve, reject) => {
        const fail = (e: unknown): void => reject(e instanceof NetworkError ? e : new NetworkError(`${r.method} ${u.host} failed: ${(e as Error).message}`, "unreachable"));
        const send = (req: http.ClientRequest): void => {
          req.on("response", (res) => collect(res, resolve));
          req.on("error", fail);
          req.on("timeout", () => req.destroy(new Error("timeout")));
          if (r.body !== undefined) req.write(r.body);
          req.end();
        };
        if (u.protocol === "https:") {
          const port = Number(u.port || 443);
          (async () => {
            const socket = proxy ? await tunnel(proxy, u.hostname, port, timeoutMs) : undefined;
            send(https.request({
              host: u.hostname, port, path: `${u.pathname}${u.search}`, method: r.method, headers: { ...headers, host: u.host }, timeout: timeoutMs, servername: u.hostname, ...(o.ca ? { ca: o.ca } : {}),
              // Node uses `createConnection` only when there is no agent: `agent: false` makes a fresh agent that dials (and resolves) the host
              // itself, which bypasses the tunnel and fails on the internal network. So: no agent with a tunnel, a throwaway agent without one.
              ...(socket ? { createConnection: () => tlsConnect({ socket, servername: u.hostname, ...(o.ca ? { ca: o.ca } : {}) }) } : { agent: false }),
            }));
          })().catch(fail);
        } else if (proxy) {
          send(http.request({ host: proxy.hostname, port: Number(proxy.port || 80), method: r.method, path: r.url, headers: { ...headers, host: u.host }, timeout: timeoutMs, agent: false }));
        } else {
          send(http.request({ host: u.hostname, port: Number(u.port || 80), method: r.method, path: `${u.pathname}${u.search}`, headers, timeout: timeoutMs, agent: false }));
        }
      });
    },
  };
}

/** The HTTP client the API process uses, from the environment (`GANTRY_EGRESS_PROXY`, `GANTRY_EGRESS_CA` as PEM text or a file path). */
export function httpFromEnv(env: NodeJS.ProcessEnv = process.env): OutboundHttp {
  let ca: string | null = null;
  const c = env.GANTRY_EGRESS_CA;
  if (c) ca = c.includes("BEGIN CERTIFICATE") ? c : null;
  return proxiedHttp({ proxy: env.GANTRY_EGRESS_PROXY || null, ca });
}
