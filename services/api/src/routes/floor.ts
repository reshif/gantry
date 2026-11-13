/**
 * Floor (spec 8.4). Owns:
 *   GET /api/v1/projects/{id}/floor (flow version, positions, gates, slots, stop state), ?at={time} for replay
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const floorRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
