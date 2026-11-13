/**
 * Notifications (spec 8.8). Owns:
 *   GET/POST /api/v1/projects/{id}/routes, PATCH/DELETE .../routes/{id}, POST .../routes/test
 *   GET /api/v1/deliveries, POST /api/v1/deliveries/{id}/retry
 *   GET/POST /api/v1/card-templates, POST /api/v1/card-templates/preview
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const notificationRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
