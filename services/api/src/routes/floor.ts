/**
 * Floor (spec 8.4). Owns:
 *   GET /api/v1/projects/{id}/floor (flow version, positions, gates, slots, stop state), ?at={time} for replay
 * The events behind the replay marks are served by GET /api/v1/projects/{id}/events (audit area). A read: nothing here changes state.
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { policyState, refuse } from "../core/index.js";
import { readFloor } from "../areas/workorders/reads.js";

export const floorRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  app.get("/api/v1/projects/:id/floor", async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const q = z.object({ at: z.coerce.number().finite().positive().optional() }).parse(req.query);
    const p = req.gx.principal;
    if (!p || p.kind === "service") throw refuse("denied", "Sign in to continue.");
    const st = await policyState(req);
    const seen = p.kind === "person" ? (st.people.find((x) => x.id === p.id)?.roles.some((r) => r.scope === "factory") ? true : visibleProjects(st, p.id).some((x) => x.id === id)) : !p.projectId || p.projectId === id;
    if (!seen) throw refuse("not_found", "No such project.");
    const f = await readFloor(g.pool, req.gx.orgId, id, q.at);
    if (!f) throw refuse("not_found", "No such project.");
    return f;
  });
};
