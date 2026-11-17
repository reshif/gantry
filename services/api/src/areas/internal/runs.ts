import { requireEdge } from "./edge-only.js";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Tx } from "@gantry/db";
import { command, type CommandResult, type EventSpec } from "../../core/command.js";
import { job } from "../../core/jobs-contract.js";
import { refuse, Refusal } from "../../core/errors.js";
import { activeStopsFor, guardRun, loadRunCtx, type Denial, type RunCtx } from "./context.js";
import { composeRunSpec, LEASE_SECONDS, mcpServersInScope } from "./spec.js";
import { budgetBreach, costMicros, currentPrices } from "./metering.js";
import { resolveRoute } from "./route.js";
import { runEgressHosts, systemEgressHosts } from "./egress.js";
import { ResultBody, Token } from "./result-body.js";
import { findRunToken, type TokenRow } from "./tokens.js";
import { recordDocument } from "../workorders/documents.js";
import { recordSource, researchHosts } from "../workorders/research.js";

const RunParams = z.object({ id: z.string().min(1).max(200) });
const runId = (req: FastifyRequest): string => RunParams.parse(req.params).id;
const nonneg = z.number().int().nonnegative().max(2 ** 53 - 1);
const edgeUrl = (): string => process.env.EDGE_URL ?? "http://gantry-edge:8443";

const AuthorizeBody = z.object({ token: Token, model: z.string().min(1).max(200).optional() });
const UsageBody = z.object({
  token: Token,
  requestId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200),
  vendor: z.string().min(1).max(200).optional(),
  inputTokens: nonneg,
  outputTokens: nonneg,
  cacheReadTokens: nonneg.default(0),
  cacheWriteTokens: nonneg.default(0),
  latencyMs: nonneg.optional(),
  outcome: z.enum(["ok", "error", "refused"]).default("ok"),
  /** Object-storage reference to the captured trace: sha256/<hash>. */
  traceRef: z.string().regex(/^sha256\/[0-9a-f]{64}$/).optional(),
  /** Spec 10.4 Fallback: the call went to the same model on another vendor, or to a different model (which needs the project's opt-in). Flagged on the run. */
  fallback: z.enum(["same_model", "cross_model"]).optional(),
  /** The model the run pinned, when a fallback served a different one. */
  wanted: z.string().min(1).max(200).optional(),
});
const HeartbeatBody = z.looseObject({ token: Token, seq: z.number().int().nonnegative().optional(), phase: z.enum(["starting", "working", "finishing"]).optional(), turn: z.number().int().nonnegative().optional() });
const CheckpointBody = z.looseObject({
  token: Token,
  turn: z.number().int().nonnegative(),
  kind: z.enum(["transcript", "artefact"]),
  name: z.string().min(1).max(300),
  contentType: z.string().min(1).max(200).default("application/octet-stream"),
  /** sha256 of the content the edge stored under sha256/<hash>. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  size: nonneg.default(0),
  /** A station document's text (markdown), already scanned by the edge. */
  content: z.string().max(600_000).optional(),
  /** A transcript's tool calls (name and short target) for the run timeline, extracted and scanned by the edge. */
  steps: z.array(z.object({ turn: z.number().int().nonnegative(), tool: z.string().max(80), detail: z.string().max(200) })).max(50).optional(),
});
const SourceBody = z.object({
  token: Token,
  url: z.string().url().max(4000), finalUrl: z.string().url().max(4000), title: z.string().max(300).default(""), httpStatus: z.number().int().optional(),
  contentType: z.string().max(200).default(""), contentHash: z.string().regex(/^[0-9a-f]{64}$/), size: nonneg.default(0), truncated: z.boolean().default(false),
  why: z.string().max(500).default(""), excerpt: z.string().max(70_000).default(""),
});
const RefusedBody = z.object({ token: Token, url: z.string().max(4000), reason: z.string().max(500) });
const McpBody = z.object({ token: Token, server: z.string().min(1).max(200), tool: z.string().min(1).max(300), argsHash: z.string().regex(/^[0-9a-f]{64}$/).optional(), definitionHash: z.string().min(1).max(200).optional() });
const EgressBody = z.object({ token: Token });
const EgressDeniedBody = z.object({ runId: z.string().min(1).max(200).optional(), token: z.string().max(700).optional(), caller: z.enum(["run", "system"]), host: z.string().min(1).max(300), port: z.number().int().min(0).max(65535), reason: z.string().max(500) });

const subject = (id: string) => ({ type: "run", id });
const evBase = (c: RunCtx | null, id: string): Pick<EventSpec, "subject" | "projectId" | "woId" | "category"> => ({ subject: subject(id), projectId: c?.projectId ?? null, woId: c?.woId ?? null, category: "flow" });

/** Maps a guard denial to a refusal: token problems are permission denials (403), stops are 409 with the stop reason, a superseded or ended run is stale (409). */
export function refusalFor(d: Denial): Refusal {
  if (d.code === "stopped") return refuse("stopped", d.reason, { rule: { kind: "stop", id: "STOP", name: "Stop state" } });
  if (d.code === "superseded" || d.code === "ended" || d.code === "finished") return refuse("stale", d.reason);
  return refuse("denied", d.reason, { rule: { kind: "invariant", id: "RUN-TOKEN", name: "Run token" } });
}

/** Loads the run and checks the token under the given mode; refuses (and so audits, for 403/409-stop) when anything is off. */
export async function mustGuard(tx: Tx, orgId: string, id: string, token: string, mode: "model" | "progress", lock = false): Promise<{ c: RunCtx; tok: TokenRow }> {
  const c = await loadRunCtx(tx, orgId, id, lock);
  const tok = c ? await findRunToken(tx, orgId, id, token) : null;
  if (!c || !tok) throw refuse("denied", "The run token is not valid for this run.", { rule: { kind: "invariant", id: "RUN-TOKEN", name: "Run token" } });
  const d = await guardRun(tx, c, tok, { mode });
  if (d) throw refusalFor(d);
  return { c, tok };
}

const svc = (action: string) => ({ action, service: true }) as const;

export const runRoutes: FastifyPluginAsync = async (app) => {
  // Every endpoint in this plugin belongs to the edge; the egress report and the system allow-list too.
  app.addHook("preHandler", (req) => requireEdge(req, "internal.edge"));
  // ---------------------------------------------------------------- authorize
  app.post("/internal/v1/runs/:id/authorize", async (req) => {
    const id = runId(req);
    const b = AuthorizeBody.parse(req.body);
    return command(req, { action: "run.authorize", service: true }, async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const c = await loadRunCtx(tx, req.gx.orgId, id);
      const deny = (code: string, reason: string, ctx: RunCtx | null): CommandResult<Record<string, unknown>> => ({
        msg: reason,
        events: [{ type: "run.authorize.denied", ...evBase(ctx, id), outcome: "denied", after: { code, reason, ...(b.model ? { model: b.model } : {}) } }],
        extra: { allow: false, code, reason },
      });
      const tok = c ? await findRunToken(tx, req.gx.orgId, id, b.token) : null;
      if (!c) return deny("token", "The run token is not valid for this run.", null);
      const d = await guardRun(tx, c, tok, { mode: "model" });
      if (d) return deny(d.code, d.reason, c);
      if ((await tx.query(`select 1 from station_results where org_id = $1 and id = $2`, [c.orgId, `sr-${id}`])).rowCount) return deny("finished", "This run already delivered its result.", c);
      const br = await budgetBreach(tx, c);
      if (br) return deny("budget", `The ${br.scope === "wo" ? "work order" : br.scope === "plan" ? "research plan" : br.scope} budget is spent ($${(br.spentMicros / 1e6).toFixed(2)} of $${(br.limitMicros / 1e6).toFixed(2)}).`, c);
      const r = await resolveRoute(tx, c, b.model);
      if (!r.ok) return deny("route", r.reason, c);
      return {
        msg: "Allowed.",
        events: [],
        extra: { allow: true, reason: "ok", route: r.route, runId: id, attemptId: c.attemptId, fencing: c.fencing, woId: c.woId, projectId: c.projectId, station: c.station, agentId: c.agentId },
        changes: [],
      };
    });
  });

  // ---------------------------------------------------------------- usage
  app.post("/internal/v1/runs/:id/usage", async (req) => {
    const id = runId(req);
    const b = UsageBody.parse(req.body);
    return command(req, svc("run.usage"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const c = await loadRunCtx(tx, req.gx.orgId, id, true);
      const tok = c ? await findRunToken(tx, req.gx.orgId, id, b.token) : null;
      // Cost already incurred is recorded even when the token was revoked or the run stopped meanwhile; only an unknown token is refused.
      if (!c || !tok) throw refuse("denied", "The run token is not valid for this run.", { rule: { kind: "invariant", id: "RUN-TOKEN", name: "Run token" } });
      const book = await currentPrices(tx, c.orgId);
      const price = book.prices[b.model];
      const usage = { inputTokens: b.inputTokens, outputTokens: b.outputTokens, cacheReadTokens: b.cacheReadTokens, cacheWriteTokens: b.cacheWriteTokens };
      const cost = costMicros(price, usage);
      const ru = await tx.query(
        `insert into run_usage (org_id, run_id, attempt_id, wo_id, project_id, model_id, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_micros, latency_ms, trace_ref, price_version, vendor_id, request_id, outcome)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict do nothing`,
        [c.orgId, id, c.attemptId, c.woId, c.projectId, b.model, b.inputTokens, b.outputTokens, b.cacheReadTokens, b.cacheWriteTokens, cost, b.latencyMs ?? null, b.traceRef ?? null, book.version, b.vendor ?? null, b.requestId ?? null, b.outcome],
      );
      // The run shows the model that actually answered (the route may differ from the one pinned when the run was prepared).
      if (ru.rowCount) await tx.query(`update runs set model_id = $3, updated_at = now() where org_id = $1 and id = $2 and model_id is distinct from $3`, [c.orgId, id, b.model]);
      if (!ru.rowCount) return { msg: "Usage already recorded.", events: [], extra: { duplicate: true, costMicros: cost, priceVersion: book.version }, changes: [] };
      await tx.query(
        `insert into usage_meter (org_id, request_id, run_id, attempt_id, station, agent_id, agent_version, project_id, vendor_id, model_id, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_micros, price_version, latency_ms, outcome, trace_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [c.orgId, b.requestId ?? null, id, c.attemptId, c.station, c.agentId, c.agentVersion, c.projectId, b.vendor ?? null, b.model, b.inputTokens, b.outputTokens, b.cacheReadTokens, b.cacheWriteTokens, cost, book.version, b.latencyMs ?? null, b.outcome, b.traceRef ?? null],
      );
      // Spec 10.4 Budget: the in-flight call finished; the next one is refused and the work order gets a system halt with cause budget.
      const events: EventSpec[] = [];
      const jobs: ReturnType<typeof job>[] = [];
      let halted: string | null = null;
      if (b.fallback) {
        const fb = { kind: b.fallback, model: b.model, vendor: b.vendor ?? null, ...(b.wanted ? { wanted: b.wanted } : {}), requestId: b.requestId ?? null };
        await tx.query(`update runs set data = jsonb_set(data, '{fallbacks}', coalesce(data->'fallbacks', '[]'::jsonb) || $3::jsonb) where org_id = $1 and id = $2`, [c.orgId, id, JSON.stringify([fb])]);
        events.push({ type: "model.fallback", ...evBase(c, id), category: "agents", outcome: b.fallback === "cross_model" ? "regression" : "ok", after: fb });
      }
      const br = await budgetBreach(tx, c);
      if (br && !(await activeStopsFor(tx, c)).some((s) => s.scopeType === "wo" || s.scopeType === "factory" || s.scopeType === "project")) {
        const n = Number((await tx.query<{ n: string }>(`select count(*)::text as n from stops where org_id = $1 and scope_type = 'wo' and wo_id = $2`, [c.orgId, c.woId])).rows[0]!.n) + 1;
        const stopId = `wo:${c.woId}:${n}`;
        const reason = `Budget reached: the ${br.scope === "wo" ? "work order" : br.scope === "run" ? "run" : br.scope === "plan" ? "approved research plan" : "project"} has spent $${(br.spentMicros / 1e6).toFixed(2)} of $${(br.limitMicros / 1e6).toFixed(2)}.`;
        const ins = await tx.query(
          `insert into stops (org_id, id, scope_type, wo_id, mode, reason, cause, set_by, in_flight) values ($1,$2,'wo',$3,'halt',$4,'budget','system',$5) on conflict do nothing`,
          [c.orgId, stopId, c.woId, reason, `run ${id}`],
        );
        if (ins.rowCount) {
          halted = stopId;
          events.push({ type: "stop.set", category: "kill", subject: { type: "wo", id: c.woId }, projectId: c.projectId, woId: c.woId, after: { stop: stopId, scope: "wo", mode: "halt", cause: "budget", breach: br.scope, reason } });
          jobs.push(job("stop.enforce", { stopId, scope: "wo", targetId: c.woId, mode: "halt" }, { dedupeKey: `stop.enforce:${stopId}` }));
        }
      }
      return {
        msg: "Usage recorded.",
        events,
        extra: { costMicros: cost, priceVersion: book.version, unpriced: price === undefined, halted: halted !== null, ...(br ? { breach: br.scope } : {}) },
        jobs,
        changes: halted ? ["stops", "workOrders", "models"] : ["models"],
        project: c.projectId,
      };
    });
  });

  // ---------------------------------------------------------------- heartbeat
  app.post("/internal/v1/runs/:id/heartbeat", async (req) => {
    const id = runId(req);
    const b = HeartbeatBody.parse(req.body);
    return command(req, svc("run.heartbeat"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const { c } = await mustGuard(tx, req.gx.orgId, id, b.token, "progress", true);
      const events: EventSpec[] = [];
      const first = c.runState === "starting";
      if (first) {
        await tx.query(`update runs set state = 'running' where org_id = $1 and id = $2`, [c.orgId, id]);
        events.push({ type: "run.started", ...evBase(c, id), after: { attempt: c.attemptId, station: c.station } });
      }
      const lease = await tx.query<{ lease_until: Date }>(
        `update attempts set lease_until = now() + make_interval(secs => $3) where org_id = $1 and id = $2 returning lease_until`,
        [c.orgId, c.attemptId, LEASE_SECONDS],
      );
      await tx.query(`update runs set data = data || $3::jsonb where org_id = $1 and id = $2`, [c.orgId, id, JSON.stringify({ heartbeat: { seq: b.seq ?? null, phase: b.phase ?? null, turn: b.turn ?? null, at: new Date().toISOString() } })]);
      const halt = (await activeStopsFor(tx, c)).find((s) => s.mode === "halt");
      // Heartbeats are lease pings, not ledger facts: only the first one (run started) is an event.
      return { msg: "Lease extended.", events, extra: { leaseUntil: lease.rows[0]!.lease_until.toISOString(), stop: halt ? "halt" : null }, changes: first ? ["workOrders"] : [], project: c.projectId };
    });
  });

  // ---------------------------------------------------------------- checkpoint
  app.post("/internal/v1/runs/:id/checkpoint", async (req) => {
    const id = runId(req);
    const b = CheckpointBody.parse(req.body);
    return command(req, svc("run.checkpoint"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const { c } = await mustGuard(tx, req.gx.orgId, id, b.token, "progress", true);
      const dup = await tx.query<{ id: string; seq: number }>(
        `select id, seq from checkpoints where org_id = $1 and run_id = $2 and content_hash = $3 and data->>'name' = $4 and (data->>'turn')::int = $5 and data->>'kind' = $6`,
        [c.orgId, id, b.contentHash, b.name, b.turn, b.kind],
      );
      if (dup.rows[0]) return { msg: "Checkpoint already recorded.", events: [], extra: { checkpoint: dup.rows[0].id, seq: dup.rows[0].seq, duplicate: true }, changes: [] };
      const seq = Number((await tx.query<{ n: string }>(`select (coalesce(max(seq),0) + 1)::text as n from checkpoints where org_id = $1 and run_id = $2`, [c.orgId, id])).rows[0]!.n);
      const ckId = `ck-${id}-${seq}`;
      await tx.query(`insert into checkpoints (org_id, id, run_id, attempt_id, seq, content_hash, data) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
        c.orgId, ckId, id, c.attemptId, seq, b.contentHash, JSON.stringify({ turn: b.turn, kind: b.kind, name: b.name, contentType: b.contentType, size: b.size, ...(b.steps?.length ? { steps: b.steps } : {}) }),
      ]);
      if (b.kind === "artefact" && b.content !== undefined && /^text\/markdown\b/i.test(b.contentType)) {
        await recordDocument(tx, { orgId: c.orgId, id: `art-${id}-${seq}`, woId: c.woId, attemptId: c.attemptId, station: c.station, name: b.name, hash: b.contentHash, mediaType: b.contentType, size: b.size, body: b.content, author: c.agentId });
      } else if (b.kind === "artefact") {
        await tx.query(`insert into artefacts (org_id, id, wo_id, attempt_id, kind, name, content_hash, media_type, size_bytes) values ($1,$2,$3,$4,'station',$5,$6,$7,$8)`, [
          c.orgId, `art-${id}-${seq}`, c.woId, c.attemptId, b.name, b.contentHash, b.contentType, b.size,
        ]);
      }
      return {
        msg: "Checkpoint saved.",
        events: [{ type: "run.checkpoint", ...evBase(c, id), after: { checkpoint: ckId, turn: b.turn, kind: b.kind, name: b.name, contentHash: b.contentHash } }],
        extra: { checkpoint: ckId, seq },
        changes: [],
        project: c.projectId,
      };
    });
  });

  // ---------------------------------------------------------------- result
  app.post("/internal/v1/runs/:id/result", async (req) => {
    const id = runId(req);
    const b = ResultBody.parse(req.body);
    return command(req, svc("run.result"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const c0 = await loadRunCtx(tx, req.gx.orgId, id, true);
      const tok = c0 ? await findRunToken(tx, req.gx.orgId, id, b.token) : null;
      if (!c0 || !tok) throw refuse("denied", "The run token is not valid for this run.", { rule: { kind: "invariant", id: "RUN-TOKEN", name: "Run token" } });
      // A retry after a lost response: the stored result stands, nothing is enqueued twice.
      const srId = `sr-${id}`;
      if (tok.attempt_id === c0.attemptId && !tok.revoked && (await tx.query(`select 1 from station_results where org_id = $1 and id = $2`, [c0.orgId, srId])).rowCount) {
        return { msg: "Result already recorded.", events: [], extra: { duplicate: true, resultId: srId }, changes: [] };
      }
      const d = await guardRun(tx, c0, tok, { mode: "progress" });
      if (d) throw refusalFor(d);
      const summary = b.output && typeof b.output === "object" && typeof (b.output as { summary?: unknown }).summary === "string" ? (b.output as { summary: string }).summary : b.error?.msg ?? "";
      const body = { output: b.output ?? null, usage: b.usage, error: b.error ?? null, adapter: b.adapter, capabilities: b.capabilities ?? null, source: "runner" };
      await tx.query(`insert into station_results (org_id, id, attempt_id, wo_id, station, outcome, summary, body) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
        c0.orgId, srId, c0.attemptId, c0.woId, c0.station, b.status, summary.slice(0, 2000), JSON.stringify(body),
      ]);
      return {
        msg: "Result stored.",
        events: [{ type: "run.result", ...evBase(c0, id), after: { attempt: c0.attemptId, station: c0.station, status: b.status, adapter: b.adapter, ...(b.error ? { error: b.error.code } : {}) } }],
        extra: { resultId: srId },
        jobs: [job("run.result", { runId: id, attemptId: c0.attemptId, fencing: c0.fencing }, { dedupeKey: `run.result:${id}` })],
        changes: ["workOrders"],
        project: c0.projectId,
      };
    });
  });

  // ---------------------------------------------------------------- mcp-authorize
  app.post("/internal/v1/runs/:id/mcp-authorize", async (req) => {
    const id = runId(req);
    const b = McpBody.parse(req.body);
    return command(req, svc("mcp.authorize"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const c = await loadRunCtx(tx, req.gx.orgId, id);
      const tok = c ? await findRunToken(tx, req.gx.orgId, id, b.token) : null;
      const log = async (outcome: string, reason: string | null, ctx: RunCtx | null): Promise<number> => {
        const ins = await tx.query<{ id: string }>(`insert into mcp_calls (org_id, server_id, tool, run_id, project_id, wo_id, agent_id, station, args_hash, outcome, reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [
          req.gx.orgId, b.server, b.tool, id, ctx?.projectId ?? null, ctx?.woId ?? null, ctx?.agentId ?? null, ctx?.station ?? null, b.argsHash ?? null, outcome, reason,
        ]);
        return Number(ins.rows[0]!.id);
      };
      const deny = async (code: string, reason: string, ctx: RunCtx | null, extraEvents: EventSpec[] = []): Promise<CommandResult<Record<string, unknown>>> => {
        await log("denied", reason, ctx);
        return {
          msg: reason,
          events: [{ type: "mcp.call.denied", ...evBase(ctx, id), category: "integrations", outcome: "denied", subject: { type: "mcp_tool", id: `${b.server}/${b.tool}` }, after: { code, reason, run: id, ...(b.argsHash ? { argsHash: b.argsHash } : {}) } }, ...extraEvents],
          extra: { allow: false, code, reason },
          changes: ["mcp"],
        };
      };
      if (!c) return deny("token", "The run token is not valid for this run.", null);
      const g = await guardRun(tx, c, tok, { mode: "model" });
      if (g) return deny(g.code, g.reason, c);
      const srv = (await tx.query<{ enabled: boolean; name: string }>(`select enabled, name from mcp_servers where org_id = $1 and id = $2`, [c.orgId, b.server])).rows[0];
      if (!srv) return deny("server", `No such MCP server ${b.server}.`, c);
      if (!srv.enabled) return deny("server", `MCP server ${srv.name} is disabled.`, c);
      if (!(await mcpServersInScope(tx, c)).some((s) => s.id === b.server)) return deny("scope", `MCP server ${srv.name} is not in scope for this project, repository, agent and station.`, c);
      const tool = (await tx.query<{ allowed: boolean; tool_class: "read" | "write"; definition_hash: string }>(`select allowed, tool_class, definition_hash from mcp_tools where org_id = $1 and server_id = $2 and name = $3`, [c.orgId, b.server, b.tool])).rows[0];
      if (!tool) return deny("tool", `Tool ${b.tool} is not registered on ${srv.name}.`, c);
      // Spec 12.4, fail closed: a call whose live definition the edge could not read (server down, or the tool missing from its own listing) is not allowed.
      if (!b.definitionHash) return deny("definition", `The live definition of ${b.tool} could not be verified, so the call was not allowed.`, c);
      if (b.definitionHash !== tool.definition_hash) {
        // Spec 12.4: a changed tool definition disables the server until an admin re-approves it.
        await tx.query(`update mcp_servers set enabled = false, disabled_reason = $3, version = version + 1 where org_id = $1 and id = $2`, [c.orgId, b.server, `Definition of ${b.tool} changed`]);
        await tx.query(`update mcp_tools set pending_hash = $4, updated_at = now() where org_id = $1 and server_id = $2 and name = $3`, [c.orgId, b.server, b.tool, b.definitionHash]);
        return deny("definition", `The definition of ${b.tool} changed; ${srv.name} is disabled until an admin re-approves it.`, c, [
          { type: "mcp.server.disabled", ...evBase(c, id), category: "integrations", subject: { type: "mcp_server", id: b.server }, after: { reason: `Definition of ${b.tool} changed` } },
        ]);
      }
      if (!tool.allowed) return deny("tool", `Tool ${b.tool} is not allowed.`, c);
      if (tool.tool_class === "write") {
        // Write tools are pre-authorised at the station gate for this work order and attempt (spec 12.4); the grant lives on the attempt.
        const grants = Array.isArray(c.attemptData.writeGrants) ? (c.attemptData.writeGrants as unknown[]) : [];
        if (!grants.some((x) => x === `${b.server}/${b.tool}` || x === `${b.server}/*`)) return deny("preauth", `${b.tool} is a write tool and this attempt has no pre-authorisation for it.`, c);
      }
      const callId = await log("allowed", null, c);
      // Spec 12.4: write calls are never retried automatically. Only a read call may be sent again after a transport failure.
      return { msg: "Allowed.", events: [], extra: { allow: true, class: tool.tool_class, retry: tool.tool_class === "read", callId }, changes: ["mcp"], project: c.projectId };
    });
  });

  // ---------------------------------------------------------------- reads: spec, egress
  app.get("/internal/v1/runs/:id/spec", async (req) => {
    const id = runId(req);
    const token = z.string().min(20).max(700).parse(req.headers["x-run-token"]);
    const g = req.server.gantry;
    const c = await loadRunCtx(g.pool, g.orgId, id);
    const tok = c ? await findRunToken(g.pool, g.orgId, id, token) : null;
    if (!c || !tok) throw refuse("denied", "The run token is not valid for this run.");
    const d = await guardRun(g.pool, c, tok, { mode: "model" });
    if (d) throw refusalFor(d);
    const spec = await composeRunSpec(g.pool, c, edgeUrl());
    if ("error" in spec) throw refuse("invalid", spec.error);
    // What this run was actually given: the manifest at spec time (parts, versions, hashes, handoff size). `pinnedHash` is what dispatch pinned on the tuple;
    // a difference means a layer or skill moved between dispatch and start, and the audit can see it. A repeated serve of the same spec writes nothing.
    const pinned = c.instructionHash;
    if (c.runData.promptHash !== spec.promptManifest.hash || c.runData.pinnedHash !== pinned) {
      await command(req, svc("run.spec"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
        await tx.query(`update runs set data = data || $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [c.orgId, id, JSON.stringify({ promptManifest: spec.promptManifest, promptHash: spec.promptManifest.hash, pinnedHash: pinned, promptDrift: pinned !== null && pinned !== spec.promptManifest.hash })]);
        return { msg: "Prompt manifest recorded.", events: [], extra: {}, changes: [] };
      });
    }
    return spec;
  });

  // The proxy authenticates a run by its token and asks for that run's project allow-list (spec 5.3).
  app.post("/internal/v1/runs/:id/egress", async (req) => {
    const id = runId(req);
    const b = EgressBody.parse(req.body);
    const g = req.server.gantry;
    const c = await loadRunCtx(g.pool, g.orgId, id);
    const tok = c ? await findRunToken(g.pool, g.orgId, id, b.token) : null;
    if (!c || !tok) throw refuse("denied", "The run token is not valid for this run.");
    const d = await guardRun(g.pool, c, tok, { mode: "model" });
    if (d) throw refusalFor(d);
    return { ok: true, projectId: c.projectId, hosts: await runEgressHosts(g.pool, c) };
  });

  // Spec 5.3: refused outbound connections are logged. The edge reports each refusal (deduplicated per minute) so it lands in the audit ledger.
  app.post("/internal/v1/egress/denied", async (req) => {
    const b = EgressDeniedBody.parse(req.body);
    return command(req, svc("egress.denied"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const c = b.runId ? await loadRunCtx(tx, req.gx.orgId, b.runId) : null;
      return {
        msg: "Recorded.",
        events: [{
          type: "egress.denied",
          category: "integrations",
          outcome: "denied",
          subject: c ? subject(c.runId) : { type: "egress", id: b.caller },
          projectId: c?.projectId ?? null,
          woId: c?.woId ?? null,
          after: { caller: b.caller, host: b.host, port: b.port, reason: b.reason, ...(c ? { run: c.runId, station: c.station } : {}) },
        }],
        extra: {},
        changes: ["audit"],
        ...(c ? { project: c.projectId } : {}),
      };
    });
  });

  // ---------------------------------------------------------------- governed web research (Phase 2): the edge's research fetcher asks and records here
  app.post("/internal/v1/runs/:id/research/hosts", async (req) => {
    const id = runId(req);
    const b = EgressBody.parse(req.body);
    const g = req.server.gantry;
    const c = await loadRunCtx(g.pool, g.orgId, id);
    const tok = c ? await findRunToken(g.pool, g.orgId, id, b.token) : null;
    if (!c || !tok) throw refuse("denied", "The run token is not valid for this run.");
    const d = await guardRun(g.pool, c, tok, { mode: "model" });
    if (d) throw refusalFor(d);
    return { ok: true, hosts: await researchHosts(g.pool, c.orgId, c.woData) };
  });
  app.post("/internal/v1/runs/:id/research/source", async (req) => {
    const id = runId(req);
    const b = SourceBody.parse(req.body);
    return command(req, svc("research.fetch"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const { c } = await mustGuard(tx, req.gx.orgId, id, b.token, "progress", true);
      const ref = await recordSource(tx, { orgId: c.orgId, woId: c.woId, station: c.station, attemptId: c.attemptId, runId: id, agent: c.agentId, url: b.url, finalUrl: b.finalUrl, title: b.title, httpStatus: b.httpStatus ?? null, contentType: b.contentType, contentHash: b.contentHash, size: b.size, truncated: b.truncated, why: b.why, excerpt: b.excerpt });
      return {
        msg: "Source recorded.",
        events: [{ type: "research.fetch", category: "integrations", subject: subject(id), projectId: c.projectId, woId: c.woId, after: { run: id, station: c.station, ref, url: b.finalUrl, title: b.title, contentHash: b.contentHash, size: b.size } }],
        extra: { ref }, changes: ["workOrders"], project: c.projectId,
      };
    });
  });
  app.post("/internal/v1/runs/:id/research/refused", async (req) => {
    const id = runId(req);
    const b = RefusedBody.parse(req.body);
    return command(req, svc("research.refused"), async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const c = await loadRunCtx(tx, req.gx.orgId, id);
      const tok = c ? await findRunToken(tx, req.gx.orgId, id, b.token) : null;
      if (!c || !tok) throw refuse("denied", "The run token is not valid for this run.");
      return {
        msg: "Recorded.",
        events: [{ type: "research.refused", category: "integrations", outcome: "denied", subject: subject(id), projectId: c.projectId, woId: c.woId, after: { run: id, station: c.station, url: b.url, reason: b.reason } }],
        extra: {}, changes: ["audit"], project: c.projectId,
      };
    });
  });

  // The worker's delivery allow-list (spec 12.2).
  app.get("/internal/v1/egress/system", async (req) => {
    const g = req.server.gantry;
    return { ok: true, hosts: await systemEgressHosts(g.pool, g.orgId) };
  });

};
