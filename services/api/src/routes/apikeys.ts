/**
 * API keys and public API config (spec 8.8). Use generateApiKey()/hashApiKey() from core/auth/apikeys. Owns:
 *   GET/POST /api/v1/api-keys (secret returned once), DELETE /api/v1/api-keys/{id}
 *   GET/PATCH /api/v1/api-config, GET /api/v1/api-requests
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const apiKeyRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
