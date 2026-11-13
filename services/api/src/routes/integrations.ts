/**
 * Integrations (spec 8.8). Owns:
 *   GET/POST /api/v1/integration-types, GET/POST /api/v1/integrations, PATCH/DELETE /api/v1/integrations/{id}, POST .../test
 *   /api/v1/integrations/{channel} for channel-level set and test
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const integrationRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
