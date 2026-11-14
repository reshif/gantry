/**
 * Model routing (spec 10.4). Pure: the same function answers GET /routing/resolve (the preview) and the edge's authorize step.
 *
 * Order of resolution: default, then project, then station, then class (each narrower layer replaces the one before).
 * Then the filter: the project's allowed vendors, regions and data-retention modes, the repo's residency rules, and "qualified" for a
 * custom vendor. Only after the filter is a fallback considered. Fallback is automatic only to the same model on another allowed vendor.
 * Fallback to a different model needs the factory switch and the project's opt-in, and the result is flagged.
 */
import type { ProjectRouting, Routing, RoutingRule } from "@gantry/domain";

export interface VendorFacts {
  id: string;
  name: string;
  connected: boolean;
  endpoint: string;
  product: string;
  region: string;
  /** zero, 30d or standard. */
  retention: string;
  custom: boolean;
  /** A key or token is stored for the vendor. */
  hasSecret: boolean;
  /** Stations qualified for this vendor (custom vendors only). */
  qualified: string[];
}

export interface ModelFacts {
  id: string;
  vendorId: string;
  enabled: boolean;
  /** Models with the same canonical id are the same model on different vendors. */
  canonical: string;
  /** The id the vendor's API expects. */
  upstream: string;
}

export interface ResolveInput {
  routing: Routing;
  vendors: VendorFacts[];
  models: ModelFacts[];
  station: string;
  woClass?: string | undefined;
  project?: string | undefined;
  /** Residency tags of the repo (its own tags, plus "regulated" for a regulated project). */
  repoTags?: string[] | undefined;
  /** An agent pins an exact model id: it replaces the routed choice but not the filter. */
  pinned?: string | null | undefined;
  /** Extra project restrictions that live in the project's own config. */
  projectAllowedVendors?: string[] | undefined;
  /** Project opt-in that lives in the project's own config. */
  projectCrossModel?: boolean | undefined;
}

export interface Pick {
  model: string;
  vendor: string;
  upstream: string;
  /** Same model on another vendor. */
  sameModel: boolean;
  /** A different model than the one resolved. */
  crossModel: boolean;
}

export interface Resolution {
  /** The model resolved before any filter or fallback. */
  wanted: string | null;
  layer: "default" | "project" | "station" | "class" | "pinned";
  pick: Pick | null;
  /** Ordered fallbacks the edge may try after a vendor error: same model on other vendors first, then (if allowed) other models. */
  alternates: Pick[];
  steps: string[];
  rule: RoutingRule | null;
  blocked: string | null;
  crossModelAllowed: boolean;
}

const lower = (s: string): string => s.toLowerCase();

export function canonicalOf(id: string, explicit?: unknown): string {
  if (typeof explicit === "string" && explicit) return explicit;
  return id.replace(/^(bedrock|azure|vertex|openai|anthropic|local)-/i, "");
}

const regionMatches = (vendorRegion: string, wanted: string): boolean => vendorRegion !== "" && lower(vendorRegion).includes(lower(wanted));

export function resolveModel(i: ResolveInput): Resolution {
  const r = i.routing;
  const pol: ProjectRouting = (i.project && r.projects?.[i.project]) || {};
  const steps: string[] = [];
  const vendorById = new Map(i.vendors.map((v) => [v.id, v]));
  const modelById = new Map(i.models.map((m) => [m.id, m]));
  const vname = (id: string): string => vendorById.get(id)?.name ?? id;

  // ---- 1. layers
  let wanted: string | null = r.defaultModel || null;
  let layer: Resolution["layer"] = "default";
  steps.push(`Factory default: ${wanted ?? "none"}`);
  if (pol.defaultModel) {
    wanted = pol.defaultModel;
    layer = "project";
    steps.push(`Project default for ${i.project}: ${wanted}`);
  }
  const st = pol.overrides?.[i.station] ?? r.overrides?.[i.station];
  if (st) {
    wanted = st;
    layer = "station";
    steps.push(`Station override for ${i.station}${pol.overrides?.[i.station] ? ` in ${i.project}` : ""}: ${wanted}`);
  }
  const cl = i.woClass ? (pol.classOverrides?.[i.woClass] ?? r.classOverrides?.[i.woClass]) : undefined;
  if (cl) {
    wanted = cl;
    layer = "class";
    steps.push(`Class override for ${i.woClass}${pol.classOverrides?.[i.woClass!] ? ` in ${i.project}` : ""}: ${wanted}`);
  }
  if (i.pinned) {
    if (wanted !== i.pinned) steps.push(`The agent pins ${i.pinned}, which replaces ${wanted ?? "nothing"}.`);
    wanted = i.pinned;
    layer = "pinned";
  }

  // ---- 2. filter
  const tags = i.repoTags ?? [];
  const rule = (r.rules ?? []).find((x) => tags.includes(x.tag)) ?? null;
  const allowedVendors = [pol.allowedVendors, i.projectAllowedVendors].filter((x): x is string[] => Array.isArray(x) && x.length > 0);
  const regions = pol.allowedRegions?.filter(Boolean) ?? [];
  const retention = pol.allowedRetention?.filter(Boolean) ?? [];
  const ruleVendors = rule ? [rule.use, ...(rule.alt ? [rule.alt] : [])] : null;

  const why = (m: ModelFacts): string | null => {
    const v = vendorById.get(m.vendorId);
    if (!v) return `${m.id} has no vendor`;
    if (!m.enabled) return `${m.id} is disabled`;
    if (!v.connected) return `${v.name} is not connected`;
    for (const set of allowedVendors) if (!set.includes(v.id)) return `${v.name} is not allowed for this project`;
    if (regions.length && !regions.some((x) => regionMatches(v.region, x))) return `${v.name} (${v.region || "no region"}) is outside the allowed regions ${regions.join(", ")}`;
    if (retention.length && !retention.includes(v.retention)) return `${v.name} keeps data in mode ${v.retention}, which this project does not allow`;
    if (ruleVendors) {
      if (!ruleVendors.includes(v.id)) return `${rule!.id} allows only ${ruleVendors.map(vname).join(" or ")}`;
      if (rule!.region && v.id === rule!.use && !regionMatches(v.region, rule!.region)) return `${rule!.id} requires region ${rule!.region}, ${v.name} is in ${v.region || "no region"}`;
    }
    if (v.custom && !v.qualified.includes(i.station)) return `${v.name} is not qualified for station ${i.station} (its suite has not passed on it)`;
    return null;
  };
  const toPick = (m: ModelFacts, sameModel: boolean, crossModel: boolean): Pick => ({ model: m.id, vendor: m.vendorId, upstream: m.upstream, sameModel, crossModel });

  const wantedModel = wanted ? modelById.get(wanted) : undefined;
  const crossAllowed = r.crossModelFallback === true && (pol.crossModelFallback === true || i.projectCrossModel === true);
  const out: Resolution = { wanted, layer, pick: null, alternates: [], steps, rule, blocked: null, crossModelAllowed: crossAllowed };
  if (rule) steps.push(`${rule.id}: repos tagged ${rule.tag} use ${ruleVendors!.map(vname).join(" or ")} only${rule.region ? ` (${rule.use} in ${rule.region})` : ""}.`);
  if (!wanted || !wantedModel) {
    out.blocked = wanted ? `Model ${wanted} is not registered.` : "Routing has no default model.";
    steps.push(out.blocked);
    return out;
  }

  // ---- 3. the same model: first on its own vendor, then on every other vendor that passes the filter
  const same = i.models.filter((m) => m.canonical === wantedModel.canonical).sort((a, b) => Number(b.id === wantedModel.id) - Number(a.id === wantedModel.id));
  const reasons: string[] = [];
  const sameOk: Pick[] = [];
  for (const m of same) {
    const w = why(m);
    if (w) reasons.push(w);
    else sameOk.push(toPick(m, m.id !== wantedModel.id, false));
  }
  // The candidates are ordered: the wanted model first, then the same model on other vendors.
  if (sameOk.length) {
    out.pick = sameOk[0]!;
    out.alternates = sameOk.slice(1);
    if (out.pick.model === wantedModel.id) steps.push(`${wanted} on ${vname(out.pick.vendor)} passes the filter.`);
    else steps.push(`${reasons[0] ?? `${wanted} is unavailable`}; the same model is served by ${vname(out.pick.vendor)} as ${out.pick.model}.`);
  } else if (reasons.length) steps.push(`${reasons.join("; ")}.`);

  // ---- 4. a different model, only with the factory switch and the project's opt-in
  const cross: Pick[] = [];
  if (crossAllowed) {
    for (const id of r.fallback ?? []) {
      const m = modelById.get(id);
      if (!m || m.canonical === wantedModel.canonical || cross.some((c) => c.model === id)) continue;
      if (!why(m)) cross.push(toPick(m, false, true));
    }
    out.alternates.push(...cross);
    if (!out.pick && cross.length) {
      out.pick = cross[0]!;
      out.alternates = out.alternates.filter((a) => a !== out.pick);
      steps.push(`No vendor serves ${wanted} here; cross-model fallback is on for this project: ${out.pick.model}. The run is flagged.`);
    }
  } else if (!out.pick) {
    steps.push("Cross-model fallback is off, so a different model is not tried.");
  }

  if (!out.pick) {
    const detail = reasons.length ? ` ${reasons.join("; ")}.` : "";
    out.blocked = rule ? `${rule.id}: no allowed vendor serves ${wanted}. Work on this repo blocks rather than leaving its residency.${detail}` : `No allowed vendor serves ${wanted} for this request.${detail}`;
  }
  if (out.blocked) steps.push(out.blocked);
  return out;
}
