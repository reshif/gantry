import { planOf } from "../workorders/research.js";
import type { Queryable } from "@gantry/db";
import type { RunCtx } from "./context.js";

import { costMicros, priceBookAt, type Price, type PriceBook, type Usage } from "../models/prices.js";

export { costMicros, type Price, type PriceBook, type Usage };

/** The price version in force now: the published version with the latest effective date not after this moment (spec 10.4 Prices). */
export const currentPrices = (db: Queryable, orgId: string): Promise<PriceBook> => priceBookAt(db, orgId);

export interface Limits {
  /** Monthly project cap in micro-dollars; null = none configured (a limit of 0 means "not set"). */
  projectMicros: number | null;
  woMicros: number | null;
  runMicros: number | null;
}

export interface Breach {
  scope: "project" | "wo" | "run" | "plan";
  spentMicros: number;
  limitMicros: number;
}

const toMicros = (usd: unknown): number | null => {
  const n = typeof usd === "string" ? Number(usd) : usd;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null;
};

/** Spec 10.4 Budget: project monthly budget, work-order cap (the work order's own data.budgetUsd, else the project's budgets.wo_limit_micros, else config extra.woBudgetUsd), per-run cap (agent budget). */
export async function loadLimits(db: Queryable, c: RunCtx): Promise<Limits> {
  const b = await db.query<{ m: string; w: string }>(`select monthly_limit_micros::text as m, wo_limit_micros::text as w from budgets where org_id = $1 and project_id = $2`, [c.orgId, c.projectId]);
  const projectMicros = b.rows[0] && Number(b.rows[0].m) > 0 ? Number(b.rows[0].m) : null;
  const projectWoMicros = b.rows[0] && Number(b.rows[0].w) > 0 ? Number(b.rows[0].w) : null;
  const extra = (c.projectConfig.extra ?? {}) as Record<string, unknown>;
  const woMicros = toMicros(c.woData.budgetUsd) ?? projectWoMicros ?? toMicros(extra.woBudgetUsd);
  const runMicros = toMicros((await agentConfig(db, c)).budgetUsd);
  return { projectMicros, woMicros, runMicros };
}

export interface Spent {
  project: number;
  wo: number;
  run: number;
}

export async function loadSpent(db: Queryable, c: RunCtx): Promise<Spent> {
  const { rows } = await db.query<{ project: string; wo: string; run: string }>(
    `select (select coalesce(sum(cost_micros),0) from usage_meter where org_id = $1 and project_id = $2 and at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')::text as project,
            (select coalesce(sum(cost_micros),0) from run_usage where org_id = $1 and wo_id = $3)::text as wo,
            (select coalesce(sum(cost_micros),0) from run_usage where org_id = $1 and run_id = $4)::text as run`,
    [c.orgId, c.projectId, c.woId, c.runId],
  );
  const r = rows[0]!;
  return { project: Number(r.project), wo: Number(r.wo), run: Number(r.run) };
}

/** The first exhausted budget, or null. Spent at or above the limit counts as exhausted. */
export async function budgetBreach(db: Queryable, c: RunCtx): Promise<Breach | null> {
  const [lim, spent] = await Promise.all([loadLimits(db, c), loadSpent(db, c)]);
  if (lim.projectMicros !== null && spent.project >= lim.projectMicros) return { scope: "project", spentMicros: spent.project, limitMicros: lim.projectMicros };
  if (lim.woMicros !== null && spent.wo >= lim.woMicros) return { scope: "wo", spentMicros: spent.wo, limitMicros: lim.woMicros };
  if (lim.runMicros !== null && spent.run >= lim.runMicros) return { scope: "run", spentMicros: spent.run, limitMicros: lim.runMicros };
  // An approved research plan's budget covers its station's runs from the approval on (Phase 2): the gateway refuses the next model call past it.
  const plan = planOf(c.woData);
  if (plan?.status === "approved" && plan.budgetUsd && plan.station === c.station && plan.decidedAt) {
    const limit = Math.round(plan.budgetUsd * 1e6);
    const used = Number((await db.query<{ n: string }>(`select coalesce(sum(u.cost_micros),0)::text as n from run_usage u join attempts a on a.org_id = u.org_id and a.id = u.attempt_id where u.org_id = $1 and u.wo_id = $2 and a.station = $3 and u.at >= $4`, [c.orgId, c.woId, c.station, new Date(plan.decidedAt)])).rows[0]!.n);
    if (used >= limit) return { scope: "plan", spentMicros: used, limitMicros: limit };
  }
  return null;
}

export interface AgentConfig {
  instructions: string;
  budgetUsd: unknown;
  body: Record<string, unknown>;
  data: Record<string, unknown>;
}

/** The pinned agent version's body (prompt, tools, limits) and the agent's own data. Empty when the attempt has no tuple. */
export async function agentConfig(db: Queryable, c: RunCtx): Promise<AgentConfig> {
  if (!c.agentId) return { instructions: "", budgetUsd: undefined, body: {}, data: {} };
  const { rows } = await db.query<{ body: Record<string, unknown> | null; data: Record<string, unknown> | null }>(
    `select v.body, a.data from agents a left join agent_versions v on v.org_id = a.org_id and v.agent_id = a.id and v.version = $3 where a.org_id = $1 and a.id = $2`,
    [c.orgId, c.agentId, c.agentVersion],
  );
  const body = rows[0]?.body ?? {};
  const data = rows[0]?.data ?? {};
  return { instructions: typeof body.instructions === "string" ? body.instructions : "", budgetUsd: body.budget ?? data.budget, body, data };
}
