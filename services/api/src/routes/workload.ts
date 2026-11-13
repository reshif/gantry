/**
 * Workload (spec 8.9). Owns:
 *   GET /api/v1/workload?scope=
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const workloadRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
