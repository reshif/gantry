/**
 * Repository onboarding (spec 8.6). Owns:
 *   GET/POST /api/v1/projects/{id}/repos, PATCH /api/v1/repos/{id}/config
 *   POST /api/v1/repos/{id}/onboarding/{assess|open-pr|merge|request-changes|exception|verify}
 *   GET/PUT /api/v1/guidelines, PUT /api/v1/projects/{id}/guidelines
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";

export const onboardingRoutes: FastifyPluginAsync = async (_app) => {
  // Endpoints are registered here.
};
