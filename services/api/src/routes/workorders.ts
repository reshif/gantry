/**
 * Work orders, conversations, gates and the record (spec 8.4, 8.10). Owns:
 *   GET/POST /api/v1/projects/{id}/work-orders, GET /api/v1/work-orders/{id}
 *   GET /api/v1/conversations, POST /api/v1/work-orders/{id}/messages
 *   POST /api/v1/work-orders/{id}/reclassify, /confirm-brief, /decline
 *   POST /api/v1/gate-instances/{id}/approve, /reject            (id = `${woId}:${gateId}`, or `${woId}:${gateId}:${n}` for one exact opening)
 *   POST /api/v1/work-orders/{id}/move (dry_run), /send-back, /park, /unpark, /reassign, /retry
 *   GET /api/v1/work-orders/{id}/record, record.md, record/export, PUT .../record/summary, GET .../changes
 *
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4): the decision point, audit of success and denial, state and event in one
 * transaction, `If-Match` against the locked row, idempotent creates. Reads return the legacy shapes.
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { command, policyState, refuse, type CommandSpec } from "../core/index.js";
import { actionForGate, approveGate, parseGateId, rejectGate } from "../areas/workorders/gates.js";
import { addFollowup, decline, postMessage, reclassify, submitWO } from "../areas/workorders/intake.js";
import { dryRunMove, moveWO, park, reassign, retry, sendBack, setRecordSummary, unpark } from "../areas/workorders/moves.js";
import { woVersion, readWoRow } from "../areas/workorders/model.js";
import { listConversations, listWorkOrders, readChanges, readRecord, readTraveler, recordBundle, recordMarkdown } from "../areas/workorders/reads.js";

const Id = z.object({ id: z.string().min(1).max(100) });
const Via = z.string().max(20).optional();
const Reason = z.string().max(2000);

const SubmitBody = z.looseObject({
  repo: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).optional(),
  body: z.string().max(20000).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  requestedCls: z.string().min(1).max(60).nullish(),
  cls: z.string().min(1).max(60).nullish(),
  attachments: z.array(z.unknown()).max(20).optional(),
  source: z.string().min(1).max(40).optional(),
  paths: z.array(z.string().max(500)).max(500).optional(),
  onBehalfOf: z.string().max(100).optional(),
  via: Via,
});
const MessageBody = z.looseObject({ text: z.string().min(1).max(8000), kind: z.enum(["answer", "question", "followup"]).default("answer"), chips: z.array(z.string().max(200)).max(3).optional(), mode: z.string().max(40).optional(), via: Via });
const ReclassifyBody = z.looseObject({ cls: z.string().min(1).max(60), reason: Reason });
const ReasonBody = z.looseObject({ reason: Reason.default(""), via: Via });
const MoveBody = z.looseObject({ target: z.string().min(1).max(100), reason: Reason.optional(), dry_run: z.boolean().optional(), via: Via });
const SendBackBody = z.looseObject({ toStation: z.string().min(1).max(100), note: Reason.default(""), via: Via });
const ParkBody = z.looseObject({ bay: z.string().min(1).max(100), reason: Reason.default(""), via: Via });
const ReassignBody = z.looseObject({ agent: z.string().min(1).max(100), via: Via });
const SummaryBody = z.looseObject({ text: z.string().max(8000) });
const ListQ = z.object({
  q: z.string().max(200).optional(), cls: z.string().max(60).optional(), where: z.string().max(100).optional(), repo: z.string().max(100).optional(), prio: z.string().max(10).optional(),
  source: z.string().max(40).optional(), state: z.string().max(20).optional(), sort: z.enum(["id", "title", "cls", "where", "prio", "state", "age", "sla"]).optional(), dir: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const workOrderRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  /** The projects this principal may read, or "all" (factory-wide role). People see the projects their roles reach; an API key sees its own project. */
  async function visible(req: FastifyRequest): Promise<{ ids: Set<string> | "all"; viewer: string | null }> {
    const p = req.gx.principal;
    if (!p) throw refuse("denied", "Sign in to continue.");
    const st = await policyState(req);
    if (p.kind === "person") {
      const person = st.people.find((x) => x.id === p.id);
      if (person?.roles.some((r) => r.scope === "factory")) return { ids: "all", viewer: p.id };
      return { ids: new Set(visibleProjects(st, p.id).map((x) => x.id)), viewer: p.id };
    }
    if (p.kind === "apikey") return { ids: p.projectId ? new Set([p.projectId]) : "all", viewer: null };
    throw refuse("denied", "Services use /internal/v1, not the product API.");
  }
  const mustSee = async (req: FastifyRequest, projectId: string): Promise<string | null> => {
    const v = await visible(req);
    if (v.ids !== "all" && !v.ids.has(projectId)) throw refuse("not_found", "No such work order.");
    return v.viewer;
  };
  /** The work order's project, repo and version, read before the command so the decision point sees its scope. 404 for a work order the caller cannot see. */
  async function scopeOf(req: FastifyRequest, woId: string): Promise<{ project: string; repo: string | null; requestedBy: string | null; parent: string | null }> {
    const row = await readWoRow(g.pool, req.gx.orgId, woId);
    if (!row) throw refuse("not_found", "No such work order.");
    await mustSee(req, row.project);
    return { project: row.project, repo: row.repo, requestedBy: row.submitter, parent: row.parentId };
  }
  const spec = (woId: string, action: string | null, s: { project: string; repo: string | null }): CommandSpec => ({ action, scope: { project: s.project, repo: s.repo, wo: woId }, ifMatch: woVersion(g.orgId, woId) });

  /* ----------------------------------------------------------------- reads */

  app.get("/api/v1/projects/:id/work-orders", async (req) => {
    const { id } = Id.parse(req.params);
    await mustSee(req, id);
    return listWorkOrders(g.pool, req.gx.orgId, id, ListQ.parse(req.query));
  });

  app.get("/api/v1/work-orders/:id", async (req) => {
    const { id } = Id.parse(req.params);
    await scopeOf(req, id);
    const v = await visible(req);
    const t = await readTraveler(g.pool, req.gx.orgId, v.viewer, id);
    if (!t) throw refuse("not_found", "No such work order.");
    return { ...t.wo, gateProgress: t.progress, allowed: t.allowed, stop: t.stop, route: t.route };
  });

  app.get("/api/v1/conversations", async (req) => {
    const q = z.object({ project: z.string().max(100).optional(), awaitingMe: z.preprocess((x) => x === "true" || x === "1" || x === true, z.boolean()).optional() }).parse(req.query);
    const v = await visible(req);
    if (q.project) await mustSee(req, q.project);
    const items = await listConversations(g.pool, req.gx.orgId, { projects: v.ids === "all" ? "all" : [...v.ids], ...(q.project ? { project: q.project } : {}), ...(q.awaitingMe && v.viewer ? { awaitingMe: v.viewer } : {}) });
    return { items, next: null, total: items.length };
  });

  app.get("/api/v1/work-orders/:id/record", async (req) => {
    const { id } = Id.parse(req.params);
    await scopeOf(req, id);
    const r = await readRecord(g.pool, req.gx.orgId, id);
    if (!r) throw refuse("not_found", "No such work order.");
    return r;
  });
  app.get("/api/v1/work-orders/:id/record.md", async (req, reply) => {
    const { id } = Id.parse(req.params);
    await scopeOf(req, id);
    const r = await readRecord(g.pool, req.gx.orgId, id);
    if (!r) throw refuse("not_found", "No such work order.");
    return reply.type("text/markdown; charset=utf-8").send(recordMarkdown(r));
  });
  app.get("/api/v1/work-orders/:id/record/export", async (req, reply) => {
    const { id } = Id.parse(req.params);
    await scopeOf(req, id);
    const r = await readRecord(g.pool, req.gx.orgId, id);
    if (!r) throw refuse("not_found", "No such work order.");
    return reply.header("content-disposition", `attachment; filename="${id}-record.json"`).send(recordBundle(r));
  });
  app.get("/api/v1/work-orders/:id/changes", async (req) => {
    const { id } = Id.parse(req.params);
    await scopeOf(req, id);
    return readChanges(g.pool, req.gx.orgId, id);
  });

  /* ----------------------------------------------------------------- commands */

  app.post("/api/v1/projects/:id/work-orders", async (req) => {
    const { id } = Id.parse(req.params);
    const b = SubmitBody.parse(req.body);
    return command(req, { action: "wo.submit", scope: { project: id, repo: b.repo }, idempotent: true }, (tx, a) =>
      submitWO(tx, a, id, {
        repo: b.repo, title: b.title, description: b.description ?? b.body ?? "", ...(b.priority ? { priority: b.priority } : {}), requestedCls: b.requestedCls ?? b.cls ?? null,
        ...(b.attachments ? { attachments: b.attachments } : {}), ...(b.source ? { source: b.source } : {}), ...(b.paths ? { paths: b.paths } : {}), ...(b.onBehalfOf ? { onBehalfOf: b.onBehalfOf } : {}),
      }),
    );
  });

  app.post("/api/v1/work-orders/:id/messages", async (req) => {
    const { id } = Id.parse(req.params);
    const b = MessageBody.parse(req.body);
    const s = await scopeOf(req, id);
    // The requester may always answer their own conversation (legacy: `wo.answer` or `requestedBy`).
    const own = b.kind !== "question" && req.gx.principal?.kind === "person" && s.requestedBy === req.gx.principal.id;
    const action = b.kind === "question" ? "wo.park" : own ? null : "wo.answer";
    return command(req, spec(id, action, s), (tx, a) => (b.kind === "followup" ? addFollowup(tx, a, id, { text: b.text, ...(b.chips ? { chips: b.chips } : {}), ...(b.mode ? { mode: b.mode } : {}) }) : postMessage(tx, a, id, { text: b.text, kind: b.kind })));
  });

  app.post("/api/v1/work-orders/:id/reclassify", async (req) => {
    const { id } = Id.parse(req.params);
    const b = ReclassifyBody.parse(req.body);
    return command(req, spec(id, "wo.classify", await scopeOf(req, id)), (tx, a) => reclassify(tx, a, id, b.cls, b.reason));
  });

  app.post("/api/v1/work-orders/:id/confirm-brief", async (req) => {
    const { id } = Id.parse(req.params);
    const via = z.looseObject({ via: Via }).parse(req.body ?? {}).via;
    return command(req, spec(id, "brief.confirm", await scopeOf(req, id)), (tx, a) => approveGate(tx, a, id, "G0G1", null, via ? { via } : {}));
  });

  app.post("/api/v1/work-orders/:id/decline", async (req) => {
    const { id } = Id.parse(req.params);
    const b = ReasonBody.parse(req.body);
    return command(req, spec(id, "wo.decline", await scopeOf(req, id)), (tx, a) => decline(tx, a, id, b.reason, b.via));
  });

  /** Approve or reject: the gate comes from the instance id, so the right (brief.confirm, release, gate.approve, the gate's own action) is the one that gate needs. */
  const gateAction = async (req: FastifyRequest, gateId: string, verb: "approve" | "reject"): Promise<string> => {
    const st = await policyState(req);
    return verb === "reject" && gateId === "G0G1" ? "wo.decline" : actionForGate(st.catalog, gateId);
  };
  app.post("/api/v1/gate-instances/:id/approve", async (req) => {
    const { id } = Id.parse(req.params);
    const gi = parseGateId(id);
    const via = z.looseObject({ via: Via }).parse(req.body ?? {}).via;
    return command(req, spec(gi.woId, await gateAction(req, gi.gateId, "approve"), await scopeOf(req, gi.woId)), (tx, a) => approveGate(tx, a, gi.woId, gi.gateId, gi.n, via ? { via } : {}));
  });
  app.post("/api/v1/gate-instances/:id/reject", async (req) => {
    const { id } = Id.parse(req.params);
    const gi = parseGateId(id);
    const b = ReasonBody.parse(req.body);
    return command(req, spec(gi.woId, await gateAction(req, gi.gateId, "reject"), await scopeOf(req, gi.woId)), (tx, a) => rejectGate(tx, a, gi.woId, gi.gateId, gi.n, b.reason, b.via));
  });

  app.post("/api/v1/work-orders/:id/move", async (req) => {
    const { id } = Id.parse(req.params);
    const b = MoveBody.parse(req.body);
    const s = await scopeOf(req, id);
    if (b.dry_run) {
      const viewer = (await visible(req)).viewer;
      const m = await dryRunMove(g.pool, req.gx.orgId, viewer, id, b.target);
      return { ok: true, msg: m.reason, allowed: m.allowed, reason: m.reason, ...(m.kind ? { kind: m.kind } : {}) };
    }
    return command(req, spec(id, "wo.move", s), (tx, a) => moveWO(tx, a, id, b.target, b.reason));
  });
  app.post("/api/v1/work-orders/:id/send-back", async (req) => {
    const { id } = Id.parse(req.params);
    const b = SendBackBody.parse(req.body);
    return command(req, spec(id, "wo.sendback", await scopeOf(req, id)), (tx, a) => sendBack(tx, a, id, b.toStation, b.note));
  });
  app.post("/api/v1/work-orders/:id/park", async (req) => {
    const { id } = Id.parse(req.params);
    const b = ParkBody.parse(req.body);
    return command(req, spec(id, b.bay === "declined" ? "wo.decline" : "wo.park", await scopeOf(req, id)), (tx, a) => park(tx, a, id, b.bay, b.reason));
  });
  app.post("/api/v1/work-orders/:id/unpark", async (req) => {
    const { id } = Id.parse(req.params);
    const b = ReasonBody.parse(req.body ?? {});
    return command(req, spec(id, "wo.park", await scopeOf(req, id)), (tx, a) => unpark(tx, a, id, b.reason || undefined));
  });
  app.post("/api/v1/work-orders/:id/reassign", async (req) => {
    const { id } = Id.parse(req.params);
    const b = ReassignBody.parse(req.body);
    return command(req, spec(id, "wo.reassign", await scopeOf(req, id)), (tx, a) => reassign(tx, a, id, b.agent));
  });
  app.post("/api/v1/work-orders/:id/retry", async (req) => {
    const { id } = Id.parse(req.params);
    return command(req, spec(id, "wo.sendback", await scopeOf(req, id)), (tx, a) => retry(tx, a, id));
  });

  app.put("/api/v1/work-orders/:id/record/summary", async (req) => {
    const { id } = Id.parse(req.params);
    const b = SummaryBody.parse(req.body);
    return command(req, spec(id, "wo.answer", await scopeOf(req, id)), (tx, a) => setRecordSummary(tx, a, id, b.text));
  });
};
