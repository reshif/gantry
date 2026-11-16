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
  limits?: Partial<RunLimits>;
  /** Test hook: maps a host name to an address instead of DNS. */
  resolve?: (host: string) => Promise<string>;
}

/** Per-run ceilings on what one run can make the shared edge do (it also serves the model gateway for every run). */
export interface RunLimits {
  /** Denied-egress events recorded per run per minute; past this a single "suppressed" event is recorded and the rest are only counted. */
  deniedEventsPerMinute: number;
  /** CONNECT tunnels (including ones still being opened) one run may hold at once. */
  maxTunnelsPerRun: number;
  /** Absolute lifetime of a tunnel: a keepalive stream cannot outlive it. */
  tunnelLifetimeMs: number;
  /** Largest request body forwarded on the plain HTTP path. */
  maxHttpBodyBytes: number;
}
export const DEFAULT_RUN_LIMITS: RunLimits = { deniedEventsPerMinute: 20, maxTunnelsPerRun: 16, tunnelLifetimeMs: 3_600_000, maxHttpBodyBytes: 16 * 1024 * 1024 };

export interface ProxyMetrics {
  allowed: number;
  denied: number;
  /** Denial reports not recorded in the ledger because the run was over its per-minute budget. */
  deniedSuppressed: number;
  /** CONNECTs refused because the run already held its maximum number of tunnels. */
  tunnelRefused: number;
  /** CONNECT tunnels cut because their run was refused after they were established. */
  cut: number;
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
  const a = ipv4ToInt(addr.replace(/^::ffff:/i, ""));
  const [base, bitsS] = cidr.split("/");
  const b = ipv4ToInt(base ?? "");
  const bits = Number(bitsS);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

const PRIVATE_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3"];

/** Expands an IPv6 literal to its 16 bytes (null when it is not one). Handles `::` and a trailing dotted IPv4 part. */
function ipv6Bytes(addr: string): number[] | null {
  let a = addr.toLowerCase();
  const pct = a.indexOf("%");
  if (pct >= 0) a = a.slice(0, pct);
  if (!net.isIPv6(a)) return null;
  let tail: number[] = [];
  const lastColon = a.lastIndexOf(":");
  const last = a.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    tail = [(v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255];
    a = a.slice(0, lastColon + 1) + (a.endsWith("::" + last) ? "" : "0");
    if (a.endsWith(":0")) a = a.slice(0, -2);
  }
  const groupsWanted = 8 - tail.length / 2;
  const [head, rest] = a.includes("::") ? a.split("::") as [string, string] : [a, null];
  const h = head ? head.split(":").filter((x) => x !== "") : [];
  const r = rest !== null && rest !== undefined ? rest.split(":").filter((x) => x !== "") : [];
  const fill = rest === null ? 0 : groupsWanted - h.length - r.length;
  const groups = [...h, ...Array(Math.max(0, fill)).fill("0"), ...r];
  if (groups.length !== groupsWanted) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out.push((n >>> 8) & 255, n & 255);
  }
  return [...out, ...tail];
}

const v4Of = (b: number[], at: number): string => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

/**
 * Loopback, link-local, private, multicast, reserved: addresses an allow-listed name must never lead to. IPv6 forms that embed an IPv4
 * address (mapped ::ffff:0:0/96 in any spelling, compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16) are judged by that IPv4 address.
 */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:(?=\d+\.)/i, "");
  if (net.isIPv4(a)) return PRIVATE_V4.some((c) => inCidr(a, c));
  const b = ipv6Bytes(a);
  if (!b) return true;
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddress(v4Of(b, 12)); // mapped
  if (zero(0, 12)) return true; // ::, ::1 and the deprecated IPv4-compatible block
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return isPrivateAddress(v4Of(b, 12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(v4Of(b, 2)); // 6to4
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true; // 100::/64 discard
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  return false;
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
  const lim: RunLimits = { ...DEFAULT_RUN_LIMITS, ...deps.limits };
  const metrics: ProxyMetrics = { allowed: 0, denied: 0, deniedSuppressed: 0, tunnelRefused: 0, cut: 0 };
  /** Denial events recorded per caller in the current minute (the ledger takes one audit event per distinct host, so a run varying the name could otherwise grow it without bound). */
  const budget = new Map<string, { since: number; used: number }>();
  /** Tunnels held or being opened, per run. */
  const holding = new Map<string, number>();
  const cache = new Map<string, AllowEntry>();
  const reported = new Map<string, number>();
  /** Established CONNECT tunnels per run (spec 4.4): cut when the run's token is revoked or the run is stopped, instead of living until teardown or the idle timeout. */
  const tunnels = new Map<string, { token: string; sockets: Set<net.Socket>; failures: number }>();

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
    const who = c.kind === "run" ? c.runId : c.kind;
    let b = budget.get(who);
    if (!b || b.since <= now - 60_000) budget.set(who, (b = { since: now, used: 0 }));
    if (b.used >= lim.deniedEventsPerMinute) {
      metrics.deniedSuppressed++;
      return;
    }
    b.used++;
    if (budget.size > 5000) budget.delete(budget.keys().next().value as string);
    // The last event of the minute says that the rest are not recorded, so the ledger shows the run was throttled.
    if (b.used === lim.deniedEventsPerMinute) {
      host = "(many hosts)";
      port = 0;
      reason = `More than ${lim.deniedEventsPerMinute} distinct denied destinations in a minute; further denials this minute are counted by the edge, not recorded.`;
    }
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
    let sent = 0;
    req.on("data", (chunk: Buffer) => {
      sent += chunk.length;
      if (sent > lim.maxHttpBodyBytes) {
        up.destroy();
        req.unpipe(up);
        deny(413, "Request body is too large for the forward proxy.");
        req.destroy();
      }
    });
    req.pipe(up);
  });

  server.on("connect", async (req, clientSocket: net.Socket, head) => {
    const deny = (status: number, msg: string): void => {
      clientSocket.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "Bad Gateway"}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="gantry"\r\n' : ""}Content-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(msg) + 1}\r\n\r\n${msg}\n`);
    };
    clientSocket.on("error", () => undefined);
    const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(req.url ?? "");
    if (!m) return deny(400, "Bad CONNECT target.");
    const host = (m[1] ?? m[2])!;
    const port = Number(m[3]);
    // Reserve a tunnel slot before the (slow) admit and connect, so a burst of opens cannot overshoot the per-run cap.
    const who = callerOf(req);
    const slot = who.kind === "run" ? who.runId : null;
    if (slot !== null) {
      if ((holding.get(slot) ?? 0) >= lim.maxTunnelsPerRun) {
        metrics.tunnelRefused++;
        logger.warn({ caller: `run:${slot}`, host, port, limit: lim.maxTunnelsPerRun }, "egress tunnel limit reached");
        return deny(429, `This run already holds ${lim.maxTunnelsPerRun} tunnels.`);
      }
      holding.set(slot, (holding.get(slot) ?? 0) + 1);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        const n = (holding.get(slot) ?? 1) - 1;
        if (n <= 0) holding.delete(slot);
        else holding.set(slot, n);
      };
      clientSocket.once("close", release);
    }
    const addr = await admit(req, host, port, deny);
    if (!addr) return;
    const upstream = net.connect({ host: addr, port });
    upstream.setTimeout(300_000, () => upstream.destroy());
    // An absolute lifetime as well: the idle timeout alone lets a keepalive stream live forever.
    const lifetime = setTimeout(() => { upstream.destroy(); clientSocket.destroy(); }, lim.tunnelLifetimeMs);
    lifetime.unref();
    clientSocket.once("close", () => clearTimeout(lifetime));
    upstream.on("error", () => {
      if (!clientSocket.writableEnded) deny(502, "Upstream connection failed.");
      clientSocket.destroy();
    });
    upstream.on("connect", () => {
      const c = callerOf(req);
      if (c.kind === "run") {
        const t = tunnels.get(c.runId) ?? { token: c.token, sockets: new Set<net.Socket>(), failures: 0 };
        t.token = c.token;
        t.sockets.add(clientSocket);
        t.sockets.add(upstream);
        tunnels.set(c.runId, t);
        const drop = (): void => {
          t.sockets.delete(clientSocket);
          t.sockets.delete(upstream);
          if (t.sockets.size === 0 && tunnels.get(c.runId) === t) tunnels.delete(c.runId);
        };
        clientSocket.once("close", drop);
        upstream.once("close", drop);
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
  });

  // Re-ask the API about every run that holds a tunnel. A clear refusal (revoked, stopped, superseded) cuts all of that run's tunnels at once; an unreachable API
  // cuts them after three failed rounds in a row (the proxy fails closed for new connections at once, but a blip must not drop healthy long-lived tunnels).
  const sweepTunnels = async (): Promise<void> => {
    await Promise.all([...tunnels.entries()].map(async ([runId, t]) => {
      const r = await api.call("POST", `/internal/v1/runs/${encodeURIComponent(runId)}/egress`, { token: t.token });
      if (r.kind === "ok") { t.failures = 0; return; }
      if (r.kind === "unavailable" && ++t.failures < 3) return;
      const why = r.kind === "refused" ? String(r.body.msg ?? "Run refused.") : "Allow-list unavailable.";
      logger.warn({ caller: `run:${runId}`, tunnels: t.sockets.size / 2, reason: why }, "egress tunnels cut");
      metrics.cut += t.sockets.size / 2;
      for (const s of t.sockets) s.destroy();
      tunnels.delete(runId);
    }));
  };
  if (cfg.tunnelCheckMs > 0) {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void sweepTunnels().catch(() => undefined).finally(() => { busy = false; });
    }, cfg.tunnelCheckMs);
    timer.unref();
    server.on("close", () => clearInterval(timer));
  }

  return { server, metrics };
}
