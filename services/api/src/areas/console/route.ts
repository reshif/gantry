import type { Queryable, Tx } from "@gantry/db";
import { callableModels, type CallableModel } from "../models/default.js";
import { modelRows } from "../models/store.js";
import { readSecurity } from "../../core/read/index.js";
import { loadFacts } from "../models/facts.js";
import { resolveModel, type Pick } from "../models/resolve.js";
import type { ModelRoute } from "../internal/route.js";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export type ServiceRoute = { ok: true; route: ModelRoute } | { ok: false; reason: string };

/**
 * The route for a model call that belongs to no run (the console, "explain why not"; spec 12.6). It uses the same resolver as a run, with the
 * station `console`: the routing default, or the factory's `console` station override, filtered to a connected vendor that has an endpoint.
 * Nothing is routed to a vendor that is not connected, a disabled model or a custom vendor not qualified for the console station.
 */
export async function resolveServiceRoute(db: Queryable, orgId: string, opts: { model?: string | undefined; project?: string | undefined } = {}): Promise<ServiceRoute> {
  const facts = await loadFacts(db, orgId);
  const res = resolveModel({ ...facts, station: "console", pinned: opts.model || undefined, project: opts.project || undefined });
  if (!res.wanted) return { ok: false, reason: "No default model is set in routing." };
  if (!res.pick) return { ok: false, reason: res.blocked ?? "No vendor is available for the console's model." };
  const vendors = new Map(facts.vendors.map((v) => [v.id, v]));
  const v = vendors.get(res.pick.vendor)!;
  const lan = (await readSecurity(db, orgId)).value.vendorLanRanges ?? [];
  const base = (v.endpoint || (/anthropic|claude/i.test(`${v.id} ${v.product}`) ? ANTHROPIC_BASE_URL : "")).replace(/\/+$/, "");
  if (!base) return { ok: false, reason: `Vendor ${v.name} has no endpoint.` };
  const keyless = (p: Pick): boolean => !v.hasSecret && v.endpoint !== "" && (v.custom || p.vendor === "local");
  return { ok: true, route: { vendor: res.pick.vendor, baseUrl: base, modelId: res.pick.model, upstreamModel: res.pick.upstream, ...(keyless(res.pick) ? { keyless: true } : {}), ...(lan.length ? { lan } : {}) } };
}

/** The console's model for one person (the one resolver the status, the picker and the message handler share): their saved choice when it is still callable, else the routing default. */
export async function consoleModel(db: Queryable, orgId: string, person: string, project?: string): Promise<{ options: CallableModel[]; choice: string | null; saved: string | null; default: string | null; effective: string | null }> {
  const [facts, rows, saved] = [await loadFacts(db, orgId), await modelRows(db, orgId), await getModelPref(db, orgId, person)];
  const options = callableModels(facts, rows, { project });
  const ok = (id: string | null): id is string => !!id && options.some((o) => o.id === id);
  const def = facts.routing.defaultModel || null;
  const effective = ok(saved) ? saved : (() => { const r = resolveModel({ ...facts, station: "console", project }); return r.pick && ok(r.pick.model) ? r.pick.model : null; })() ?? options[0]?.id ?? null;
  return { options, choice: ok(saved) ? saved : null, saved, default: def, effective };
}

export async function getModelPref(db: Queryable, orgId: string, person: string): Promise<string | null> {
  const { rows } = await db.query<{ model_id: string | null }>(`select model_id from console_prefs where org_id = $1 and person_id = $2`, [orgId, person]);
  return rows[0]?.model_id ?? null;
}
export async function setModelPref(tx: Tx, orgId: string, person: string, model: string | null): Promise<void> {
  await tx.query(
    `insert into console_prefs (org_id, person_id, model_id, updated_at) values ($1,$2,$3,now()) on conflict (org_id, person_id) do update set model_id = excluded.model_id, updated_at = now()`,
    [orgId, person, model],
  );
}
