/**
 * Where a work order stands against the budgets that can halt it (spec 10.4 Budget), read from the database inside a command. The meter (areas/internal/metering.ts) decides at
 * run time with a run's context; the commands that raise a cap or resume a budget halt have no run, so they ask here. Same sources: the project's monthly budget against the
 * month's metered spend, and the work order's cap (its own, else the project's per-work-order cap, else config) against its run usage.
 */
import type { Queryable } from "@gantry/db";

export type BudgetCap = "project" | "wo" | "run" | "plan";
export interface Over { cap: "project" | "wo"; spentMicros: number; limitMicros: number }

const toMicros = (usd: unknown): number | null => {
  const n = typeof usd === "string" ? Number(usd) : usd;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null;
};

export const usd = (micros: number): string => `$${(micros / 1e6).toFixed(2)}`;

/** Which cap a budget halt's reason names (the meter writes "Budget reached: the <work order|run|approved research plan|project> has spent ..."). */
export function capOfReason(reason: string): BudgetCap | null {
  const m = /^Budget reached: the (work order|run|approved research plan|project) /.exec(reason);
  if (!m) return null;
  return m[1] === "work order" ? "wo" : m[1] === "run" ? "run" : m[1] === "project" ? "project" : "plan";
}

export const CAP_NAME: Record<BudgetCap, string> = { project: "the project's monthly budget", wo: "the work order's cap", run: "the agent's per-run budget", plan: "the approved research plan's budget" };

/** Every project or work-order cap the work order is at or over right now (project first, as the meter reports it). */
export async function overBudget(db: Queryable, orgId: string, woId: string): Promise<Over[]> {
  const w = (await db.query<{ project_id: string; budget: unknown }>(`select project_id, data->'budgetUsd' as budget from work_orders where org_id = $1 and id = $2`, [orgId, woId])).rows[0];
  if (!w) return [];
  const b = (await db.query<{ m: string; w: string }>(`select monthly_limit_micros::text as m, wo_limit_micros::text as w from budgets where org_id = $1 and project_id = $2`, [orgId, w.project_id])).rows[0];
  const cfg = (await db.query<{ extra: Record<string, unknown> | null }>(`select config->'extra' as extra from projects where org_id = $1 and id = $2`, [orgId, w.project_id])).rows[0];
  const projectLimit = b && Number(b.m) > 0 ? Number(b.m) : null;
  const woLimit = toMicros(w.budget) ?? (b && Number(b.w) > 0 ? Number(b.w) : null) ?? toMicros(cfg?.extra?.woBudgetUsd);
  const spent = (await db.query<{ project: string; wo: string }>(
    `select (select coalesce(sum(cost_micros),0) from usage_meter where org_id = $1 and project_id = $2 and at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')::text as project,
            (select coalesce(sum(cost_micros),0) from run_usage where org_id = $1 and wo_id = $3)::text as wo`, [orgId, w.project_id, woId],
  )).rows[0]!;
  const out: Over[] = [];
  if (projectLimit !== null && Number(spent.project) >= projectLimit) out.push({ cap: "project", spentMicros: Number(spent.project), limitMicros: projectLimit });
  if (woLimit !== null && Number(spent.wo) >= woLimit) out.push({ cap: "wo", spentMicros: Number(spent.wo), limitMicros: woLimit });
  return out;
}

export const overText = (o: Over): string => `${CAP_NAME[o.cap]} (${usd(o.spentMicros)} spent of ${usd(o.limitMicros)})`;
