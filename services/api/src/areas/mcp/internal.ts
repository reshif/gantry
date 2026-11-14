/**
 * The edge's MCP gateway endpoints on the API (spec 6.4, 12.4), all authenticated by the edge's service token and a live run token:
 *   POST /internal/v1/runs/{id}/mcp-tools       the tools this run may see on one server
 *   POST /internal/v1/runs/{id}/mcp-connection  the address and credential of an in-scope server, for the edge to inject
 *   POST /internal/v1/runs/{id}/mcp-result      the outcome of an authorised call (mcp-authorize logs it as allowed first)
 * mcp-authorize itself lives with the other run endpoints (areas/internal/runs.ts).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { command, type CommandResult } from "../../core/command.js";
import { refuse } from "../../core/errors.js";
import { requireEdge } from "../internal/edge-only.js";
import { loadRunCtx, guardRun } from "../internal/context.js";
import { findRunToken } from "../internal/tokens.js";
import { refusalFor } from "../internal/runs.js";
import { mcpServersInScope } from "../internal/spec.js";
import { openSecret } from "./secret.js";
import { readServerRows, readToolRows } from "./store.js";

const Token = z.string().min(20).max(700);
const Params = z.object({ id: z.string().min(1).max(200) });
const ServerBody = z.object({ token: Token, server: z.string().min(1).max(200) });
const ResultBody = z.object({ token: Token, callId: z.number().int().positive(), outcome: z.enum(["ok", "error"]), ms: z.number().int().nonnegative().max(2 ** 31 - 1), error: z.string().max(1000).optional() });

export const mcpGatewayRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", (req) => requireEdge(req, "mcp.gateway"));
  const g = app.gantry;

  const scoped = async (id: string, b: z.infer<typeof ServerBody>) => {
    const c = await loadRunCtx(g.pool, g.orgId, id);
    const tok = c ? await findRunToken(g.pool, g.orgId, id, b.token) : null;
    if (!c || !tok) throw refuse("denied", "The run token is not valid for this run.", { rule: { kind: "invariant", id: "RUN-TOKEN", name: "Run token" } });
    const d = await guardRun(g.pool, c, tok, { mode: "model" });
    if (d) throw refusalFor(d);
    const srv = (await readServerRows(g.pool, g.orgId, b.server))[0];
    if (!srv) throw refuse("not_found", `No such MCP server ${b.server}.`);
    if (!(await mcpServersInScope(g.pool, c)).some((s) => s.id === b.server)) throw refuse("denied", `MCP server ${srv.name} is not in scope for this run.`, { rule: { kind: "invariant", id: "MCP-SCOPE", name: "MCP scope" } });
    return { c, srv };
  };

  app.post("/internal/v1/runs/:id/mcp-tools", async (req) => {
    const { id } = Params.parse(req.params);
    const { c, srv } = await scoped(id, ServerBody.parse(req.body));
    const grants = Array.isArray(c.attemptData.writeGrants) ? (c.attemptData.writeGrants as unknown[]) : [];
    const granted = (t: string): boolean => grants.includes(`${srv.id}/${t}`) || grants.includes(`${srv.id}/*`);
    // A tool whose definition changed is not offered. A write tool is offered only where this attempt holds its pre-authorisation, so the model is not shown what it cannot call.
    const tools = (await readToolRows(g.pool, g.orgId, srv.id))
      .filter((t) => t.allowed && !t.pending_hash && (t.tool_class === "read" || granted(t.name)))
      .map((t) => ({ name: t.name, title: t.definition?.title, description: t.definition?.description ?? "", inputSchema: t.definition?.inputSchema ?? { type: "object" }, annotations: t.definition?.annotations, class: t.tool_class }));
    return { ok: true, server: { id: srv.id, name: srv.name }, tools };
  });

  app.post("/internal/v1/runs/:id/mcp-connection", async (req, reply) => {
    const { id } = Params.parse(req.params);
    const { srv } = await scoped(id, ServerBody.parse(req.body));
    const secret = openSecret(g.config.secrets.dataKey, srv.id, srv.secret_enc);
    return reply.header("cache-control", "no-store").send({ ok: true, url: srv.url, transport: srv.transport, auth: { mode: srv.auth_mode, header: srv.auth_header, secret } });
  });

  app.post("/internal/v1/runs/:id/mcp-result", async (req) => {
    const { id } = Params.parse(req.params);
    const b = ResultBody.parse(req.body);
    return command(req, { action: "mcp.result", service: true }, async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const c = await loadRunCtx(tx, req.gx.orgId, id);
      const tok = c ? await findRunToken(tx, req.gx.orgId, id, b.token) : null;
      if (!c || !tok) throw refuse("denied", "The run token is not valid for this run.", { rule: { kind: "invariant", id: "RUN-TOKEN", name: "Run token" } });
      // A halted run may still report the call it had in flight; a killed or superseded one may not.
      const d = await guardRun(tx, c, tok, { mode: "progress" });
      if (d && d.code !== "stopped") throw refuse(d.code === "superseded" || d.code === "ended" || d.code === "finished" ? "stale" : "denied", d.reason);
      const row = (await tx.query<{ server_id: string; tool: string; outcome: string; args_hash: string | null }>(
        `update mcp_calls set outcome = $4, latency_ms = $5, reason = $6, updated_at = now() where org_id = $1 and run_id = $2 and id = $3 and outcome = 'allowed' returning server_id, tool, outcome, args_hash`,
        [c.orgId, id, b.callId, b.outcome, b.ms, b.error ?? null],
      )).rows[0];
      if (!row) return { msg: "Already recorded.", events: [], extra: { recorded: false } };
      const cls = (await tx.query<{ tool_class: string }>(`select tool_class from mcp_tools where org_id = $1 and server_id = $2 and name = $3`, [c.orgId, row.server_id, row.tool])).rows[0]?.tool_class;
      // Every write call and every failure is a ledger event; successful reads are in mcp_calls (the usage log) only.
      const events = cls === "write" || b.outcome === "error"
        ? [{ type: "mcp.call", category: "integrations" as const, subject: { type: "mcp_tool", id: `${row.server_id}/${row.tool}` }, projectId: c.projectId, woId: c.woId, outcome: b.outcome === "ok" ? ("ok" as const) : ("failed" as const), after: { run: id, class: cls, ms: b.ms, ...(row.args_hash ? { argsHash: row.args_hash } : {}), ...(b.error ? { error: b.error.slice(0, 300) } : {}) } }]
        : [];
      return { msg: "Recorded.", events, extra: { recorded: true }, changes: ["mcp"], project: c.projectId };
    });
  });
};
