/**
 * Evals (spec 8.7). Owns:
 *   GET /api/v1/evals/scorecards, GET /api/v1/evals/factory
 *   GET/POST /api/v1/suites/{id}/runs, POST /api/v1/suites/{id}/cases
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const evalRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
