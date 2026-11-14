/**
 * Home and activity (spec 8.3). Owns:
 *   GET /api/v1/home       `sections` (built by the caller's rights), my approvals, my conversations, nav badges
 *   GET /api/v1/activity   the latest ledger entries the viewer may see (no longer read by Home)
 *
 * Reads only: nothing here changes state, so there is no command pipeline to go through.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { policyState, refuse } from "../core/index.js";
import { visibilityFor } from "../areas/audit/access.js";
import { latestAudit } from "../areas/audit/read.js";
import { computeHome } from "../areas/home/compute.js";

export const homeRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  app.get("/api/v1/home", async (req) => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "Home is for signed-in people.");
    const st0 = await policyState(req);
    const home = await computeHome({ db: g.pool, orgId: req.gx.orgId, principal: p, st0 });
    if (!home) throw refuse("denied", "Sign in to continue.");
    return home;
  });

  app.get("/api/v1/activity", async (req) => {
    const vis = await visibilityFor(req);
    const q = z.object({ project: z.string().min(1).max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(14) }).parse(req.query);
    return latestAudit(g.pool, req.gx.orgId, vis, q.project ? { project: q.project } : {}, q.limit);
  });
};
