/**
 * Agents (spec 8.7). Owns:
 *   GET/POST /api/v1/agents, PATCH /api/v1/agents/{id}, POST .../versions, .../versions/{v}/promote, .../rollback
 *   PUT/DELETE /api/v1/agents/{id}/skills/{skill}, GET /api/v1/agents/{id}/effective?project=&repo=
 *   GET/PUT /api/v1/instructions/base
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const agentRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
