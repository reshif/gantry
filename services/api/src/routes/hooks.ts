/**
 * Inbound hooks (spec 8.10): signature-verified, stored, acknowledged, then processed as jobs. Not behind session auth. Owns:
 *   POST /hooks/github, POST /hooks/slack, POST /hooks/teams
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const hookRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
