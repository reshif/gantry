/**
 * Learning loop (spec 8.7). Owns:
 *   GET /api/v1/learning/findings, POST /api/v1/learning/findings/refresh
 *   GET/POST /api/v1/learning/proposals, POST .../{id}/accept, /decline, /verify
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const learningRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
