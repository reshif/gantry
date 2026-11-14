/**
 * Inbound hooks (spec 8.10): signature-verified, stored, acknowledged, then processed as jobs. Not behind session auth. Owns:
 *   POST /hooks/github, POST /hooks/slack, POST /hooks/teams, POST /hooks/trigger/{connection} (custom trigger sources)
 *
 * Fill this plugin in with app.get/post/... using the helpers from "../core/index.js" (command(), decide(), read mappers).
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4).
 */
import type { FastifyPluginAsync } from "fastify";
import { githubHookRoutes } from "../areas/github/hooks.js";
import { slackHookRoutes } from "../areas/integrations/slack-hook.js";
import { triggerHookRoutes } from "../areas/triggers/hook.js";

export const hookRoutes: FastifyPluginAsync = async (app) => {
  // POST /hooks/github: areas/github/hooks.ts (own encapsulated plugin: raw-body parser for the signature).
  await app.register(githubHookRoutes);
  // POST /hooks/slack: areas/integrations/slack-hook.ts (interactive callbacks and `/gantry link`; signature, five-minute window and replay protection).
  await app.register(slackHookRoutes);
  // POST /hooks/trigger/{connection}: the signed webhook in of a custom connection that is a trigger source (areas/triggers/hook.ts).
  await app.register(triggerHookRoutes);
  // Microsoft Teams is listed in the catalogue but not yet available (spec 12.1): the endpoint says so instead of pretending to listen.
  app.post("/hooks/teams", async (_req, reply) => reply.code(501).send({ ok: false, msg: "Microsoft Teams is not yet available in this version." }));
};
