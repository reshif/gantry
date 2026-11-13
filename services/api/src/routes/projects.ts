/**
 * Projects, templates, saved views, project config, flow, approvers, members, archive (spec 8.3). Owns:
 *   GET /api/v1/projects, GET /api/v1/projects/{id}, POST /api/v1/projects
 *   GET/POST/PATCH/DELETE /api/v1/saved-views
 *   GET/POST /api/v1/templates, PATCH /api/v1/templates/{id}
 *   PATCH /api/v1/projects/{id}/config
 *   POST/DELETE/PATCH /api/v1/projects/{id}/flow/{stations|gates|bays|classes}
 *   PUT /api/v1/projects/{id}/approvers/{gate}
 *   PUT/DELETE /api/v1/projects/{id}/members/{person}/roles/{role}
 *   POST /api/v1/projects/{id}/archive, /unarchive
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const projectRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
