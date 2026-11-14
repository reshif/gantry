import type { Queryable } from "@gantry/db";
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
export async function resolveServiceRoute(db: Queryable, orgId: string): Promise<ServiceRoute> {
  const facts = await loadFacts(db, orgId);
  const res = resolveModel({ ...facts, station: "console" });
  if (!res.wanted) return { ok: false, reason: "No default model is set in routing." };
  if (!res.pick) return { ok: false, reason: res.blocked ?? "No vendor is available for the console's model." };
  const vendors = new Map(facts.vendors.map((v) => [v.id, v]));
  const v = vendors.get(res.pick.vendor)!;
  const base = (v.endpoint || (/anthropic|claude/i.test(`${v.id} ${v.product}`) ? ANTHROPIC_BASE_URL : "")).replace(/\/+$/, "");
  if (!base) return { ok: false, reason: `Vendor ${v.name} has no endpoint.` };
  const keyless = (p: Pick): boolean => !v.hasSecret && v.endpoint !== "" && (v.custom || p.vendor === "local");
  return { ok: true, route: { vendor: res.pick.vendor, baseUrl: base, modelId: res.pick.model, upstreamModel: res.pick.upstream, ...(keyless(res.pick) ? { keyless: true } : {}) } };
}
