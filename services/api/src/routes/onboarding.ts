/**
 * Repository onboarding (spec 8.6). Owns:
 *   GET/POST /api/v1/projects/{id}/repos, PATCH /api/v1/repos/{id}/config
 *   POST /api/v1/repos/{id}/onboarding/{assess|open-pr|merge|request-changes|exception|verify}
 *   GET/PUT /api/v1/guidelines, PUT /api/v1/projects/{id}/guidelines
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { policyState, readRepos, refuse } from "../core/index.js";

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  /** The repositories of a project, in the legacy Repo shape (onboarding stage, halt). The Floor reads it to find a Ready repo for a new work order. */
  app.get("/api/v1/projects/:id/repos", async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
    const st = await policyState(req);
    if (!visibleProjects(st, p.id).some((x) => x.id === id)) throw refuse("not_found", "No such project.");
    return (await readRepos(g.pool, g.orgId, st.activeStops)).filter((r) => r.project === id);
  });
  // The onboarding commands are registered here.
};
