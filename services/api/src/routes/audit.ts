/**
 * Audit, activity and events (spec 8.9, 8.4). Owns:
 *   GET /api/v1/audit (filters: category, topic, project, actor, outcome, channel, q, changes; cursor pagination), GET /api/v1/audit/{seq}, GET /api/v1/audit/verify
 *   GET /api/v1/projects/{id}/events?from=&to=&kinds=
 *
 * All reads. The ledger is append-only and only the command pipeline writes to it, so nothing here changes state.
 */
import { visibleProjects } from "@gantry/domain";
import { verifyChain } from "@gantry/db";
import { anchorKeyFor, checkAnchors } from "../core/audit-anchor.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { decideFor, notFound, policyState, refuse } from "../core/index.js";
import { visibilityFor, requireVerifier } from "../areas/audit/access.js";
import { getAudit, listAudit, projectEvents } from "../areas/audit/read.js";

const Flag = z.preprocess((v) => (v === "true" || v === "1" || v === true ? true : v === "false" || v === "0" || v === false || v === undefined ? false : v), z.boolean());
const Query = z.object({
  category: z.string().min(1).max(40).optional(),
  topic: z.string().min(1).max(40).optional(),
  project: z.string().min(1).max(100).optional(),
  actor: z.string().min(1).max(200).optional(),
  outcome: z.string().min(1).max(20).optional(),
  channel: z.string().min(1).max(20).optional(),
  q: z.string().max(200).optional(),
  changes: Flag.optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  app.get("/api/v1/audit", async (req) => {
    const vis = await visibilityFor(req);
    const { cursor, limit, ...f } = Query.parse(req.query);
    return listAudit(g.pool, req.gx.orgId, vis, f, { limit, ...(cursor ? { cursor } : {}) });
  });

  // Registered before /audit/:seq so "verify" is never read as a sequence number (static routes win in Fastify regardless).
  app.get("/api/v1/audit/verify", async (req) => {
    await requireVerifier(req);
    const r = await verifyChain(g.pool, req.gx.orgId);
    if (r.ok) {
      // The chain is unkeyed and its head is in the same database, so it is also held to the signed checkpoints kept outside it.
      const a = await checkAnchors(g.pool, req.gx.orgId, g.config.auditAnchorFile, anchorKeyFor(g.config.secrets.sessionKey));
      if (a && "broken" in a) return { ok: false, checked: 0, anchorBroken: a.broken, msg: `The chain no longer matches a signed checkpoint at entry ${a.broken.seq} (${a.broken.kind.replace(/_/g, " ")}).` };
      return { ok: true, checked: r.value.count, headSeq: r.value.headSeq, head: r.value.headHash, ...(a ? { checkpoints: a.checked } : {}), ...(a && "fileMissing" in a ? { anchorFileMissing: true } : {}), msg: `Chain intact: ${r.value.count} entries verified${a ? `, ${a.checked} signed checkpoints match` : ""}.${a && "fileMissing" in a && r.value.count > 0 ? " Warning: the checkpoint file is missing, so the chain is not held to any signed checkpoint." : ""}` };
    }
    return { ok: false, checked: 0, broken: r.error, msg: `The chain is broken at entry ${r.error.seq} (${r.error.kind.replace(/_/g, " ")}).` };
  });

  app.get("/api/v1/audit/:seq", async (req) => {
    const vis = await visibilityFor(req);
    const { seq } = z.object({ seq: z.coerce.number().int().positive() }).parse(req.params);
    const e = await getAudit(g.pool, req.gx.orgId, vis, seq);
    if (!e) throw notFound("No such audit entry.");
    return e;
  });

  app.get("/api/v1/projects/:id/events", async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const q = z.object({
      from: z.coerce.number().finite().optional(),
      to: z.coerce.number().finite().optional(),
      kinds: z.string().max(1000).optional(),
      limit: z.coerce.number().int().min(1).max(20000).default(5000),
    }).parse(req.query);
    const st = await policyState(req);
    const p = req.gx.principal;
    if (!p) throw refuse("denied", "Sign in to continue.");
    const seen = p.kind === "person" ? visibleProjects(st, p.id).some((x) => x.id === id) : decideFor(st, p, "audit.view", {}).allowed;
    if (!seen || !st.projects.some((x) => x.id === id)) throw notFound("No such project.");
    return projectEvents(g.pool, req.gx.orgId, id, { ...(q.from !== undefined ? { from: q.from } : {}), ...(q.to !== undefined ? { to: q.to } : {}), ...(q.kinds ? { kinds: q.kinds.split(",").map((k) => k.trim()).filter(Boolean) } : {}), limit: q.limit });
  });
};
