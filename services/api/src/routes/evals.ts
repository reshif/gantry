/**
 * Evals (spec 8.7, 13.2). Owns:
 *   GET /api/v1/evals/scorecards, GET /api/v1/evals/factory, GET /api/v1/evals/runs (every suite's recent runs), GET /api/v1/suites
 *   GET/POST /api/v1/suites/{id}/runs, POST /api/v1/suites/{id}/runs/{run}/cancel, POST /api/v1/suites/{id}/cases
 * Reads are for signed-in people. A run is real work through the production runtime in sandboxes with no write access to real repositories, under its own concurrency
 * cap and behind work orders; every change goes through command() with `eval.run`.
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { command, policyState, refuse } from "../core/index.js";
import { addEvalCase, cancelRun, runSuite } from "../areas/evals/commands.js";
import { CaseBody, IdParam, RunBody, RunParam } from "../areas/evals/schemas.js";
import { readFactory, readScorecards } from "../areas/evals/scorecards.js";
import { readRuns, readSuites } from "../areas/evals/store.js";

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const evalRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const spec = (idem = false) => ({ action: "eval.run", scope: {}, ...(idem ? { idempotent: true } : {}) });

  app.get("/api/v1/suites", async (req) => {
    requirePerson(req);
    return readSuites(g.pool, g.orgId);
  });

  /** Every suite's recent runs in one request: the Evals screen reads these instead of one request per suite. */
  app.get("/api/v1/evals/runs", async (req) => {
    requirePerson(req);
    return readRuns(g.pool, g.orgId, null);
  });

  app.get("/api/v1/suites/:id/runs", async (req) => {
    requirePerson(req);
    const { id } = IdParam.parse(req.params);
    if (!(await g.pool.query(`select 1 from suites where org_id = $1 and id = $2`, [g.orgId, id])).rowCount) throw refuse("not_found", "No such suite.");
    return readRuns(g.pool, g.orgId, id);
  });

  app.get("/api/v1/evals/scorecards", async (req) => {
    requirePerson(req);
    return readScorecards(g.pool, g.orgId);
  });

  app.get("/api/v1/evals/factory", async (req) => {
    const who = requirePerson(req);
    const st = await policyState(req);
    const factoryWide = st.people.find((x) => x.id === who)?.roles.some((r) => r.scope === "factory") ?? false;
    return readFactory(g.pool, g.orgId, new Date(), factoryWide ? null : visibleProjects(st, who).map((p) => p.id));
  });

  app.post("/api/v1/suites/:id/runs", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = RunBody.parse(req.body);
    return command(req, spec(true), (tx, a) => runSuite(tx, a, id, b));
  });

  app.post("/api/v1/suites/:id/runs/:run/cancel", async (req) => {
    const { id, run } = RunParam.parse(req.params);
    return command(req, spec(), (tx, a) => cancelRun(tx, a, id, run));
  });

  app.post("/api/v1/suites/:id/cases", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = CaseBody.parse(req.body);
    return command(req, spec(true), (tx, a) => addEvalCase(tx, a, id, b));
  });
};
