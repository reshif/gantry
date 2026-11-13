/**
 * Vendors, models, routing (spec 8.7). Owns:
 *   GET/POST /api/v1/vendors, PATCH /api/v1/vendors/{id}, POST/DELETE /api/v1/models, PATCH /api/v1/models/{id}
 *   GET/PUT /api/v1/routing, GET /api/v1/routing/resolve?station=&repo=
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const modelRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
