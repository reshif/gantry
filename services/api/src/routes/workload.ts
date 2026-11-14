/**
 * Workload (spec 8.9, 13.5). Owns:
 *   GET /api/v1/workload?scope=<project id | all>&days=<1..30>
 * Computed from the work order records with the domain's workload functions and scoped to the projects the person can see. Read only: changing a delegate goes through
 * PUT /api/v1/people/{id}/away, approver rules through PUT /api/v1/projects/{id}/approvers/{gate}.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { refuse } from "../core/index.js";
import { computeWorkload } from "../areas/workload/compute.js";

const Query = z.object({ scope: z.string().trim().max(100).optional(), days: z.coerce.number().int().min(1).max(30).default(7) });

export const workloadRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  app.get("/api/v1/workload", async (req) => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
    const q = Query.parse(req.query);
    return computeWorkload(g.pool, g.orgId, p.id, { scope: q.scope ?? null, days: q.days }, new Date());
  });
};
