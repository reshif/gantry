/**
 * Learning loop (spec 8.7, 13.4). Owns:
 *   GET /api/v1/learning/findings, POST /api/v1/learning/findings/refresh, GET /api/v1/learning/signals, GET /api/v1/learning/settings, PUT /api/v1/learning/switch
 *   GET/POST /api/v1/learning/proposals, POST .../{id}/accept, /decline, /verify, /rollback
 * Everything needs `learning.apply`. Proposals are switched off in a new install (spec 15.3); findings and signals are evidence and are always recorded.
 * Accepting applies the change only through the ordinary command for it; the drafter cannot accept where a second person exists (see areas/learning/commands.ts).
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { command, decide, policyState, refuse } from "../core/index.js";
import { refuseIfFactoryKilled } from "../areas/integrations/stop.js";
import { proposalsOn } from "../areas/learning/config.js";
import { acceptProposal, declineProposal, draftProposal, otherDeciders, refreshCmd, rollbackProposal, setSwitch, verifyProposal } from "../areas/learning/commands.js";
import { findingRows, toFinding } from "../areas/learning/findings.js";
import { AcceptBody, DeclineBody, DraftBody, FindingParam, IdParam, RefreshBody, RollbackBody, SignalsQuery, SwitchBody, VerifyBody } from "../areas/learning/schemas.js";
import { collectSignals } from "../areas/learning/signals.js";
import { proposalRows, toProposal } from "../areas/learning/store.js";

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const learningRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  /** The projects a person sees: a finding or proposal about another project is not theirs to read. Factory-wide ones (no project) are visible to anyone who sees the screen. */
  const seen = async (req: FastifyRequest): Promise<{ who: string; ids: Set<string> }> => {
    const who = requirePerson(req);
    return { who, ids: new Set(visibleProjects(await policyState(req), who).map((p) => p.id)) };
  };
  const projOf = (c: Record<string, unknown>): string | null => (typeof c.project === "string" ? c.project : null);
  const scopeFor = async (project: string | null) => (project ? { project } : {});

  app.get("/api/v1/learning/findings", async (req) => {
    const s = await seen(req);
    return (await findingRows(g.pool, g.orgId)).filter((f) => !f.project_id || s.ids.has(f.project_id)).map(toFinding);
  });

  app.get("/api/v1/learning/proposals", async (req) => {
    const s = await seen(req);
    const findings = new Map((await findingRows(g.pool, g.orgId)).map((f) => [f.id, f]));
    return (await proposalRows(g.pool, g.orgId))
      .filter((r) => {
        const cp = projOf(r.change);
        const fp = r.finding_id ? findings.get(r.finding_id)?.project_id ?? null : null;
        return (!cp || s.ids.has(cp)) && (!fp || s.ids.has(fp));
      })
      .map(toProposal);
  });

  app.get("/api/v1/learning/signals", async (req) => {
    const s = await seen(req);
    const q = SignalsQuery.parse(req.query);
    const since = Date.now() - q.days * 86_400_000;
    return (await collectSignals(g.pool, g.orgId)).filter((x) => x.at >= since && (!x.project || s.ids.has(x.project))).slice(0, 1000);
  });

  /** The switch, and whether a second person could decide (so the screen can say why the drafter's Accept is locked). */
  app.get("/api/v1/learning/settings", async (req) => {
    const who = requirePerson(req);
    return { proposalsOn: await proposalsOn(g.pool, g.orgId), otherDeciders: (await otherDeciders(g.pool, g.orgId, who, null)).length };
  });

  app.put("/api/v1/learning/switch", async (req) => {
    const b = SwitchBody.parse(req.body);
    return command(req, { action: "learning.apply", scope: {} }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "learning");
      return setSwitch(tx, a, b.on, b.reason);
    });
  });

  app.post("/api/v1/learning/findings/refresh", async (req) => {
    RefreshBody.parse(req.body ?? {});
    return command(req, { action: "learning.apply", scope: {} }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "learning");
      return refreshCmd(tx, a);
    });
  });

  app.post("/api/v1/learning/proposals", async (req) => {
    const b = DraftBody.parse(req.body);
    const f = (await findingRows(g.pool, g.orgId, FindingParam.parse({ id: b.finding }).id))[0];
    if (!f) throw refuse("not_found", "No such finding.");
    const s = await seen(req);
    if (f.project_id && !s.ids.has(f.project_id)) throw refuse("not_found", "No such finding.");
    return command(req, { action: "learning.apply", scope: await scopeFor(f.project_id), idempotent: true }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "learning");
      return draftProposal(tx, a, b);
    });
  });

  /** The scope of a proposal: the project its change touches, else the project of its finding. Looked up outside the command so the decision point sees it. */
  const scopeOfProposal = async (id: string): Promise<{ project: string | null }> => {
    const r = (await proposalRows(g.pool, g.orgId, id))[0];
    if (!r) throw refuse("not_found", "No such proposal.");
    const fp = r.finding_id ? (await findingRows(g.pool, g.orgId, r.finding_id))[0]?.project_id ?? null : null;
    return { project: projOf(r.change) ?? fp };
  };
  const rev = (id: string) => async (tx: import("@gantry/db").Tx): Promise<number | null> => (await proposalRows(tx, g.orgId, id))[0]?.version ?? null;
  const ctxFor = (req: FastifyRequest, tx: import("@gantry/db").Tx) => ({ req, can: (action: string, scope: { project?: string | null }) => decide(req, action, scope, tx) });

  app.post("/api/v1/learning/proposals/:id/accept", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = AcceptBody.parse(req.body ?? {});
    const scope = await scopeOfProposal(id);
    return command(req, { action: "learning.apply", scope: await scopeFor(scope.project), ifMatch: rev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "learning");
      return acceptProposal(tx, a, ctxFor(req, tx), id, b.note);
    });
  });

  app.post("/api/v1/learning/proposals/:id/decline", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = DeclineBody.parse(req.body);
    const scope = await scopeOfProposal(id);
    return command(req, { action: "learning.apply", scope: await scopeFor(scope.project), ifMatch: rev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "learning");
      return declineProposal(tx, a, id, b.reason);
    });
  });

  app.post("/api/v1/learning/proposals/:id/verify", async (req) => {
    const { id } = IdParam.parse(req.params);
    VerifyBody.parse(req.body ?? {});
    const scope = await scopeOfProposal(id);
    return command(req, { action: "learning.apply", scope: await scopeFor(scope.project), ifMatch: rev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "learning");
      return verifyProposal(tx, a, id);
    });
  });

  app.post("/api/v1/learning/proposals/:id/rollback", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = RollbackBody.parse(req.body);
    const scope = await scopeOfProposal(id);
    return command(req, { action: "learning.apply", scope: await scopeFor(scope.project), ifMatch: rev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "learning");
      return rollbackProposal(tx, a, ctxFor(req, tx), id, b.reason);
    });
  });
};
