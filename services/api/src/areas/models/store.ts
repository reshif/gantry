/** Vendor, model, routing and budget reads: rows to the legacy `G.store.vendors` and `G.store.routing` shapes. */
import type { Queryable } from "@gantry/db";
import type { Model, Routing, Vendor, VendorHealth } from "@gantry/domain";
import { canonicalOf, type ModelFacts, type VendorFacts } from "./resolve.js";
import { priceBookAt } from "./prices.js";

export interface VendorRow {
  id: string;
  name: string;
  product: string;
  connected: boolean;
  endpoint: string;
  region: string;
  residency: string;
  secret_mask: string | null;
  has_secret: boolean;
  monthly_budget_micros: string | null;
  config: Record<string, unknown>;
  version: number;
}
export interface ModelRow {
  id: string;
  vendor_id: string;
  name: string;
  enabled: boolean;
  context_tokens: number;
  data: Record<string, unknown>;
}

export async function vendorRows(db: Queryable, orgId: string, id?: string, lock = false): Promise<VendorRow[]> {
  const { rows } = await db.query<VendorRow>(
    `select id, name, product, connected, endpoint, region, residency, secret_mask, secret_enc is not null as has_secret, monthly_budget_micros::text, config, version
       from vendors where org_id = $1 ${id ? "and id = $2" : ""} order by created_at, id ${lock ? "for update" : ""}`,
    id ? [orgId, id] : [orgId],
  );
  return rows;
}

export async function modelRows(db: Queryable, orgId: string, id?: string, lock = false): Promise<ModelRow[]> {
  const { rows } = await db.query<ModelRow>(
    `select id, vendor_id, name, enabled, context_tokens, data from models where org_id = $1 ${id ? "and id = $2" : ""} order by created_at, id ${lock ? "for update" : ""}`,
    id ? [orgId, id] : [orgId],
  );
  return rows;
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
export const qualifiedOf = (c: Record<string, unknown>): Record<string, { suite: string; run: string; at: string }> => {
  const q = c.qualified;
  if (!q || typeof q !== "object") return {};
  const out: Record<string, { suite: string; run: string; at: string }> = {};
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (v && typeof v === "object") out[k] = { suite: str((v as Record<string, unknown>).suite), run: str((v as Record<string, unknown>).run), at: str((v as Record<string, unknown>).at) };
  }
  return out;
};

export function vendorFacts(v: VendorRow): VendorFacts {
  return {
    id: v.id, name: v.name, connected: v.connected, endpoint: v.endpoint, product: v.product, region: v.region, retention: str(v.config.retention, "standard"),
    custom: v.config.custom === true, hasSecret: v.has_secret, qualified: Object.keys(qualifiedOf(v.config)),
  };
}
export function modelFacts(m: ModelRow): ModelFacts {
  return { id: m.id, vendorId: m.vendor_id, enabled: m.enabled, canonical: canonicalOf(m.id, m.data.canonical), upstream: str(m.data.upstream, m.id) };
}

export function normaliseRouting(b: unknown): Routing {
  const o = (b && typeof b === "object" ? b : {}) as Partial<Routing>;
  const rec = (x: unknown): Record<string, string> => (x && typeof x === "object" ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v) as Array<[string, string]>) : {});
  const out: Routing = {
    defaultModel: str(o.defaultModel),
    overrides: rec(o.overrides),
    fallback: Array.isArray(o.fallback) ? o.fallback.filter((x): x is string => typeof x === "string") : [],
    rules: Array.isArray(o.rules) ? o.rules.map((x) => ({ id: str(x?.id), tag: str(x?.tag), use: str(x?.use), region: str(x?.region), alt: str(x?.alt), note: str(x?.note) })) : [],
  };
  if (o.classOverrides && Object.keys(o.classOverrides).length) out.classOverrides = rec(o.classOverrides);
  if (o.projects && typeof o.projects === "object" && Object.keys(o.projects).length) out.projects = o.projects;
  if (o.crossModelFallback === true) out.crossModelFallback = true;
  return out;
}

/** The latest published routing version, normalised, with its version number. */
export async function loadRouting(db: Queryable, orgId: string): Promise<Routing & { version: number }> {
  const { rows } = await db.query<{ version: number; body: Record<string, unknown> }>(`select version, body from routing_versions where org_id = $1 and published_at is not null order by version desc limit 1`, [orgId]);
  const r = rows[0];
  return { ...normaliseRouting(r?.body), version: r?.version ?? 0 };
}

/** Vendor reads. Health, latency and spend come from the usage meter, never from a stored claim. */
export async function readVendors(db: Queryable, orgId: string): Promise<Vendor[]> {
  const [vs, ms, book, spend, health] = await Promise.all([
    vendorRows(db, orgId),
    modelRows(db, orgId),
    priceBookAt(db, orgId),
    db.query<{ vendor_id: string; mtd: string }>(`select vendor_id, coalesce(sum(cost_micros),0)::text as mtd from usage_meter where org_id = $1 and vendor_id is not null and at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' group by vendor_id`, [orgId]),
    db.query<{ vendor_id: string; n: string; errors: string; p50: string | null }>(
      `select vendor_id, count(*)::text as n, count(*) filter (where outcome <> 'ok')::text as errors, percentile_cont(0.5) within group (order by latency_ms)::text as p50
         from usage_meter where org_id = $1 and vendor_id is not null and at >= now() - interval '1 hour' group by vendor_id`,
      [orgId],
    ),
  ]);
  const mtd = new Map(spend.rows.map((r) => [r.vendor_id, Number(r.mtd) / 1_000_000]));
  const h = new Map(health.rows.map((r) => [r.vendor_id, r]));
  return vs.map((v): Vendor => {
    const hr = h.get(v.id);
    const n = hr ? Number(hr.n) : 0;
    const errRate = hr && n > 0 ? Number(hr.errors) / n : 0;
    const state: VendorHealth = !v.connected ? "offline" : n >= 5 && errRate >= 0.02 ? "degraded" : "healthy";
    const models: Model[] = ms.filter((m) => m.vendor_id === v.id).map((m) => {
      const p = book.prices[m.id];
      return {
        id: m.id, name: m.name, enabled: m.enabled, context: m.context_tokens, vendor: v.id,
        inPrice: p ? p.in : Number(m.data.inPrice ?? 0), outPrice: p ? p.out : Number(m.data.outPrice ?? 0),
        ...(typeof m.data.tier === "string" ? { tier: m.data.tier } : {}), ...(m.data.custom === true ? { custom: true } : {}), canonical: canonicalOf(m.id, m.data.canonical),
        ...(p?.cacheRead !== undefined ? { cacheRead: p.cacheRead } : {}), ...(p?.cacheWrite !== undefined ? { cacheWrite: p.cacheWrite } : {}),
      };
    });
    return {
      id: v.id, name: v.name, product: v.product, connected: v.connected, health: state, latency: v.connected && hr?.p50 ? Math.round(Number(hr.p50)) : 0,
      mtd: mtd.get(v.id) ?? 0, budget: v.monthly_budget_micros ? Number(v.monthly_budget_micros) / 1_000_000 : 0, keyMask: v.secret_mask ?? "", region: v.region, endpoint: v.endpoint,
      residency: v.residency, models, retention: str(v.config.retention, "standard"), ...(v.config.custom === true ? { custom: true } : {}), qualified: qualifiedOf(v.config), version: v.version,
    };
  });
}
