import type { Queryable } from "@gantry/db";
import { ONBOARD_AGENT, ONBOARD_STATION } from "@gantry/domain";
import { readSecurity } from "../../core/read/index.js";
import { loadFacts } from "../models/facts.js";
import { resolveModel, type Pick } from "../models/resolve.js";
import type { ModelRoute } from "../internal/route.js";
import type { ServiceRoute } from "../console/route.js";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** The model the Onboarding Agent's live version pins (its own `model_id` or the model in its body), or null. */
export async function onboardingPinnedModel(db: Queryable, orgId: string): Promise<string | null> {
  const ag = (await db.query<{ live_version: number | null }>(`select live_version from agents where org_id = $1 and id = $2`, [orgId, ONBOARD_AGENT])).rows[0];
  if (!ag || ag.live_version === null) return null;
  const v = (await db.query<{ body: Record<string, unknown>; model_id: string | null }>(`select body, model_id from agent_versions where org_id = $1 and agent_id = $2 and version = $3`, [orgId, ONBOARD_AGENT, ag.live_version])).rows[0];
  return v?.model_id || (typeof v?.body.model === "string" ? v.body.model : null) || null;
}

/**
 * The route for the onboarding session's model calls: the Onboarding Agent's pinned model resolved at the `onboarding` station through the same resolver a run uses
 * (connected vendor, enabled model, filters). It is deliberately not the console's default model.
 */
export async function resolveOnboardingRoute(db: Queryable, orgId: string): Promise<ServiceRoute> {
  const pinned = await onboardingPinnedModel(db, orgId);
  if (!pinned) return { ok: false, reason: "The Onboarding Agent pins no model." };
  const facts = await loadFacts(db, orgId);
  const res = resolveModel({ ...facts, station: ONBOARD_STATION, pinned });
  if (!res.pick) return { ok: false, reason: res.blocked ?? `No connected vendor serves ${pinned}.` };
  const v = new Map(facts.vendors.map((x) => [x.id, x])).get(res.pick.vendor)!;
  const lan = (await readSecurity(db, orgId)).value.vendorLanRanges ?? [];
  const base = (v.endpoint || (/anthropic|claude/i.test(`${v.id} ${v.product}`) ? ANTHROPIC_BASE_URL : "")).replace(/\/+$/, "");
  if (!base) return { ok: false, reason: `Vendor ${v.name} has no endpoint.` };
  const keyless = (p: Pick): boolean => !v.hasSecret && v.endpoint !== "" && (v.custom || p.vendor === "local");
  const route: ModelRoute = { vendor: res.pick.vendor, baseUrl: base, modelId: res.pick.model, upstreamModel: res.pick.upstream, ...(keyless(res.pick) ? { keyless: true } : {}), ...(lan.length ? { lan } : {}) };
  return { ok: true, route };
}
