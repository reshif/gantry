import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { command, type CommandResult } from "../../core/command.js";
import { requireEdge } from "./edge-only.js";
import { costMicros, currentPrices } from "./metering.js";
import { resolveServiceRoute } from "../console/route.js";

const nonneg = z.number().int().nonnegative().max(2 ** 53 - 1);
const Purpose = z.enum(["console", "explain"]);
const AuthorizeBody = z.object({ purpose: Purpose });
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
});

/**
 * Model calls that belong to no run (spec 12.6), asked of the edge by the API itself with the edge token: the console and the "why not" explainer.
 * The edge asks here for the route and reports the metered usage; like the run endpoints they exist for the edge only (requireEdge).
 */
export const serviceCallRoutes: FastifyPluginAsync = async (app) => {
  app.post("/internal/v1/service-calls/authorize", async (req) => {
    AuthorizeBody.parse(req.body);
    await requireEdge(req, "service-call.authorize");
    const g = req.server.gantry;
    const r = await resolveServiceRoute(g.pool, g.orgId);
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
        `insert into usage_meter (org_id, request_id, station, vendor_id, model_id, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_micros, price_version, latency_ms, outcome)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [req.gx.orgId, b.requestId ?? null, b.purpose, b.vendor ?? null, b.model, b.inputTokens, b.outputTokens, b.cacheReadTokens, b.cacheWriteTokens, cost, book.version, b.latencyMs ?? null, b.outcome],
      );
      return { msg: "Usage recorded.", events: [], extra: { costMicros: cost, priceVersion: book.version, rows: r.rowCount ?? 0 }, changes: ["models"] };
    });
  });
};
