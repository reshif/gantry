import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { visibleProjects } from "@gantry/domain";
import type pg from "pg";
import { demoAccountList as demoAccountList_, type DemoAccountOut } from "../areas/access/demo.js";
import { enforceReadGate } from "./read-gates.js";
import { ApiSettingsCache } from "../areas/apikeys/config.js";
import { gateApiKey, logApiRequest, noteRejectedKey } from "../areas/apikeys/gate.js";
import { authenticateApiKey } from "./auth/apikeys.js";
import { authenticateService } from "./auth/service.js";
import { csrfFor, findSession, revokeSessions, touchSession } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Gantry, Principal } from "./context.js";
import { safeEqual } from "./crypto.js";
import { installErrorHandler } from "./errors.js";
import { createOidcAdapter, type OidcAdapter } from "./oidc.js";
import { canonicalPath } from "./paths.js";
import { pinVia } from "./command.js";
import { readOrg } from "./read/index.js";
import { loadPolicyState } from "./read/state.js";
import { ipAllowed, SecurityCache } from "./security.js";
import { registerMetrics } from "./metrics.js";
import { Hub } from "./stream.js";

export interface BuildOptions {
  pool: pg.Pool;
  config: Config;
  /** Resolved org uuid (see bootstrapOrg). */
  orgId: string;
  oidc?: OidcAdapter;
  logger?: boolean | object;
  /** Requests per minute per client (default 600). */
  rateLimitMax?: number;
  heartbeatMs?: number;
  /** How often open streams re-check their session (default 60 s). */
  sweepMs?: number;
  /** Bearer tokens that may scrape /metrics from outside the internal network (default: the metrics_token secret, when present). */
  metricsTokens?: readonly (string | null)[];
  /** Where the backup service writes its status files (default GANTRY_BACKUPS_DIR, else /backups). */
  backupsDir?: string;
  /** Registers the product routes (default: ./routes/index). Tests pass their own. */
  routes?: (app: FastifyInstance) => Promise<void> | void;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Public pieces of config the sign-in screen needs before anyone is signed in. */
export async function publicConfig(app: FastifyInstance): Promise<{ demoAccounts: boolean; githubLogin: boolean; orgName?: string; demoAccountList?: DemoAccountOut[] }> {
  const g = app.gantry;
  const sec = await g.security.get();
  const org = await readOrg(g.pool, g.orgId).catch(() => null);
  // Demo accounts are described from the live org (who exists, what they hold), never from a fixed text. Only sent when demo sign-in is on.
  const demoAccountList = g.config.demoAccounts
    ? await loadPolicyState(g.pool, g.orgId).then((st) => demoAccountList_(st, { bootstrapEmail: g.config.bootstrapAdminEmail })).catch(() => undefined)
    : undefined;
  return { demoAccounts: g.config.demoAccounts, githubLogin: !!sec.value.githubLogin && !!g.oidc.githubIdp, ...(org ? { orgName: org.name } : {}), ...(demoAccountList ? { demoAccountList } : {}) };
}

/** A URL as it may be logged: the path only. Every query is credential-bearing or attacker-chosen (names may be percent-encoded), so none is kept. */
export function logUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const i = url.indexOf("?");
  return i < 0 ? url : `${url.slice(0, i)}?[redacted]`;
}

/** The request as it is logged. Headers are left out on purpose (credential headers such as x-run-token, x-api-key and webhook signatures); the fields mirror Fastify's default serializer. */
export function logReq(r: { method?: string; url?: string; ip?: string; headers?: Record<string, unknown>; socket?: { remotePort?: number } }): Record<string, unknown> {
  const v = r.headers?.["accept-version"];
  return { method: r.method, url: logUrl(r.url), version: typeof v === "string" ? v : undefined, host: r.headers?.host, remoteAddress: r.ip, remotePort: r.socket?.remotePort };
}

/**
 * The Fastify app: request id, rate limit, error mapping, authentication (session cookie + CSRF, API-key bearer, service tokens),
 * the live-update hub and the product routes. Stateless: every replica serves any request.
 */
export async function buildApp(o: BuildOptions): Promise<FastifyInstance> {
  const { pool, config, orgId } = o;
  const app = Fastify({
    logger: o.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-csrf-token']", "res.headers['set-cookie']"],
      // Sign-in links carry credentials in the query (invite token, OIDC code and state, id_token_hint), so the log keeps the path only.
      serializers: { req: (r: { method?: string; url?: string; host?: string; remoteAddress?: string; remotePort?: number; headers?: unknown }) => ({ method: r.method, url: logUrl(r.url), host: r.host, remoteAddress: r.remoteAddress, remotePort: r.remotePort, headers: r.headers }) },
    },
    trustProxy: config.trustProxy,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && REQUEST_ID.test(h) ? h : randomUUID();
    },
    bodyLimit: 1024 * 1024,
  });
  installErrorHandler(app);
  await app.register(cookie);
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const e = new Error("invalid JSON") as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  const security = new SecurityCache(pool, orgId);
  const hub = new Hub(pool, orgId, {
    async refresh(s, batch) {
      let load = batch.get("policy") as ReturnType<typeof loadPolicyState> | undefined;
      if (!load) batch.set("policy", (load = loadPolicyState(pool, orgId)));
      const st = await load;
      const person = st.people.find((p) => p.id === s.personId);
      if (!person || person.status !== "active") return null;
      if (s.sessionId) {
        // Still live: not revoked, inside the absolute lifetime and the idle window (activity is any request, not the open stream).
        const idle = (await security.get()).value.idleMin;
        const { rows } = await pool.query(
          `select 1 from sessions where org_id = $1 and id = $2 and revoked_at is null and expires_at > now() and last_seen_at > now() - make_interval(mins => $3::int)`,
          [orgId, s.sessionId, idle],
        );
        if (!rows.length) return null;
      }
      return person.roles.some((r) => r.scope === "factory") ? "all" : new Set(visibleProjects(st, s.personId).map((p) => p.id));
    },
  }, o.sweepMs);
  const oidc = o.oidc ?? createOidcAdapter(config.oidc);
  const gantry: Gantry = { pool, config, orgId, hub, oidc, security, apiSettings: new ApiSettingsCache(pool, orgId), heartbeatMs: o.heartbeatMs ?? 15_000 };
  app.decorate("gantry", gantry);
  app.decorateRequest("gx", undefined as never);

  await app.register(rateLimit, {
    global: true,
    max: o.rateLimitMax ?? 600,
    timeWindow: "1 minute",
    allowList: (req) => {
      const path = canonicalPath(req.url) ?? "";
      return path === "/healthz" || path === "/metrics" || path.startsWith("/internal/v1/");
    },
    keyGenerator: (req) => req.ip,
  });

  app.addHook("onRequest", async (req, reply) => {
    req.gx = { orgId, principal: null, session: null, ip: req.ip, requestId: req.id, channel: "web", reply };
    const path = canonicalPath(req.url);
    if (path === null) return void (await reply.code(400).send({ ok: false, msg: "Malformed request path." }));
    if (path.startsWith("/internal/v1/")) return authInternal(req, reply);
    if (path.startsWith("/api/v1/")) {
      await authApi(app, req, reply);
      if (!reply.sent) await enforceReadGate(req, reply);
    }
  });

  // The audit channel comes from the transport: a client-sent `via` is pinned to what the caller may claim.
  app.addHook("preHandler", async (req) => pinVia(req));

  app.addHook("onResponse", logApiRequest);

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  app.get("/healthz", { config: { rateLimit: false }, logLevel: "warn" }, async (_req, reply) => {
    try {
      await pool.query("select 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, msg: "database unavailable" });
    }
  });

  await registerMetrics(app, { pool, orgId, backupsDir: o.backupsDir ?? process.env.GANTRY_BACKUPS_DIR ?? "/backups", ...(o.metricsTokens ? { tokens: o.metricsTokens } : {}) });

  await (o.routes ? o.routes(app) : (await import("../routes/index.js")).registerRoutes(app));

  app.addHook("onClose", async () => {
    await hub.close();
  });
  await hub.start();
  return app;
}

async function authInternal(req: FastifyRequest, reply: import("fastify").FastifyReply): Promise<void> {
  const g = req.server.gantry;
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
  const who = m ? authenticateService(m[1]!, g.config.secrets) : null;
  if (!who) {
    await reply.code(401).send({ ok: false, msg: "A valid service token is required." });
    return;
  }
  req.gx.principal = { kind: "service", id: who, name: who } satisfies Principal;
  req.gx.channel = "system";
}

async function authApi(app: FastifyInstance, req: FastifyRequest, reply: import("fastify").FastifyReply): Promise<void> {
  const g = app.gantry;
  const unauth = async (msg = "Sign in to continue.", clear = false): Promise<void> => {
    if (clear) reply.clearCookie(g.config.sessionCookie, { path: "/" });
    await reply.code(401).send({ ok: false, msg, config: await publicConfig(app).catch(() => ({ demoAccounts: g.config.demoAccounts, githubLogin: false })) });
  };
  const sec = (await g.security.get()).value;
  if (!ipAllowed(req.ip, sec.ipAllow)) {
    await reply.code(403).send({ ok: false, msg: "This network address is not on the allow-list.", rule: { kind: "invariant", id: "IP-ALLOW", name: "IP allow-list" } });
    return;
  }
  const auth = String(req.headers.authorization ?? "");
  if (auth) {
    const m = /^Bearer (gk_\S+)$/.exec(auth);
    const key = m ? await authenticateApiKey(g.pool, g.orgId, m[1]!) : null;
    if (!key) {
      if (m) await noteRejectedKey(req, m[1]!);
      return unauth("The API key is not valid.");
    }
    req.gx.principal = { kind: "apikey", id: key.id, name: key.name, projectId: key.projectId, scopes: key.scopes };
    req.gx.channel = "api";
    return gateApiKey(req, reply);
  }
  const token = req.cookies[g.config.sessionCookie];
  if (!token) return unauth();
  const s = await findSession(g.pool, g.config.secrets.sessionKey, g.orgId, token, sec.idleMin);
  if (!s) return unauth("Your session has ended. Sign in again.", true);
  if (s.personStatus !== "active") {
    await revokeSessions(g.pool, g.orgId, s.personId, null, "system").catch(() => undefined);
    return unauth("This account is not active.", true);
  }
  // Mutating requests from a browser must carry the session-bound CSRF token, and an Origin (when sent) must be ours.
  if (!SAFE.has(req.method)) {
    const sent = req.headers["x-csrf-token"];
    if (typeof sent !== "string" || !safeEqual(sent, csrfFor(g.config.secrets.sessionKey, s.id))) {
      await reply.code(403).send({ ok: false, msg: "The request is missing a valid CSRF token. Reload the page and try again.", rule: { kind: "invariant", id: "CSRF", name: "CSRF token" } });
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== g.config.publicUrl) {
      await reply.code(403).send({ ok: false, msg: "The request came from an unexpected origin.", rule: { kind: "invariant", id: "CSRF", name: "Origin check" } });
      return;
    }
  }
  // Only a person's own activity keeps a session from going idle: the app marks its timed polling and the live stream as background.
  if (req.headers["x-gantry-background"] !== "1" && !req.url.startsWith("/api/v1/stream")) void touchSession(g.pool, g.orgId, s).catch(() => undefined);
  req.gx.principal = { kind: "person", id: s.personId, name: s.personName, sessionId: s.id };
  req.gx.session = { id: s.id, personId: s.personId, method: s.method, authTime: s.authTime, createdAt: s.createdAt, expiresAt: s.expiresAt };
}
