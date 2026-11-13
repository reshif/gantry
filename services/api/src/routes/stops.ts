/**
 * Stop controls (spec 8.5). Use stopCommand() so the path touches only stops and events. Owns:
 *   POST /api/v1/stops (mode halt|kill), DELETE /api/v1/stops/{id}, POST /api/v1/stops/{id}/restore
 *   GET /api/v1/stops/impact?scope=&id=
 * Stop id convention: `${scope}:${targetId}` with scope factory|project|repo|workorder.
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const stopRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
