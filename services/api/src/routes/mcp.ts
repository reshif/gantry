/**
 * MCP (spec 8.8). Owns:
 *   POST /api/v1/mcp/discover, GET/POST /api/v1/mcp/servers, PATCH/DELETE /api/v1/mcp/servers/{id}
 *   GET /api/v1/mcp/access-check, GET /api/v1/mcp/calls
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const mcpRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
