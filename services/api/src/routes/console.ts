/**
 * Console (spec 8.9). Owns:
 *   POST /api/v1/console/messages (streams the answer; tool calls run with the person's permissions)
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const consoleRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
