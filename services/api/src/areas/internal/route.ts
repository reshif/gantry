import type { Queryable } from "@gantry/db";
import type { RunCtx } from "./context.js";
import { loadFacts, repoTagsFor } from "../models/facts.js";
import { resolveModel, type Pick } from "../models/resolve.js";

export interface ModelRoute {
  vendor: string;
  baseUrl: string;
  modelId: string;
  /** The id the vendor's API expects. The edge rewrites the request's model with it only when it differs from the model the run asked for. */
  upstreamModel: string;
  /** Tried by the edge, in order, when this vendor errors before any byte reached the run (a turn boundary). */
  alternates?: ModelAlternate[];
  /** The primary route is itself a different model than the one the run pinned (cross-model fallback, opted in): the edge reports usage as flagged. */
  crossModel?: boolean;
  /** A custom or on-prem endpoint vendor with no stored key (an on-prem server without a token): the edge sends no key. */
  keyless?: boolean;
}
export interface ModelAlternate {
  vendor: string;
  baseUrl: string;
  modelId: string;
  upstreamModel: string;
  /** A different model than the one the run asked for. Spec 10.4: flagged on the run. */
  crossModel: boolean;
  keyless?: boolean;
}

export type RouteResult = { ok: true; route: ModelRoute; flags: { sameModel: boolean; crossModel: boolean; wanted: string | null } } | { ok: false; reason: string };

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * The vendor route for one call (spec 10.4). Agents pin an exact model id, so a call for any other model is refused. Routing (default, project,
 * station, class), the project's allowed vendors, regions and retention modes, the repo's residency rule and custom-vendor qualification are
 * applied by the shared resolver. Fallback is only to the same model on another allowed vendor, unless the factory switch and the project's opt-in allow a different model.
 */
export async function resolveRoute(db: Queryable, c: RunCtx, requested: string | undefined): Promise<RouteResult> {
  const pinned = c.runModel ?? c.tupleModel ?? null;
  if (requested && pinned && requested !== pinned) return { ok: false, reason: `This run is pinned to model ${pinned}; ${requested} is not allowed.` };
  const [facts, repo] = await Promise.all([loadFacts(db, c.orgId), repoTagsFor(db, c.orgId, c.repoId)]);
  const extra = (c.projectConfig.extra ?? {}) as { allowedVendors?: unknown; crossModelFallback?: unknown };
  const res = resolveModel({
    ...facts,
    station: c.station,
    woClass: c.woClass,
    project: c.projectId,
    repoTags: repo?.tags,
    pinned,
    projectAllowedVendors: Array.isArray(extra.allowedVendors) ? extra.allowedVendors.filter((x): x is string => typeof x === "string") : undefined,
    projectCrossModel: extra.crossModelFallback === true,
  });
  if (!pinned && !res.wanted) return { ok: false, reason: "No model is pinned for this run and routing has no default." };
  if (requested && !pinned && requested !== res.wanted) return { ok: false, reason: `Routing sends this run to ${res.wanted}; ${requested} is not allowed.` };
  if (!res.pick) return { ok: false, reason: res.blocked ?? "No model is available." };
  const vendors = new Map(facts.vendors.map((v) => [v.id, v]));
  const keyless = (p: Pick): boolean => {
    const v = vendors.get(p.vendor)!;
    return !v.hasSecret && v.endpoint !== "" && (v.custom || v.id === "local");
  };
  const baseOf = (p: Pick): string => {
    const v = vendors.get(p.vendor)!;
    return (v.endpoint || (/anthropic|claude/i.test(`${v.id} ${v.product}`) ? ANTHROPIC_BASE_URL : "")).replace(/\/+$/, "");
  };
  const base = baseOf(res.pick);
  if (!base) return { ok: false, reason: `Vendor ${vendors.get(res.pick.vendor)!.name} has no endpoint.` };
  const alternates: ModelAlternate[] = res.alternates
    .map((p) => ({ vendor: p.vendor, baseUrl: baseOf(p), modelId: p.model, upstreamModel: p.upstream, crossModel: p.crossModel, ...(keyless(p) ? { keyless: true } : {}) }))
    .filter((p) => p.baseUrl !== "");
  return {
    ok: true,
    route: { vendor: res.pick.vendor, baseUrl: base, modelId: res.pick.model, upstreamModel: res.pick.upstream, ...(res.pick.crossModel ? { crossModel: true } : {}), ...(keyless(res.pick) ? { keyless: true } : {}), ...(alternates.length ? { alternates } : {}) },
    flags: { sameModel: res.pick.sameModel, crossModel: res.pick.crossModel, wanted: res.wanted },
  };
}
