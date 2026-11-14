/**
 * Triggers (spec 8.8, 11.7, 12.5). Owns:
 *   GET/POST /api/v1/triggers, PATCH /api/v1/triggers/{id}, POST .../dry-run ("Simulate incoming"), GET .../runs, POST .../fire (a key)
 *   GET /api/v1/trigger-proposals, POST /api/v1/trigger-proposals/{id}/release and /decline
 * Triggers are off in a new install: each one starts disabled and the organisation has a master switch (api-config.triggersEnabled).
 */
import type { FastifyPluginAsync } from "fastify";
import { command, refuse } from "../core/index.js";
import { visibleToPerson } from "../areas/apikeys/visible.js";
import { registerTriggerSources } from "../areas/triggers/sources.js";
import { createTrigger, declineProposal, fireTrigger, patchTrigger, releaseProposal, simulateTrigger } from "../areas/triggers/commands.js";
import { CreateBody, DecideBody, DryRunBody, FireBody, IdParam, PatchBody, ProposalsQuery } from "../areas/triggers/schemas.js";
import { readProposalRow, readProposals, readRuns, readTriggerRow, readTriggers } from "../areas/triggers/store.js";

export const triggerRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  // Facts applied by the API (the broker posts what it polls) may be a trigger's source too; the worker installs the same observer.
  registerTriggerSources();

  /** A trigger the caller can see, or a 404 (a hidden project does not exist for them). */
  async function seen(req: Parameters<typeof visibleToPerson>[0], id: string) {
    const vis = await visibleToPerson(req);
    const row = await readTriggerRow(g.pool, g.orgId, id);
    if (!row || (vis !== "all" && !vis.includes(row.project_id ?? ""))) throw refuse("not_found", "No such trigger.");
    return row;
  }

  app.get("/api/v1/triggers", async (req) => readTriggers(g.pool, g.orgId, await visibleToPerson(req)));

  app.get("/api/v1/triggers/:id/runs", async (req) => {
    const { id } = IdParam.parse(req.params);
    await seen(req, id);
    return readRuns(g.pool, g.orgId, id);
  });

  app.post("/api/v1/triggers", async (req) => {
    const b = CreateBody.parse(req.body);
    return command(req, { action: "triggers.edit", scope: { project: b.project }, idempotent: true }, (tx, a) => createTrigger(tx, a, b));
  });

  app.patch("/api/v1/triggers/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = PatchBody.parse(req.body);
    const row = await seen(req, id);
    return command(req, { action: "triggers.edit", scope: { project: row.project_id }, ifMatch: async (tx) => (await readTriggerRow(tx, g.orgId, id))?.version ?? null }, (tx, a) => patchTrigger(tx, a, id, b));
  });

  app.post("/api/v1/triggers/:id/dry-run", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = DryRunBody.parse(req.body ?? {});
    const row = await seen(req, id);
    return command(req, { action: "triggers.edit", scope: { project: row.project_id }, idempotent: b.create === true }, (tx, a) => simulateTrigger(tx, a, id, b));
  });

  app.post("/api/v1/triggers/:id/fire", { config: { apiKey: "triggers.run" } }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = FireBody.parse(req.body ?? {});
    const p = req.gx.principal;
    if (p?.kind !== "apikey") throw refuse("denied", "Firing a trigger is for API keys; people use Simulate incoming.");
    const row = await readTriggerRow(g.pool, g.orgId, id);
    if (!row || (p.projectId && row.project_id !== p.projectId)) throw refuse("not_found", "No such trigger.");
    return command(req, { action: "triggers.run", scope: { project: row.project_id }, idempotent: true }, (tx, a) => fireTrigger(tx, a, id, p.id, p.projectId, b));
  });

  app.get("/api/v1/trigger-proposals", async (req) => readProposals(g.pool, g.orgId, await visibleToPerson(req), ProposalsQuery.parse(req.query)));

  const proposalScope = async (req: Parameters<typeof visibleToPerson>[0], id: string) => {
    const vis = await visibleToPerson(req);
    const p = await readProposalRow(g.pool, g.orgId, id);
    if (!p || (vis !== "all" && !vis.includes(p.project_id))) throw refuse("not_found", "No such proposal.");
    return p;
  };
  app.post("/api/v1/trigger-proposals/:id/release", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = DecideBody.parse(req.body ?? {});
    const p = await proposalScope(req, id);
    return command(req, { action: "wo.submit", scope: { project: p.project_id, repo: p.repo_id } }, (tx, a) => releaseProposal(tx, a, id, (b.note ?? "").trim()));
  });
  app.post("/api/v1/trigger-proposals/:id/decline", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = DecideBody.parse(req.body ?? {});
    const p = await proposalScope(req, id);
    return command(req, { action: "wo.submit", scope: { project: p.project_id, repo: p.repo_id } }, (tx, a) => declineProposal(tx, a, id, b.reason ?? b.note ?? ""));
  });
};
