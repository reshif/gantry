/**
 * GitHub broker endpoints of the internal API (spec 8.11), authenticated by the github service token in the core's onRequest hook:
 *   POST /internal/v1/attempts/{id}/fence-check, POST /internal/v1/work-orders/{id}/fence-check,
 *   POST /internal/v1/github/events, GET /internal/v1/github/repos
 */
import type { FastifyPluginAsync } from "fastify";
import { githubInternalRoutes } from "../areas/github/routes.js";

export const internalGithubRoutes: FastifyPluginAsync = async (app) => {
  await app.register(githubInternalRoutes);
};
