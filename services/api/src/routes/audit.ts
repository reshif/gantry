/**
 * Audit, activity and events (spec 8.9, 8.4). Owns:
 *   GET /api/v1/audit (filters: category, project, actor, outcome, channel, text), GET /api/v1/audit/{seq}, GET /api/v1/audit/verify
 *   GET /api/v1/projects/{id}/events?from=&to=&kinds=
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const auditRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
