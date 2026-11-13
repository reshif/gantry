/**
 * Work orders, conversations, gates and the record (spec 8.4, 8.10). Owns:
 *   GET/POST /api/v1/projects/{id}/work-orders, GET /api/v1/work-orders/{id}
 *   GET /api/v1/conversations, POST /api/v1/work-orders/{id}/messages
 *   POST /api/v1/work-orders/{id}/reclassify, /confirm-brief, /decline
 *   POST /api/v1/gate-instances/{id}/approve, /reject
 *   POST /api/v1/work-orders/{id}/move (dry_run), /send-back, /park, /unpark, /reassign, /retry
 *   GET /api/v1/work-orders/{id}/record, record.md, record/export, PUT .../record/summary, GET .../changes
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const workOrderRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
