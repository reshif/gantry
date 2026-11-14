import type { FastifyInstance } from "fastify";
import { accessRoutes } from "./access.js";
import { agentRoutes } from "./agents.js";
import { apiKeyRoutes } from "./apikeys.js";
import { auditRoutes } from "./audit.js";
import { catalogRoutes } from "./catalog.js";
import { consoleRoutes } from "./console.js";
import { evalRoutes } from "./evals.js";
import { floorRoutes } from "./floor.js";
import { homeRoutes } from "./home.js";
import { hookRoutes } from "./hooks.js";
import { integrationRoutes } from "./integrations.js";
import { internalRoutes } from "./internal.js";
import { internalGithubRoutes } from "./internal-github.js";
import { learningRoutes } from "./learning.js";
import { mcpRoutes } from "./mcp.js";
import { modelRoutes } from "./models.js";
import { notificationRoutes } from "./notifications.js";
import { onboardingRoutes } from "./onboarding.js";
import { onboardingSessionRoutes } from "./onboarding-session.js";
import { workOrderSessionRoutes } from "./workorder-session.js";
import { peopleRoutes } from "./people.js";
import { projectRoutes } from "./projects.js";
import { sessionRoutes } from "./session.js";
import { skillRoutes } from "./skills.js";
import { stopRoutes } from "./stops.js";
import { triggerRoutes } from "./triggers.js";
import { trustRoutes } from "./trust.js";
import { workloadRoutes } from "./workload.js";
import { workOrderRoutes } from "./workorders.js";

/** One module per area. Each is a self-contained Fastify plugin registered here, so area engineers add endpoints without touching each other's files. */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  for (const plugin of [
    sessionRoutes, catalogRoutes, homeRoutes, projectRoutes, peopleRoutes, accessRoutes, auditRoutes, floorRoutes, workOrderRoutes, stopRoutes, onboardingRoutes, onboardingSessionRoutes, workOrderSessionRoutes,
    agentRoutes, skillRoutes, modelRoutes, evalRoutes, trustRoutes, learningRoutes, integrationRoutes, notificationRoutes, mcpRoutes, apiKeyRoutes, triggerRoutes,
    workloadRoutes, consoleRoutes, hookRoutes, internalRoutes, internalGithubRoutes,
  ]) {
    await app.register(plugin);
  }
}
