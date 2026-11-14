import type { Queryable } from "@gantry/db";
import type { RunCtx } from "./context.js";

export interface ModelRoute {
  vendor: string;
  baseUrl: string;
  modelId: string;
}

export type RouteResult = { ok: true; route: ModelRoute } | { ok: false; reason: string };

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Latest published routing version's default model (spec 10.4: default, then project, station, class; overrides are keyed by station or class). */
async function routedModel(db: Queryable, c: RunCtx): Promise<string | null> {
  const { rows } = await db.query<{ body: { defaultModel?: string; overrides?: Record<string, string> } }>(
    `select body from routing_versions where org_id = $1 and published_at is not null order by version desc limit 1`,
    [c.orgId],
  );
  const b = rows[0]?.body;
  if (!b) return null;
  return b.overrides?.[c.station] ?? b.overrides?.[c.woClass] ?? b.defaultModel ?? null;
}

/**
 * The vendor route for one call. Agents pin an exact model id (spec 10.4 Model identity), so a call for any other model is refused.
 * The route is filtered by the project's allowed vendors (project config extra.allowedVendors, when set), and the model and vendor must be enabled and connected.
 * Fallback to the same model on another vendor is not modelled yet: a model belongs to one vendor row.
 */
export async function resolveRoute(db: Queryable, c: RunCtx, requested: string | undefined): Promise<RouteResult> {
  const pinned = c.runModel ?? c.tupleModel ?? (await routedModel(db, c));
  if (!pinned) return { ok: false, reason: "No model is pinned for this run and routing has no default." };
  if (requested && requested !== pinned) return { ok: false, reason: `This run is pinned to model ${pinned}; ${requested} is not allowed.` };
  const { rows } = await db.query<{ model_enabled: boolean; vendor_id: string; connected: boolean; endpoint: string; product: string; name: string }>(
    `select m.enabled as model_enabled, v.id as vendor_id, v.connected, v.endpoint, v.product, v.name
       from models m join vendors v on v.org_id = m.org_id and v.id = m.vendor_id where m.org_id = $1 and m.id = $2`,
    [c.orgId, pinned],
  );
  const m = rows[0];
  if (!m) return { ok: false, reason: `Model ${pinned} is not registered.` };
  if (!m.model_enabled) return { ok: false, reason: `Model ${pinned} is disabled.` };
  if (!m.connected) return { ok: false, reason: `Vendor ${m.name} is not connected.` };
  const extra = (c.projectConfig.extra ?? {}) as { allowedVendors?: unknown };
  if (Array.isArray(extra.allowedVendors) && !extra.allowedVendors.includes(m.vendor_id)) return { ok: false, reason: `Vendor ${m.name} is not allowed for this project.` };
  const baseUrl = m.endpoint || (/anthropic|claude/i.test(`${m.vendor_id} ${m.product}`) ? ANTHROPIC_BASE_URL : "");
  if (!baseUrl) return { ok: false, reason: `Vendor ${m.name} has no endpoint.` };
  return { ok: true, route: { vendor: m.vendor_id, baseUrl: baseUrl.replace(/\/+$/, ""), modelId: pinned } };
}
