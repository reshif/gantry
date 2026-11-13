/**
 * Skills (spec 8.7). Owns:
 *   GET/POST /api/v1/skills, PATCH /api/v1/skills/{id}, PUT /api/v1/skills/{id}/projects
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const skillRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
