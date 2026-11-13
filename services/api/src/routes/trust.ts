/**
 * Trust ladder (spec 8.7). Owns:
 *   GET /api/v1/trust/cells, POST /api/v1/trust/grants, POST /api/v1/trust/proposals/{id}/decide
 *   POST /api/v1/trust/cells/{id}/demote, PUT /api/v1/trust/criteria, POST/DELETE /api/v1/trust/ceilings, PUT /api/v1/trust/sample-rate
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const trustRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
