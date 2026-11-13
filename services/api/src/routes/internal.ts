/**
 * Internal API for the edge and GitHub broker (spec 8.11). The core authenticates every /internal/v1/* request with the service
 * tokens (principal.kind === "service", id edge|github). Owns:
 *   POST /internal/v1/runs/{id}/authorize, /usage, /mcp-authorize, /heartbeat, /checkpoint, /result
 *   POST /internal/v1/attempts/{id}/fence-check, POST /internal/v1/github/events
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const internalRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
