/**
 * The routing default (spec 10.4) and the models the gateway can call. `ensureDefaultModel` sets a default when the org has none and a callable
 * enabled model exists (a vendor was just connected, a model switched on, or the API started on an existing org); it never replaces a default.
 */
import { appendEvent, type Tx } from "@gantry/db";
import { loadFacts } from "./facts.js";
import { resolveModel, type ResolveInput, type VendorFacts } from "./resolve.js";
import { loadRouting, modelRows, type ModelRow } from "./store.js";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** The starter kit's general model: what a new factory is expected to answer with. */
export const GENERAL_MODEL = "claude-sonnet-5-5";

export const vendorBase = (v: VendorFacts): string => (v.endpoint || (/anthropic|claude/i.test(`${v.id} ${v.product}`) ? ANTHROPIC_BASE_URL : "")).replace(/\/+$/, "");

export interface CallableModel { id: string; name: string; vendor: string; vendorName: string; tier: string; canonical: string; inPrice: number; outPrice: number; context: number }

/**
 * Enabled models the gateway can call right now for the console station: enabled, vendor connected, invocable, an endpoint, a key (or keyless),
 * and passing the routing filter (project policy when `project` is given). Ordered: the starter kit's general model first, then creation order.
 */
export function callableModels(facts: Pick<ResolveInput, "routing" | "vendors" | "models">, rows: ModelRow[], opts: { project?: string | undefined } = {}): CallableModel[] {
  const vendors = new Map(facts.vendors.map((v) => [v.id, v]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: CallableModel[] = [];
  for (const m of facts.models) {
    const row = byId.get(m.id);
    const v = vendors.get(m.vendorId);
    if (!row || !v || !m.enabled || row.data.invocable === false) continue;
    if (!vendorBase(v)) continue;
    if (!v.hasSecret && !(v.endpoint !== "" && (v.custom || v.id === "local"))) continue;
    const r = resolveModel({ routing: facts.routing, vendors: facts.vendors, models: facts.models, station: "console", pinned: m.id, project: opts.project });
    if (!r.pick || r.pick.model !== m.id) continue;
    out.push({
      id: m.id, name: row.name, vendor: v.id, vendorName: v.name, tier: typeof row.data.tier === "string" ? row.data.tier : "standard", canonical: m.canonical,
      inPrice: Number(row.data.inPrice ?? 0), outPrice: Number(row.data.outPrice ?? 0), context: row.context_tokens,
    });
  }
  return out.sort((a, b) => Number(b.canonical === GENERAL_MODEL) - Number(a.canonical === GENERAL_MODEL));
}

/**
 * Sets the factory default when there is none. Returns the model chosen, or null (a default exists, or nothing callable). Audited as a system
 * routing change. Safe to call from any transaction that connected a vendor or enabled a model.
 */
export async function ensureDefaultModel(tx: Tx, orgId: string, cause: string): Promise<string | null> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`routing_versions:${orgId}`]);
  const prev = await loadRouting(tx, orgId);
  if (prev.defaultModel) return null;
  const [facts, rows] = [await loadFacts(tx, orgId), await modelRows(tx, orgId)];
  const pick = callableModels(facts, rows)[0];
  if (!pick) return null;
  const { version: _v, ...before } = prev;
  const body = { ...before, defaultModel: pick.id, fallback: before.fallback.length ? before.fallback : [pick.id] };
  const version = prev.version + 1;
  await tx.query(`insert into routing_versions (org_id, version, body, note, published_at, published_by) values ($1,$2,$3::jsonb,$4,now(),'system')`, [orgId, version, JSON.stringify(body), "Default model set automatically"]);
  await appendEvent(tx, {
    orgId, type: "routing.edit", category: "agents", actor: "system", channel: "system", subject: { type: "routing", id: "factory" }, before,
    after: { ...body, version, label: "Default model set automatically", cause, automatic: true },
  });
  return pick.id;
}
