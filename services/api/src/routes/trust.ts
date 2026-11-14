/**
 * Trust ladder (spec 8.7, 13.3). Owns:
 *   GET /api/v1/trust/cells[?project=], POST /api/v1/trust/grants, POST /api/v1/trust/proposals/{id}/decide
 *   POST /api/v1/trust/cells/{id}/demote, PUT /api/v1/trust/criteria, POST/DELETE /api/v1/trust/ceilings, PUT /api/v1/trust/sample-rate
 *   PUT /api/v1/trust/switch (levels above L1, off in a new install), POST /api/v1/work-orders/{id}/outcomes (a post-release outcome, with its attribution)
 * A grant needs `trust.grant` on the cell's project; criteria, ceilings, the spot-check rate and the switch need `trust.criteria`. Every change goes through command().
 * Cells are only ever raised by a person with a reason (I6: no agent route reaches here); demotion by the rules is automatic and lives in the flow engine.
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Tx } from "@gantry/db";
import { command, policyState, refuse } from "../core/index.js";
import { demoteTrust, decideTrustProposal, grantTrust, recordOutcomeTrust, removeCeiling, saveCeiling, setSampleRate, setTrustCriteria, setTrustSwitch, targetProject } from "../areas/trust/commands.js";
import { readCriteria } from "../areas/trust/config.js";
import { readTrust } from "../areas/trust/read.js";
import { CeilingBody, CellsQuery, CriteriaBody, DecideBody, DemoteBody, GrantBody, IdParam, OutcomeBody, SampleBody, SwitchBody } from "../areas/trust/schemas.js";
import { cellRows, ceilingRows, proposalRows } from "../areas/trust/store.js";
import { refuseIfFactoryKilled } from "../areas/integrations/stop.js";

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const trustRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const criteriaRev = async (tx: Tx): Promise<number | null> => (await readCriteria(tx, g.orgId)).version;

  app.get("/api/v1/trust/cells", async (req) => {
    const who = requirePerson(req);
    const q = CellsQuery.parse(req.query);
    const st = await policyState(req);
    const visible = visibleProjects(st, who).filter((p) => p.status !== "archived").map((p) => p.id);
    if (q.project && !visible.includes(q.project)) throw refuse("not_found", "No such project.");
    return readTrust(g.pool, g.orgId, { visible, project: q.project });
  });

  app.post("/api/v1/trust/grants", async (req) => {
    const b = GrantBody.parse(req.body);
    const project = await targetProject(g.pool, g.orgId, b.target);
    if (!project) throw refuse("not_found", "No such trust cell.");
    const cellId = typeof b.target === "string" ? b.target : null;
    return command(req, { action: "trust.grant", scope: { project }, ifMatch: async (tx) => (cellId ? (await cellRows(tx, g.orgId, cellId))[0]?.version ?? null : 0) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "trust levels");
      return grantTrust(tx, a, b);
    });
  });

  app.post("/api/v1/trust/proposals/:id/decide", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = DecideBody.parse(req.body);
    const p = (await proposalRows(g.pool, g.orgId, id))[0];
    const project = p ? (await cellRows(g.pool, g.orgId, p.cell_id))[0]?.project_id ?? null : null;
    if (!p || !project) throw refuse("not_found", "No such proposal.");
    return command(req, { action: "trust.grant", scope: { project } }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "trust levels");
      return decideTrustProposal(tx, a, id, b);
    });
  });

  app.post("/api/v1/trust/cells/:id/demote", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = DemoteBody.parse(req.body);
    const project = (await cellRows(g.pool, g.orgId, id))[0]?.project_id ?? null;
    if (!project) throw refuse("not_found", "No such trust cell.");
    return command(req, { action: "trust.grant", scope: { project }, ifMatch: async (tx) => (await cellRows(tx, g.orgId, id))[0]?.version ?? null }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "trust levels");
      return demoteTrust(tx, a, id, b.to, b.reason);
    });
  });

  app.put("/api/v1/trust/criteria", async (req) => {
    const b = CriteriaBody.parse(req.body);
    return command(req, { action: "trust.criteria", scope: {}, ifMatch: criteriaRev, ifMatchRequired: true }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "trust criteria");
      return setTrustCriteria(tx, a, b);
    });
  });

  app.put("/api/v1/trust/sample-rate", async (req) => {
    const b = SampleBody.parse(req.body);
    return command(req, { action: "trust.criteria", scope: {}, ifMatch: criteriaRev, ifMatchRequired: true }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "the spot-check rate");
      return setSampleRate(tx, a, b.n);
    });
  });

  app.put("/api/v1/trust/switch", async (req) => {
    const b = SwitchBody.parse(req.body);
    return command(req, { action: "trust.criteria", scope: {} }, (tx, a) => setTrustSwitch(tx, a, b.on, b.reason));
  });

  app.post("/api/v1/trust/ceilings", async (req) => {
    const b = CeilingBody.parse(req.body);
    return command(req, { action: "trust.criteria", scope: {}, idempotent: !b.id, ...(b.id ? { ifMatch: async (tx: Tx) => (await ceilingRows(tx, g.orgId, b.id))[0]?.version ?? null } : {}) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "trust ceilings");
      return saveCeiling(tx, a, b);
    });
  });

  app.delete("/api/v1/trust/ceilings/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    return command(req, { action: "trust.criteria", scope: {}, ifMatch: async (tx) => (await ceilingRows(tx, g.orgId, id))[0]?.version ?? null }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "trust ceilings");
      return removeCeiling(tx, a, id);
    });
  });

  app.post("/api/v1/work-orders/:id/outcomes", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = OutcomeBody.parse(req.body);
    const w = (await g.pool.query<{ project_id: string }>(`select project_id from work_orders where org_id = $1 and id = $2 and source <> 'eval'`, [g.orgId, id])).rows[0];
    if (!w) throw refuse("not_found", "No such work order.");
    return command(req, { action: "outcome.record", scope: { project: w.project_id, wo: id }, idempotent: true }, (tx, a) => recordOutcomeTrust(tx, a, id, b));
  });
};
