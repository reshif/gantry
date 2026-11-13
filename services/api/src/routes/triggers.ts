/**
 * Triggers (spec 8.8). Owns:
 *   GET/POST /api/v1/triggers, PATCH /api/v1/triggers/{id}, POST .../dry-run, GET .../runs
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const triggerRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
