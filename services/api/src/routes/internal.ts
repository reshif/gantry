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
import { runRoutes } from "../areas/internal/runs.js";
import { vendorKeyRoutes } from "../areas/internal/keys.js";
import { mcpGatewayRoutes } from "../areas/mcp/internal.js";
import { serviceCallRoutes } from "../areas/internal/service-calls.js";

export const internalRoutes: FastifyPluginAsync = async (app) => {
  // Runs part (edge): areas/internal. The GitHub broker endpoints (fence-check, github/events) register below.
  await app.register(runRoutes);
  await app.register(vendorKeyRoutes);
  await app.register(mcpGatewayRoutes);
  await app.register(serviceCallRoutes);
};
