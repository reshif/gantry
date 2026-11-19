/**
 * MCP (spec 8.8, 12.4). Owns:
 *   POST /api/v1/mcp/discover, GET/POST /api/v1/mcp/servers, PATCH/DELETE /api/v1/mcp/servers/{id}
 *   POST /api/v1/mcp/servers/{id}/discover (check again), POST /api/v1/mcp/servers/{id}/approve (re-approve changed definitions)
 *   POST /api/v1/mcp/grants (pre-authorise write tools for a work order's attempt)
 *   GET /api/v1/mcp/access-check, GET /api/v1/mcp/calls
 * The edge makes every connection to a server (it holds the credentials and sits on the egress network); the API asks it over /mcp-admin/v1.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { visibleProjects } from "@gantry/domain";
import { command, decide, mayCallOut, policyState, refuse, type CommandSpec } from "../core/index.js";
import { checkAccess } from "../areas/mcp/access.js";
import { addServer, applyDiscovery, checkAuth, checkUrl, grantWrites, patchServer, recordDiscovery, removeServer } from "../areas/mcp/commands.js";
import { discoverTools, type Discovery, type EdgeTarget } from "../areas/mcp/edge-client.js";
import { openSecret } from "../areas/mcp/secret.js";
import { AddBody, CallsQuery, CheckQuery, DiscoverBody, GrantBody, IdParam, PatchBody } from "../areas/mcp/schemas.js";
import { readCalls, readServer, readServerRows, readServers } from "../areas/mcp/store.js";
import { refuseIfFactoryKilled } from "../areas/integrations/stop.js";
import { directoryScope, directoryServers } from "../core/directory.js";

const requirePerson = (req: FastifyRequest): void => {
  if (req.gx.principal?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
};

export const mcpRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const spec = (idem = false): CommandSpec => ({ action: "mcp.edit", scope: {}, ...(idem ? { idempotent: true } : {}) });
  /** The network call to the edge happens before the transaction opens, and only for a caller the decision point allows (a denial is then audited by `command`). */
  const discoverFirst = async (req: FastifyRequest, t: EdgeTarget): Promise<Discovery | null> => ((await mayCallOut(req, "mcp.edit")) ? discoverTools(g.config.secrets.edgeToken, t) : null);
  const denied: Discovery = { ok: false, msg: "Not permitted." };

  /** The target of a saved server, with its credential opened for the edge. */
  const targetOf = async (id: string): Promise<EdgeTarget> => {
    const r = (await readServerRows(g.pool, g.orgId, id))[0];
    if (!r) throw refuse("not_found", "No such MCP server.");
    const secret = openSecret(g.config.secrets.dataKey, id, r.secret_enc);
    return { url: r.url, transport: r.transport, auth: { mode: r.auth_mode, header: r.auth_header, secret } };
  };

  app.get("/api/v1/mcp/servers", async (req) => {
    requirePerson(req);
    const mine = await directoryScope(req);
    const servers = await readServers(g.pool, g.orgId);
    return mine ? directoryServers(servers, mine) : servers;
  });

  app.get("/api/v1/mcp/calls", async (req) => {
    requirePerson(req);
    return readCalls(g.pool, g.orgId, CallsQuery.parse(req.query));
  });

  app.get("/api/v1/mcp/access-check", async (req) => {
    requirePerson(req);
    const q = CheckQuery.parse(req.query);
    return checkAccess(g.pool, g.orgId, q);
  });

  app.post("/api/v1/mcp/discover", async (req) => {
    const b = DiscoverBody.parse(req.body);
    const url = (() => { try { return checkUrl(b.url); } catch { return null; } })();
    let found: Discovery = denied;
    if (url) {
      checkAuth(b.authMode, b.authHeader, b.secret);
      found = (await discoverFirst(req, { url, transport: b.transport, auth: { mode: b.authMode, header: b.authHeader ?? null, secret: b.secret ?? null } })) ?? denied;
    }
    return command(req, spec(), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "MCP servers");
      checkUrl(b.url);
      return recordDiscovery(a, { url: b.url, transport: b.transport, name: b.name }, found);
    });
  });

  app.post("/api/v1/mcp/servers", async (req) => {
    const b = AddBody.parse(req.body);
    let found: Discovery = denied;
    try {
      const url = checkUrl(b.url);
      checkAuth(b.authMode, b.authHeader, b.secret);
      found = (await discoverFirst(req, { url, transport: b.transport, auth: { mode: b.authMode, header: b.authHeader ?? null, secret: b.secret ?? null } })) ?? denied;
    } catch {
      // The command below raises the same validation error after the decision point has had its say.
    }
    return command(req, spec(true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "MCP servers");
      return addServer(tx, a, g.config.secrets.dataKey, b, found);
    });
  });

  app.patch("/api/v1/mcp/servers/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = PatchBody.parse(req.body);
    return command(
      req,
      { ...spec(), ifMatch: async (tx) => (await readServerRows(tx, g.orgId, id))[0]?.version ?? null },
      async (tx, a) => {
        await refuseIfFactoryKilled(tx, a.orgId, "MCP servers");
        return patchServer(tx, a, g.config.secrets.dataKey, id, b);
      },
    );
  });

  app.delete("/api/v1/mcp/servers/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    return command(req, { ...spec(), ifMatch: async (tx) => (await readServerRows(tx, g.orgId, id))[0]?.version ?? null }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "MCP servers");
      return removeServer(tx, a, id);
    });
  });

  for (const mode of ["discover", "approve"] as const) {
    app.post(`/api/v1/mcp/servers/:id/${mode}`, async (req) => {
      const { id } = IdParam.parse(req.params);
      const exists = (await readServerRows(g.pool, g.orgId, id)).length > 0;
      const found = exists ? ((await discoverFirst(req, await targetOf(id))) ?? denied) : denied;
      return command(req, { ...spec(), ifMatch: async (tx) => (await readServerRows(tx, g.orgId, id))[0]?.version ?? null }, async (tx, a) => {
        await refuseIfFactoryKilled(tx, a.orgId, "MCP servers");
        return applyDiscovery(tx, a, id, found, mode);
      });
    });
  }

  app.post("/api/v1/mcp/grants", async (req) => {
    const b = GrantBody.parse(req.body);
    const wo = (await g.pool.query<{ project_id: string; repo_id: string | null }>(`select project_id, repo_id from work_orders where org_id = $1 and id = $2`, [g.orgId, b.wo])).rows[0];
    // An id the caller cannot see is the same 404 as one that does not exist (as for stops); one they can see but may not approve is a 403.
    // Pre-authorising writes needs a fresh sign-in.
    const who = req.gx.principal;
    const st = who?.kind === "person" ? await policyState(req).catch(() => null) : null;
    const seen = !!wo && (who?.kind !== "person" || !st || visibleProjects(st, who.id).some((x) => x.id === wo.project_id));
    if (!wo || !seen) {
      // Decided before answering, so a caller with no approve right anywhere gets the 403, not a hint about the id.
      await decide(req, "gate.approve", {}).then((d) => { if (!d.allowed) throw refuse("denied", "Not permitted."); });
      throw refuse("not_found", "No such work order.");
    }
    // Owner decision (audit A6): only a Factory Admin grants an agent access to an MCP tool. The server decides; the UI only displays it.
    const me = who?.kind === "person" ? st?.people.find((x) => x.id === who.id) : null;
    if (!me?.roles.some((r) => r.role === "factory_admin" && r.scope === "factory")) {
      throw refuse("denied", "Only a Factory Admin can pre-authorise an agent's write tools.", { needs: "A Factory Admin to grant this" });
    }
    return command(req, { action: "gate.approve", scope: { project: wo.project_id, repo: wo.repo_id, wo: b.wo }, stepUp: true, idempotent: true }, (tx, a) => grantWrites(tx, a, b));
  });

  // Read helper kept for the screen after a command: one server by id.
  app.get("/api/v1/mcp/servers/:id", async (req) => {
    requirePerson(req);
    const { id } = IdParam.parse(req.params);
    const s = await readServer(g.pool, g.orgId, id);
    if (!s) throw refuse("not_found", "No such MCP server.");
    return s;
  });
};
