import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { ApiClient } from "./api.js";
import type { EdgeConfig } from "./config.js";
import { runIdOfToken } from "./gateway.js";

export interface ProxyLogger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export interface ProxyDeps {
  cfg: EdgeConfig;
  api?: ApiClient;
  logger: ProxyLogger;
  /** Test hook: maps a host name to an address instead of DNS. */
  resolve?: (host: string) => Promise<string>;
}

export interface ProxyMetrics {
  allowed: number;
  denied: number;
}

/** Host patterns are exact names or `*.suffix` (subdomains only, not the bare suffix). */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

export function inCidr(addr: string, cidr: string): boolean {
  const a = ipv4ToInt(addr.replace(/^::ffff:/, ""));
  const [base, bitsS] = cidr.split("/");
  const b = ipv4ToInt(base ?? "");
  const bits = Number(bitsS);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

const PRIVATE_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3"];

/** Loopback, link-local, private, multicast: addresses an allow-listed name must never lead to. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, "");
  if (net.isIPv4(a)) return PRIVATE_V4.some((c) => inCidr(a, c));
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fe80:") || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("ff");
  }
  return true;
}

type Caller = { kind: "run"; runId: string; token: string } | { kind: "system" } | { kind: "none" };

interface AllowEntry {
  hosts: string[];
  at: number;
  projectId?: string;
}

/**
 * The :8444 forward proxy (spec 5.3 Outbound allow-list, 12.2). CONNECT for HTTPS, plain absolute-URI forwarding for HTTP.
 *   - A runner presents its run token as the proxy password (HTTPS_PROXY=http://run:<token>@gantry-edge:8444); the API names the
 *     project's allow-list for that run, and refuses revoked, stopped or superseded runs.
 *   - A caller with no credentials from outside the run subnet is the worker and gets the system allow-list (integration endpoints).
 *   - A caller with no credentials from inside the run subnet is refused (407).
 * Everything not listed is refused with 403 and logged, and reported to the API for the audit trail (deduplicated per minute).
 */
export function buildProxy(deps: ProxyDeps): { server: http.Server; metrics: ProxyMetrics } {
  const { cfg, logger } = deps;
  const api = deps.api ?? new ApiClient(cfg);
  const metrics: ProxyMetrics = { allowed: 0, denied: 0 };
  const cache = new Map<string, AllowEntry>();
  const reported = new Map<string, number>();

  const callerOf = (req: http.IncomingMessage): Caller | { kind: "bad" } => {
    const h = req.headers["proxy-authorization"];
    if (typeof h === "string") {
      const m = /^Basic\s+(\S+)$/i.exec(h);
      if (!m) return { kind: "bad" };
      const cred = Buffer.from(m[1]!, "base64").toString("utf8");
      const token = cred.slice(cred.indexOf(":") + 1);
      const runId = runIdOfToken(token);
      return runId ? { kind: "run", runId, token } : { kind: "bad" };
    }
    const ip = req.socket.remoteAddress ?? "";
    return inCidr(ip, cfg.runSubnet) ? { kind: "none" } : { kind: "system" };
  };

  async function allowList(c: Caller & { kind: "run" | "system" }): Promise<{ ok: true; hosts: string[] } | { ok: false; status: number; msg: string }> {
    const ck = c.kind === "run" ? `run:${c.runId}:${createHash("sha256").update(c.token).digest("hex").slice(0, 16)}` : "system";
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < cfg.allowlistTtlMs) return { ok: true, hosts: hit.hosts };
    cache.delete(ck);
    const r = c.kind === "run" ? await api.call("POST", `/internal/v1/runs/${encodeURIComponent(c.runId)}/egress`, { token: c.token }) : await api.call("GET", "/internal/v1/egress/system");
    if (r.kind === "unavailable") return { ok: false, status: 503, msg: "Allow-list unavailable; refused (fail closed)." };
    if (r.kind === "refused") return { ok: false, status: 403, msg: String(r.body.msg ?? "Run refused.") };
    const hosts = Array.isArray(r.body.hosts) ? r.body.hosts.filter((x): x is string => typeof x === "string") : [];
    cache.set(ck, { hosts, at: Date.now() });
    if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
    return { ok: true, hosts };
  }

  const reportDenied = (c: Caller, host: string, port: number, reason: string): void => {
    const key = `${c.kind === "run" ? c.runId : c.kind}|${host}:${port}`;
    const now = Date.now();
    if ((reported.get(key) ?? 0) > now - 60_000) return;
    reported.set(key, now);
    if (reported.size > 5000) reported.delete(reported.keys().next().value as string);
    void api.call("POST", "/internal/v1/egress/denied", { ...(c.kind === "run" ? { runId: c.runId, token: c.token } : {}), caller: c.kind === "run" ? "run" : "system", host, port, reason }).catch(() => undefined);
  };

  /** Authenticates the caller and checks host and port; returns the address to connect to, or writes the refusal through `deny`. */
  async function admit(req: http.IncomingMessage, host: string, port: number, deny: (status: number, msg: string) => void): Promise<string | null> {
    const c = callerOf(req);
    const refuse = (status: number, msg: string, cc: Caller): null => {
      metrics.denied++;
      logger.warn({ caller: cc.kind === "run" ? `run:${cc.runId}` : cc.kind, host, port, reason: msg }, "egress refused");
      if (status !== 503) reportDenied(cc, host, port, msg);
      deny(status, msg);
      return null;
    };
    if (c.kind === "bad") return refuse(407, "Valid proxy credentials are required.", { kind: "none" });
    if (c.kind === "none") return refuse(407, "Proxy credentials are required from a run network.", c);
    if (!cfg.allowedPorts.includes(port)) return refuse(403, `Port ${port} is not allowed.`, c);
    const list = await allowList(c);
    if (!list.ok) return refuse(list.status, list.msg, c);
    if (!hostAllowed(host, list.hosts)) return refuse(403, `Host ${host} is not on the allow-list.`, c);
    let addr: string;
    try {
      addr = deps.resolve ? await deps.resolve(host) : net.isIP(host) ? host : (await lookup(host, { all: true, verbatim: true })).map((x) => x.address).find((a) => !cfg.blockPrivateAddresses || !isPrivateAddress(a)) ?? "";
    } catch {
      return refuse(502, `Host ${host} could not be resolved.`, c);
    }
    if (!addr) return refuse(403, `Host ${host} resolves only to private addresses.`, c);
    if (cfg.blockPrivateAddresses && isPrivateAddress(addr)) return refuse(403, `Host ${host} resolves to a private address.`, c);
    metrics.allowed++;
    logger.info({ caller: c.kind === "run" ? `run:${c.runId}` : "system", host, port }, "egress allowed");
    return addr;
  }

  const server = http.createServer(async (req, res) => {
    const deny = (status: number, msg: string): void => {
      if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain", ...(status === 407 ? { "proxy-authenticate": 'Basic realm="gantry"' } : {}), connection: "close" });
      res.end(`${msg}\n`);
    };
    let u: URL;
    try {
      u = new URL(req.url ?? "");
      if (u.protocol !== "http:") throw new Error("not http");
    } catch {
      // Not an absolute-URI proxy request: the proxy has no other endpoints besides its health check.
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      deny(400, "This is a forward proxy: use CONNECT or an absolute http:// URL.");
      return;
    }
    const port = u.port ? Number(u.port) : 80;
    const addr = await admit(req, u.hostname, port, deny);
    if (!addr) return;
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const up = http.request({ host: addr, port, method: req.method, path: u.pathname + u.search, headers: { ...headers, host: u.host } }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.setTimeout(120_000, () => up.destroy());
    up.on("error", () => deny(502, "Upstream connection failed."));
    req.pipe(up);
  });

  server.on("connect", async (req, clientSocket: net.Socket, head) => {
    const deny = (status: number, msg: string): void => {
      clientSocket.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : status === 403 ? "Forbidden" : "Bad Gateway"}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="gantry"\r\n' : ""}Content-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(msg) + 1}\r\n\r\n${msg}\n`);
    };
    clientSocket.on("error", () => undefined);
    const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(req.url ?? "");
    if (!m) return deny(400, "Bad CONNECT target.");
    const host = (m[1] ?? m[2])!;
    const port = Number(m[3]);
    const addr = await admit(req, host, port, deny);
    if (!addr) return;
    const upstream = net.connect({ host: addr, port });
    upstream.setTimeout(300_000, () => upstream.destroy());
    upstream.on("error", () => {
      if (!clientSocket.writableEnded) deny(502, "Upstream connection failed.");
      clientSocket.destroy();
    });
    upstream.on("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
  });

  return { server, metrics };
}
