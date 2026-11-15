/**
 * The public API gate (spec 8.10, 12.5). A bearer API key may use only the public endpoints (submit, track, record, answer, fire a trigger), only inside its
 * project and its scopes, and only within the organisation's rate limit. Everything it is refused is audited, and every request is logged (the Request log tab).
 * The work itself goes through the same handlers as the UI, so classification, intake, the decision point and the idempotency rules are the same.
 */
import { appendEvent, withTx } from "@gantry/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sha256Hex } from "../../core/crypto.js";
import { canonicalPath } from "../../core/paths.js";

/**
 * A route is reachable with an API key only if it declares so in its route options (`config: { apiKey: "<scope>", apiKeyProject: "<param>" }`): the scope the key must carry
 * (`"any"` for a self-check such as `/can`) and the path parameter that names the project the key must belong to. Everything else is refused, so a key can never reach
 * the screens people use, whatever scopes it carries.
 */
export interface ApiKeyRouteConfig { apiKey?: string; apiKeyProject?: string }

/** Which key a request belongs to, for the log: set for a valid key and, when the key is known but revoked or expired, for the 401 it gets. */
const keyOfRequest = new WeakMap<FastifyRequest, { id: string; project: string | null }>();

const pathOf = (req: FastifyRequest): string => (canonicalPath(req.url) ?? req.url.split("?")[0] ?? "").slice(0, 300);

/** A key that fails to authenticate may still be one we know (revoked, expired): the log records the refusal against it. */
export async function noteRejectedKey(req: FastifyRequest, secret: string): Promise<void> {
  const g = req.server.gantry;
  const { rows } = await g.pool.query<{ id: string; project_id: string | null }>(`select id, project_id from api_keys where org_id = $1 and key_hash = $2`, [g.orgId, sha256Hex(secret)]).catch(() => ({ rows: [] }));
  if (rows[0]) keyOfRequest.set(req, { id: rows[0].id, project: rows[0].project_id });
}

async function deny(req: FastifyRequest, reply: FastifyReply, status: number, msg: string, rule: { kind: string; id: string; name: string }, type: string, extra: Record<string, unknown> = {}): Promise<void> {
  const g = req.server.gantry;
  const p = req.gx.principal;
  if (p?.kind === "apikey") {
    await withTx(g.pool, (tx) =>
      appendEvent(tx, {
        orgId: g.orgId, type, category: "api", actor: `apikey:${p.id}`, channel: "api", subject: { type: "apikey", id: p.id }, projectId: p.projectId, outcome: "denied", rule: rule.id,
        after: { reason: msg, rule, method: req.method, path: pathOf(req), ...extra }, requestId: req.gx.requestId, sourceIp: req.gx.ip || null,
      }),
    ).catch((err: unknown) => req.log.error({ err }, "could not audit API key denial"));
  }
  await reply.code(status).send({ ok: false, msg, rule });
}

/** Runs after the key is authenticated. Returns once the request may continue; a refusal has already been sent. */
export async function gateApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const g = req.server.gantry;
  const p = req.gx.principal;
  if (p?.kind !== "apikey") return;
  keyOfRequest.set(req, { id: p.id, project: p.projectId });
  const decl = (req.routeOptions?.config ?? {}) as ApiKeyRouteConfig;
  if (!decl.apiKey) {
    await deny(req, reply, 403, "API keys can use the public API only: submit, read and answer work orders, and fire triggers.", { kind: "apikey", id: p.id, name: `API key ${p.name}` }, "api.route.denied");
    return;
  }
  if (decl.apiKey !== "any" && !p.scopes.includes(decl.apiKey) && !p.scopes.includes("*")) {
    await deny(req, reply, 403, `This API key is not scoped for ${decl.apiKey}.`, { kind: "apikey", id: p.id, name: `API key ${p.name}` }, `${decl.apiKey}.denied`, { needs: decl.apiKey });
    return;
  }
  const inUrl = decl.apiKeyProject ? (req.params as Record<string, string> | undefined)?.[decl.apiKeyProject] : undefined;
  if (inUrl !== undefined && p.projectId && inUrl !== p.projectId) {
    await deny(req, reply, 403, `This API key is limited to project ${p.projectId}.`, { kind: "apikey", id: p.id, name: `API key ${p.name}` }, `${decl.apiKey}.denied`);
    return;
  }
  const cfg = (await g.apiSettings.get()).value;
  const limit = cfg.rateLimit + cfg.burst;
  // Sliding minute: requests answered 429 do not count, so a client that backs off recovers.
  const edge = await g.pool.query<{ at: Date }>(
    `select at from api_requests where org_id = $1 and key_id = $2 and at > now() - interval '60 seconds' and status <> 429 order by at desc offset $3 limit 1`,
    [g.orgId, p.id, limit - 1],
  );
  if (edge.rows[0]) {
    const wait = Math.max(1, Math.ceil((edge.rows[0].at.getTime() + 60_000 - Date.now()) / 1000));
    reply.header("retry-after", String(wait));
    await reply.code(429).send({ ok: false, msg: `Rate limit reached: ${cfg.rateLimit} requests a minute with a burst of ${cfg.burst}. Retry in ${wait} s.`, rule: { kind: "rate-limit", id: "API-RATE", name: "API rate limit" } });
  }
}

/** onResponse: one row per API-key request, for the Request log. Never throws into the response. */
export async function logApiRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const k = keyOfRequest.get(req);
  if (!k || !req.gx) return;
  const g = req.server.gantry;
  await g.pool
    .query(
      `insert into api_requests (org_id, key_id, method, path, status, request_id, source_ip, duration_ms, project_id) values ($1,$2,$3,$4,$5,$6,$7::inet,$8,$9)`,
      [g.orgId, k.id, req.method, pathOf(req), reply.statusCode, req.gx.requestId, req.gx.ip || null, Math.max(0, Math.round(reply.elapsedTime)), k.project],
    )
    .catch((err: unknown) => req.log.error({ err }, "could not log API request"));
}
