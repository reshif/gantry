/**
 * Home and activity (spec 8.3). Owns:
 *   GET /api/v1/home       figures, attention queue, my approvals, my conversations, nav badges
 *   GET /api/v1/activity
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const homeRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
