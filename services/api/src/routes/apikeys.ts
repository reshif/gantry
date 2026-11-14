/**
 * API keys and public API config (spec 8.8, 12.5). Owns:
 *   GET/POST /api/v1/api-keys (secret returned once), DELETE /api/v1/api-keys/{id}
 *   GET/PATCH /api/v1/api-config, GET /api/v1/api-requests
 * The public endpoints a key calls are the work-order routes; the gate in areas/apikeys/gate.ts limits a key to them, to its project and scopes, and to the rate limit.
 */
import type { FastifyPluginAsync } from "fastify";
import { command, refuse } from "../core/index.js";
import { visibleToPerson } from "../areas/apikeys/visible.js";
import { readApiSettings } from "../areas/apikeys/config.js";
import { createKey, revokeKey, setApiConfig } from "../areas/apikeys/commands.js";
import { ConfigBody, CreateKeyBody, IdParam, RequestsQuery } from "../areas/apikeys/schemas.js";
import { readKeys, readRequests } from "../areas/apikeys/store.js";

export const apiKeyRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  app.get("/api/v1/api-keys", async (req) => readKeys(g.pool, g.orgId, await visibleToPerson(req)));

  app.get("/api/v1/api-config", async (req) => {
    await visibleToPerson(req);
    const c = await readApiSettings(g.pool, g.orgId);
    return { ...c.value, version: c.version };
  });

  app.get("/api/v1/api-requests", async (req) => {
    const projects = await visibleToPerson(req);
    const q = RequestsQuery.parse(req.query);
    return readRequests(g.pool, g.orgId, projects, q);
  });

  app.post("/api/v1/api-keys", async (req) => {
    const b = CreateKeyBody.parse(req.body);
    return command(req, { action: "api.keys", scope: { project: b.project }, idempotent: true, storedOmit: ["secret"] }, (tx, a) => createKey(tx, a, b));
  });

  app.delete("/api/v1/api-keys/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    // The decision needs the key's project, so it is read first; an unknown key is a 404 for everyone who can see the list.
    const row = (await g.pool.query<{ project_id: string | null }>(`select project_id from api_keys where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
    if (!row) throw refuse("not_found", "No such key.");
    return command(req, { action: "api.keys", scope: { project: row.project_id } }, (tx, a) => revokeKey(tx, a, id));
  });

  app.patch("/api/v1/api-config", async (req) => {
    const b = ConfigBody.parse(req.body);
    const out = await command(req, { action: "integration.edit", scope: {} }, (tx, a) => setApiConfig(tx, a, b));
    g.apiSettings.invalidate();
    return out;
  });
};
