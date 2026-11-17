import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { command, type CommandResult } from "../../core/command.js";
import { requireEdge } from "./edge-only.js";
import { costMicros, currentPrices } from "./metering.js";
import { resolveServiceRoute } from "../console/route.js";
import { resolveOnboardingRoute } from "../onboarding/route.js";

const nonneg = z.number().int().nonnegative().max(2 ** 53 - 1);
const Purpose = z.enum(["console", "explain", "onboarding"]);
const AuthorizeBody = z.object({ purpose: Purpose, model: z.string().min(1).max(200).optional(), project: z.string().min(1).max(100).optional() });
const UsageBody = z.object({
  purpose: Purpose,
  requestId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200),
  vendor: z.string().min(1).max(200).optional(),
  inputTokens: nonneg,
  outputTokens: nonneg,
  cacheReadTokens: nonneg.default(0),
  cacheWriteTokens: nonneg.default(0),
  latencyMs: nonneg.optional(),
  outcome: z.enum(["ok", "error", "refused"]).default("ok"),
  /** The stored trace of the call (sha256/<hash>) and where the call belongs: who may read the trace is decided from these. */
  traceRef: z.string().regex(/^sha256\/[0-9a-f]{64}$/).optional(),
  surface: z.enum(["console", "explain", "onboarding", "workorder"]).optional(),
  project: z.string().min(1).max(100).optional(),
  woId: z.string().min(1).max(100).optional(),
  actor: z.string().min(1).max(100).optional(),
  turn: z.string().min(1).max(100).optional(),
  promptHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

/**
 * Model calls that belong to no run (spec 12.6), asked of the edge by the API itself with the edge token: the console and the "why not" explainer.
 * The edge asks here for the route and reports the metered usage; like the run endpoints they exist for the edge only (requireEdge).
 */
export const serviceCallRoutes: FastifyPluginAsync = async (app) => {
  app.post("/internal/v1/service-calls/authorize", async (req) => {
    const ab = AuthorizeBody.parse(req.body);
    await requireEdge(req, "service-call.authorize");
    const g = req.server.gantry;
    // The onboarding session runs on the Onboarding Agent's pinned model, not on the console's default.
    const r = ab.purpose === "onboarding" ? await resolveOnboardingRoute(g.pool, g.orgId) : await resolveServiceRoute(g.pool, g.orgId, { model: ab.model, project: ab.project });
    if (!r.ok) return { ok: true, msg: r.reason, allow: false, code: "route", reason: r.reason };
    return { ok: true, msg: "Allowed.", allow: true, reason: "ok", route: r.route };
  });

  app.post("/internal/v1/service-calls/usage", async (req) => {
    const b = UsageBody.parse(req.body);
    await requireEdge(req, "service-call.usage");
    return command(req, { action: null, service: true, reduced: false }, async (tx): Promise<CommandResult<Record<string, unknown>>> => {
      const book = await currentPrices(tx, req.gx.orgId);
      const cost = costMicros(book.prices[b.model], { inputTokens: b.inputTokens, outputTokens: b.outputTokens, cacheReadTokens: b.cacheReadTokens, cacheWriteTokens: b.cacheWriteTokens });
      // station = the purpose, so spend by the console is visible next to the stations' and counts toward the vendor's health.
      const r = await tx.query(
        `insert into usage_meter (org_id, request_id, station, vendor_id, model_id, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_micros, price_version, latency_ms, outcome, agent_id, trace_ref, surface, project_id, wo_id, actor_id, turn_id, prompt_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [req.gx.orgId, b.requestId ?? null, b.purpose, b.vendor ?? null, b.model, b.inputTokens, b.outputTokens, b.cacheReadTokens, b.cacheWriteTokens, cost, book.version, b.latencyMs ?? null, b.outcome, b.purpose === "onboarding" ? "ag-onboard" : null, b.traceRef ?? null, b.surface ?? b.purpose, b.project ?? null, b.woId ?? null, b.actor ?? null, b.turn ?? null, b.promptHash ?? null],
      );
      // The work order's own session (Intake, the work-order session) has no run, so its tokens and cost go on the station entry it happened at. A side thread (@mention, side chat) carries no work-order id and adds nothing here.
      let onWo = false;
      if (b.woId && b.surface === "workorder") {
        const w = (await tx.query<{ data: Record<string, unknown> }>(`select data from work_orders where org_id = $1 and id = $2 for update`, [req.gx.orgId, b.woId])).rows[0];
        const h = Array.isArray(w?.data.history) ? (w!.data.history as Array<{ endedAt?: number | null; tokens?: number; cost?: number }>) : [];
        const e = h.slice().reverse().find((x) => !x.endedAt) ?? h[h.length - 1];
        if (w && e) {
          e.tokens = (Number(e.tokens) || 0) + b.inputTokens + b.outputTokens;
          e.cost = (Number(e.cost) || 0) + cost / 1e6;
          await tx.query(`update work_orders set data = $3::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [req.gx.orgId, b.woId, JSON.stringify(w.data)]);
          onWo = true;
        }
      }
      return { msg: "Usage recorded.", events: [], extra: { costMicros: cost, priceVersion: book.version, rows: r.rowCount ?? 0 }, changes: onWo ? ["models", "workOrders"] : ["models"] };
    });
  });
};
