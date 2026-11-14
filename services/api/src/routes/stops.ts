/**
 * Stop controls (spec 8.5, 9.7). Owns:
 *   POST /api/v1/stops (mode halt|kill), DELETE /api/v1/stops/{id}, POST /api/v1/stops/{id}/restore
 *   GET /api/v1/stops/impact?scope=&id=, GET /api/v1/stops
 * Stop id convention: `${scope}:${targetId}` with scope factory|project|repo|workorder. It names the active stop of that scope (a halt for DELETE, a kill for restore).
 *
 * The commands go through stopCommand(): the path touches only `stops`, `restore_approvals` and the event log. Making the stop true (cancelling attempts, releasing slots,
 * killing containers) is the worker's `stop.enforce` job. It is enqueued here in a separate step after the commit; if the jobs table is unhealthy the error is logged,
 * the response still reports the committed stop, and the reaper re-enqueues any active stop whose `enforced_at` is still null (see `pendingStops`).
 */
import { enqueue } from "@gantry/db";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { decide, policyState, refuse, refuseDecision, stopCommand, type CommandSpec } from "../core/index.js";
import { job } from "../core/jobs-contract.js";
import { visibleProjects } from "@gantry/domain";
import { resumeStop, restoreStop, setStop } from "../areas/stops/commands.js";
import { listStops, stopImpact } from "../areas/stops/reads.js";
import { parseStopId, resolveTarget, scopeFromApi, stopAction, type StopTarget } from "../areas/stops/targets.js";

const Via = z.string().max(20).optional();
const SetBody = z.looseObject({
  scope: z.enum(["factory", "project", "repo", "workorder", "wo"]),
  id: z.string().max(100).nullish(),
  mode: z.enum(["halt", "kill"]),
  reason: z.string().max(2000).default(""),
  inFlight: z.enum(["hold", "cancel"]).nullish(),
  confirmText: z.string().max(200).nullish(),
  via: Via,
});
const LiftBody = z.looseObject({ reason: z.string().max(2000).optional(), via: Via });
const RestoreBody = z.looseObject({ reason: z.string().max(2000).default(""), via: Via });
const Id = z.object({ id: z.string().min(1).max(300) });

const scopeOf = (t: StopTarget): CommandSpec["scope"] => ({ project: t.project, repo: t.repo, wo: t.wo });

export const stopRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  /** Post-commit, failure-tolerant: the stop is already true in `stops`. */
  async function enforceLater(req: FastifyRequest, rowId: string, t: StopTarget, mode: "halt" | "kill", version: number): Promise<{ enqueued: boolean }> {
    try {
      const j = job("stop.enforce", { stopId: rowId, scope: t.scope, targetId: t.target, mode }, { dedupeKey: `stop.enforce:${rowId}:v${version}`, priority: 100 });
      await enqueue(g.pool, { orgId: req.gx.orgId, kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}), ...(j.priority !== undefined ? { priority: j.priority } : {}) });
      return { enqueued: true };
    } catch (err) {
      req.log.error({ err, stop: rowId }, "stop committed but stop.enforce could not be enqueued; the reaper will pick it up");
      return { enqueued: false };
    }
  }

  app.post("/api/v1/stops", async (req) => {
    const b = SetBody.parse(req.body);
    const t = await resolveTarget(g.pool, req.gx.orgId, b.scope, b.id);
    const impact = b.mode === "kill" ? await stopImpact(g.pool, req.gx.orgId, t).catch(() => null) : null;
    const r = await stopCommand(req, { action: stopAction(b.mode, t.scope), scope: scopeOf(t), idempotent: true }, (tx, a) => setStop(tx, a, t, { mode: b.mode, reason: b.reason, inFlight: b.inFlight ?? null, confirmText: b.confirmText ?? null }));
    const enf = await enforceLater(req, String(r.stop), t, b.mode, 1);
    const { list: _l, ...counts } = impact ?? { list: [] };
    return { ...r, enforcement: enf.enqueued ? "queued" : "pending", ...(impact ? { impact: counts } : {}) };
  });

  app.delete("/api/v1/stops/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const b = LiftBody.parse(req.body ?? {});
    const p = parseStopId(id);
    const t = await resolveTarget(g.pool, req.gx.orgId, p.scope, p.target);
    const r = await stopCommand(req, { action: stopAction("resume", t.scope), scope: scopeOf(t) }, (tx, a) => resumeStop(tx, a, t, b.reason ? { reason: b.reason } : {}));
    const enf = await enforceLater(req, String(r.stop), t, "halt", Number(r.version ?? 2));
    return { ...r, enforcement: enf.enqueued ? "queued" : "pending" };
  });

  app.post("/api/v1/stops/:id/restore", async (req) => {
    const { id } = Id.parse(req.params);
    const b = RestoreBody.parse(req.body ?? {});
    const p = parseStopId(id);
    const t = await resolveTarget(g.pool, req.gx.orgId, p.scope, p.target);
    const r = await stopCommand(req, { action: stopAction("restore", t.scope), scope: scopeOf(t) }, (tx, a) => restoreStop(tx, a, t, b.reason));
    if (r.pending) return r;
    const enf = await enforceLater(req, String(r.stop), t, "kill", Number(r.version ?? 2));
    return { ...r, enforcement: enf.enqueued ? "queued" : "pending" };
  });

  app.get("/api/v1/stops/impact", async (req) => {
    const q = z.object({ scope: z.enum(["factory", "project", "repo", "workorder", "wo"]), id: z.string().max(100).optional() }).parse(req.query);
    const principal = req.gx.principal;
    if (principal?.kind !== "person") throw refuse("denied", "The kill dialog is for signed-in people.");
    const t = await resolveTarget(g.pool, req.gx.orgId, q.scope, q.id);
    const d = await decide(req, stopAction("kill", scopeFromApi(q.scope)), scopeOf(t));
    if (!d.allowed) throw refuseDecision(d);
    const { list: _list, ...counts } = await stopImpact(g.pool, req.gx.orgId, t);
    return counts;
  });

  app.get("/api/v1/stops", async (req) => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "Sign in to continue.");
    const st = await policyState(req);
    const factoryRole = st.people.find((x) => x.id === p.id)?.roles.some((r) => r.scope === "factory");
    return { items: await listStops(g.pool, req.gx.orgId, { projects: factoryRole ? "all" : visibleProjects(st, p.id).map((x) => x.id) }) };
  });
};
