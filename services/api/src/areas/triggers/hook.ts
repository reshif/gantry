/**
 * POST /hooks/trigger/{connection} (spec 12.1, 12.5): the signed webhook in of a custom connection that is a trigger source. The sender signs `<t>.<body>` with the
 * connection's signing secret (the same `t=<unix>,v1=<hmac-sha256>` scheme Gantry uses for its own outbound webhooks), within a five-minute window. The delivery is stored
 * and deduplicated on source and delivery id, acknowledged, then offered to the connection's triggers by a job. Nothing in the body is trusted.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendEvent, enqueue, withTx } from "@gantry/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { job } from "../../core/jobs-contract.js";
import { sha256 } from "../github/store.js";
import { open } from "../integrations/secrets.js";
import { readInstanceRow, readType } from "../integrations/store.js";

const MAX_BODY = 256 * 1024;
const WINDOW_S = 300;

const Body = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["issue", "comment", "ci"]).default("issue"),
  repo: z.string().min(1).max(300),
  title: z.string().max(2000).optional(),
  body: z.string().max(20000).optional(),
  labels: z.array(z.string().max(200)).max(100).optional(),
  author: z.string().max(200).optional(),
  comment: z.string().max(20000).optional(),
  ref: z.string().max(300).optional(),
  url: z.string().max(1000).optional(),
  check: z.string().max(300).optional(),
});

/** The header a receiver verifies and the sender builds: `t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>`. */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string, nowMs = Date.now()): boolean {
  const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec((header ?? "").trim());
  if (!m || Math.abs(nowMs / 1000 - Number(m[1])) > WINDOW_S) return false;
  const want = createHmac("sha256", secret).update(`${m[1]}.`).update(raw).digest();
  return timingSafeEqual(want, Buffer.from(m[2]!, "hex"));
}

export const triggerHookRoutes: FastifyPluginAsync = async (app) => {
  // Encapsulated parser: the signature covers the exact bytes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

  app.post("/hooks/trigger/:instance", { bodyLimit: MAX_BODY, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const g = req.server.gantry;
    const id = String((req.params as { instance?: string }).instance ?? "");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const audit = (type: string, reason: string) =>
      withTx(g.pool, (tx) => appendEvent(tx, {
        orgId: g.orgId, type, category: "integrations", actor: `hook:${id}`.slice(0, 100), channel: "api", subject: { type: "integration", id }, outcome: "denied", rule: "HOOK-SIG", after: { reason }, requestId: req.id, sourceIp: req.ip || null,
      })).catch((err: unknown) => req.log.error({ err }, "could not audit hook denial"));

    const inst = await readInstanceRow(g.pool, g.orgId, id);
    const type = inst ? await readType(g.pool, g.orgId, inst.type_id) : null;
    if (!inst || !type || !type.source || type.builtIn) return reply.code(404).send({ ok: false, msg: "No such webhook." });
    if (!inst.enabled) return reply.code(409).send({ ok: false, msg: `${inst.name} is switched off.` });
    const key = type.fields.find((f) => f.type === "secret")?.key ?? "secret";
    let secret = "";
    try { secret = open(g.config.secrets.dataKey, inst.id, inst.secret_enc, key)[key] ?? ""; } catch { /* reported below */ }
    if (!secret) return reply.code(503).send({ ok: false, msg: "This connection has no signing secret." });
    const sig = req.headers["x-gantry-signature"];
    if (!verifySignature(raw, typeof sig === "string" ? sig : undefined, secret)) {
      await audit("trigger.hook.denied", sig ? "The signature does not match or is outside the five-minute window." : "The signature header is missing.");
      return reply.code(401).send({ ok: false, msg: "Invalid signature." });
    }
    let parsed: z.infer<typeof Body>;
    try { parsed = Body.parse(JSON.parse(raw.toString("utf8"))); } catch (e) {
      return reply.code(422).send({ ok: false, msg: "The body must be JSON with id, repo and the event's fields.", ...(e instanceof z.ZodError ? { issues: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) } : {}) });
    }
    const hash = sha256(raw);
    const fresh = await withTx(g.pool, async (tx) => {
      const ins = await tx.query(
        `insert into inbound_deliveries (org_id, id, source, delivery_id, event_type, payload_hash) values ($1,$2,$3,$4,$5,$6) on conflict (org_id, source, delivery_id) do nothing`,
        [g.orgId, `trg-${inst.id}-${sha256(parsed.id).slice(0, 24)}`, `trigger:${inst.id}`, parsed.id, parsed.kind, hash],
      );
      if (!ins.rowCount) return false; // replay: acknowledged, never processed twice
      await tx.query(`insert into github_blobs (org_id, hash, kind, content, size_bytes) values ($1,$2,'payload',$3,$4) on conflict do nothing`, [g.orgId, hash, raw, raw.length]);
      const { id: _id, ...rest } = parsed;
      void _id;
      const j = job("trigger.evaluate", { ...rest, source: inst.id, delivery: parsed.id, dedupeKey: `hook:${inst.id}:${parsed.id}` }, { dedupeKey: `trigger.evaluate:hook:${inst.id}:${parsed.id}` });
      await enqueue(tx, { orgId: g.orgId, ...j });
      await appendEvent(tx, { orgId: g.orgId, type: "trigger.hook.received", category: "integrations", actor: `hook:${inst.id}`, channel: "api", subject: { type: "integration", id: inst.id }, outcome: "ok", after: { delivery: parsed.id, kind: parsed.kind, repo: parsed.repo }, requestId: req.id, sourceIp: req.ip || null });
      return true;
    });
    return reply.code(202).send({ ok: true, msg: fresh ? "Accepted." : "Already received.", duplicate: !fresh });
  });
};
