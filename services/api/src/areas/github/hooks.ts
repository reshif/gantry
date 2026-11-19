/**
 * POST /hooks/github (spec 8.10, 11.6): verify the signature over the raw body, refuse replays by delivery id, store the payload and a delivery row,
 * enqueue a `github.event` job and acknowledge. Nothing is interpreted here: webhooks are hints, and processing is a job (`processGithubDelivery`).
 */
import { bodyHasNul } from "../../core/nul.js";
import { hookDenials } from "../../core/denial-sampler.js";
import type { FastifyPluginAsync } from "fastify";
import { appendEvent, decrypt, enqueue, withTx } from "@gantry/db";
import type { Queryable } from "@gantry/db";
import { job } from "../../core/jobs-contract.js";
import { sha256 } from "./store.js";
import { verifyGithubSignature } from "./signature.js";

const MAX_BODY = 5 * 1024 * 1024;

/** Webhook secrets of the enabled GitHub integration instances (secret_enc, sealed with the data key). The plain value or `{ "webhookSecret": ... }`. */
export async function webhookSecrets(db: Queryable, orgId: string, dataKey: Buffer | null): Promise<string[]> {
  if (!dataKey) return [];
  const { rows } = await db.query<{ id: string; secret_enc: string | null }>(
    `select id, secret_enc from integration_instances where org_id = $1 and type_id = 'github' and enabled and secret_enc is not null`,
    [orgId],
  );
  const out: string[] = [];
  for (const r of rows) {
    const d = [`integration:${r.id}`, undefined].map((aad) => decrypt(r.secret_enc!, dataKey, aad)).find((x) => x.ok);
    if (!d || !d.ok) continue;
    let v = d.value;
    if (v.trimStart().startsWith("{")) {
      try { v = String((JSON.parse(v) as { webhookSecret?: unknown }).webhookSecret ?? ""); } catch { v = ""; }
    }
    if (v) out.push(v);
  }
  return out;
}

export const githubHookRoutes: FastifyPluginAsync = async (app) => {
  // Encapsulated parser: the signature covers the exact bytes, so the body stays a Buffer until it is verified.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

  app.post("/hooks/github", { bodyLimit: MAX_BODY }, async (req, reply) => {
    const g = req.server.gantry;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    const event = String(req.headers["x-github-event"] ?? "");
    const signature = req.headers["x-hub-signature-256"];
    const audit = (type: string, outcome: "denied" | "failed", reason: string, suppressed = 0) =>
      withTx(g.pool, (tx) => appendEvent(tx, {
        orgId: g.orgId, type, category: "integrations", actor: "github-hook", channel: "github", subject: { type: "delivery", id: delivery || "unknown" }, outcome, rule: "HOOK-SIG",
        after: { reason, event: event.slice(0, 50), ...(delivery ? { delivery: delivery.slice(0, 100) } : {}), ...(suppressed ? { suppressed } : {}) }, requestId: req.id, sourceIp: req.ip || null,
      })).catch((err: unknown) => req.log.error({ err }, "could not audit hook denial"));

    const secrets = await webhookSecrets(g.pool, g.orgId, g.config.secrets.dataKey);
    if (!secrets.length) return reply.code(503).send({ ok: false, msg: "No GitHub webhook secret is configured." });
    if (!secrets.some((s) => verifyGithubSignature(raw, typeof signature === "string" ? signature : undefined, s))) {
      // Unauthenticated: sampled, so a flood of forged calls can't grow the ledger one row per request.
      const smp = hookDenials.sample("github", req.ip);
      if (smp.audit) await audit("github.hook.denied", "denied", signature ? "The signature does not match." : "The signature header is missing.", smp.suppressed);
      return reply.code(401).send({ ok: false, msg: "Invalid signature." });
    }
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(delivery) || !/^[a-z_]{1,50}$/.test(event)) return reply.code(400).send({ ok: false, msg: "Missing or malformed X-GitHub-Delivery or X-GitHub-Event." });
    try {
      if (bodyHasNul(JSON.parse(raw.toString("utf8")))) return reply.code(400).send({ ok: false, msg: "Text cannot contain a NUL character." }); // G-A4
    } catch { return reply.code(400).send({ ok: false, msg: "The body is not valid JSON." }); }

    const hash = sha256(raw);
    const fresh = await withTx(g.pool, async (tx) => {
      // Spec 5.3 replay protection: the signature covers the body, not the delivery id. The same signed body under another delivery id is a replay
      // (GitHub's own redelivery reuses the id, and distinct events never share a body byte for byte).
      const seen = await tx.query<{ delivery_id: string }>(`select delivery_id from inbound_deliveries where org_id = $1 and source = 'github' and payload_hash = $2 limit 1`, [g.orgId, hash]);
      if (seen.rows[0] && seen.rows[0].delivery_id !== delivery) {
        await appendEvent(tx, {
          orgId: g.orgId, type: "github.hook.denied", category: "integrations", actor: "github-hook", channel: "github", subject: { type: "delivery", id: delivery }, outcome: "denied", rule: "HOOK-REPLAY",
          after: { reason: `Replay of delivery ${seen.rows[0].delivery_id} under a new delivery id.`, event, delivery, payloadHash: hash }, requestId: req.id, sourceIp: req.ip || null,
        });
        return false;
      }
      const ins = await tx.query(
        `insert into inbound_deliveries (org_id, id, source, delivery_id, event_type, payload_hash) values ($1,$2,'github',$3,$4,$5) on conflict (org_id, source, delivery_id) do nothing`,
        [g.orgId, `gh-${delivery}`, delivery, event, hash],
      );
      if (!ins.rowCount) return false; // replay: acknowledged, never processed twice
      await tx.query(`insert into github_blobs (org_id, hash, kind, content, size_bytes) values ($1,$2,'payload',$3,$4) on conflict do nothing`, [g.orgId, hash, raw, raw.length]);
      const j = job("github.event", { deliveryId: delivery }, { dedupeKey: `github.event:${delivery}` });
      await enqueue(tx, { orgId: g.orgId, ...j });
      await appendEvent(tx, {
        orgId: g.orgId, type: "github.delivery.received", category: "integrations", actor: "github-hook", channel: "github", subject: { type: "delivery", id: delivery },
        after: { event, bytes: raw.length, payloadHash: hash }, requestId: req.id, sourceIp: req.ip || null,
      });
      return true;
    });
    return reply.code(202).send({ ok: true, delivery, duplicate: !fresh });
  });
};
