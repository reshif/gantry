import { connect as tlsConnect } from "node:tls";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { TransientError } from "../errors.js";

export interface HttpRequest {
  method: "POST" | "GET";
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

/** Outbound HTTP for chat and webhook delivery. Production goes through the edge's forward proxy (spec 12.2). */
export interface OutboundHttp {
  request(r: HttpRequest): Promise<HttpResponse>;
}

const MAX_BODY = 64 * 1024;

function collect(res: http.IncomingMessage, resolve: (r: HttpResponse) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  res.on("data", (c: Buffer) => {
    if (size < MAX_BODY) chunks.push(c);
    size += c.length;
  });
  res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, 2000) }));
  res.on("error", () => resolve({ status: res.statusCode ?? 0, body: "" }));
}

/** CONNECT through the proxy; resolves with the tunnelled socket once the proxy answers 200. */
function tunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname, port: Number(proxy.port || 80), method: "CONNECT", path: `${host}:${port}`, headers: { host: `${host}:${port}`, ...(proxy.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {}) },
      timeout: timeoutMs,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(new TransientError(`The egress proxy refused ${host}:${port} (${res.statusCode}). Is the host on the system allow-list?`, `proxy_${res.statusCode}`));
    });
    req.on("timeout", () => req.destroy(new Error("proxy timeout")));
    req.on("error", (e) => reject(new TransientError(`The egress proxy is unreachable: ${e.message}`, "proxy_unreachable")));
    req.end();
  });
}

/**
 * An HTTP client that reaches the world through a forward proxy: HTTPS by CONNECT, plain HTTP by absolute-URI request (what gantry-edge :8444 accepts).
 * With no proxy configured it connects directly, which only local development and tests do.
 */
export function proxiedHttp(o: { proxy: string | null; ca?: string | null }): OutboundHttp {
  const proxy = o.proxy ? new URL(o.proxy) : null;
  return {
    request(r) {
      const u = new URL(r.url);
      const timeoutMs = r.timeoutMs ?? 20_000;
      const headers = { ...r.headers, connection: "close", ...(r.body !== undefined ? { "content-length": String(Buffer.byteLength(r.body)) } : {}) };
      return new Promise<HttpResponse>((resolve, reject) => {
        const fail = (e: unknown): void => reject(e instanceof TransientError ? e : new TransientError(`${r.method} ${u.host} failed: ${(e as Error).message}`, "unreachable"));
        const send = (req: http.ClientRequest): void => {
          req.on("response", (res) => collect(res, resolve));
          req.on("error", fail);
          req.on("timeout", () => req.destroy(new Error("timeout")));
          if (r.body !== undefined) req.write(r.body);
          req.end();
        };
        if (u.protocol === "https:") {
          const port = Number(u.port || 443);
          const open = async (): Promise<void> => {
            const socket = proxy ? await tunnel(proxy, u.hostname, port, timeoutMs) : undefined;
            send(https.request({
              host: u.hostname, port, path: `${u.pathname}${u.search}`, method: r.method, headers: { ...headers, host: u.host }, timeout: timeoutMs, agent: false, servername: u.hostname, ...(o.ca ? { ca: o.ca } : {}),
              ...(socket ? { createConnection: () => tlsConnect({ socket, servername: u.hostname, ...(o.ca ? { ca: o.ca } : {}) }) } : {}),
            }));
          };
          open().catch(fail);
        } else if (proxy) {
          send(http.request({ host: proxy.hostname, port: Number(proxy.port || 80), method: r.method, path: r.url, headers: { ...headers, host: u.host }, timeout: timeoutMs, agent: false }));
        } else {
          send(http.request({ host: u.hostname, port: Number(u.port || 80), method: r.method, path: `${u.pathname}${u.search}`, headers, timeout: timeoutMs, agent: false }));
        }
      });
    },
  };
}
