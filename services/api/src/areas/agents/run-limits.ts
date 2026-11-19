/**
 * Run limits (turns, wall clock, cost per run): a safety rail people set, never something an agent proposes. Each field resolves on its own, first one set wins:
 * a one-off raise recorded on the attempt, the project's station override, the agent version's `limits`, then the default (cost: the agent's per-run budget).
 */
import type { Queryable } from "@gantry/db";
import type { RunLimits } from "@gantry/domain";

export const RUN_LIMIT_DEFAULTS = { turns: 40, wallClockSeconds: 3600 } as const;
/** Ranges a person may save. Cost goes up to the same ceiling as an agent's own budget (100000), the largest per-run amount the platform accepts anywhere. */
export const RUN_LIMIT_RANGES = { turns: { min: 1, max: 500 }, wallClockSeconds: { min: 60, max: 14400 }, costUsd: { min: 0.01, max: 100000 } } as const;

export type LimitField = "turns" | "wallClockSeconds" | "costUsd";
export type LimitSource = "oneOff" | "station" | "agent" | "default";
export interface ResolvedLimits {
  turns: number;
  wallClockSeconds: number;
  costUsd?: number;
  source: { turns: LimitSource; wallClockSeconds: LimitSource; costUsd?: LimitSource | "agentBudget" };
}

const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const usd = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** What a stored limits object holds that is usable (a seeded or older row may hold anything). */
export function readRunLimits(v: unknown): RunLimits {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const turns = int(o.turns), wallClockSeconds = int(o.wallClockSeconds), costUsd = usd(o.costUsd);
  return { ...(turns ? { turns } : {}), ...(wallClockSeconds ? { wallClockSeconds } : {}), ...(costUsd ? { costUsd } : {}) };
}

export interface LimitLayers {
  oneOff?: unknown;
  station?: unknown;
  agent?: unknown;
  /** The agent's own per-run budget: the cost limit when no layer sets one. */
  agentBudget?: unknown;
}

export function resolveRunLimits(l: LimitLayers): ResolvedLimits {
  const layers: Array<[LimitSource, RunLimits]> = [["oneOff", readRunLimits(l.oneOff)], ["station", readRunLimits(l.station)], ["agent", readRunLimits(l.agent)]];
  const pick = (k: LimitField): { v: number; src: LimitSource } | null => {
    for (const [src, r] of layers) if (r[k] !== undefined) return { v: r[k] as number, src };
    return null;
  };
  const t = pick("turns"), w = pick("wallClockSeconds"), c = pick("costUsd");
  const cost = c?.v ?? usd(l.agentBudget);
  return {
    turns: t?.v ?? RUN_LIMIT_DEFAULTS.turns,
    wallClockSeconds: w?.v ?? RUN_LIMIT_DEFAULTS.wallClockSeconds,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    source: { turns: t?.src ?? "default", wallClockSeconds: w?.src ?? "default", ...(cost !== undefined ? { costUsd: c?.src ?? "agentBudget" } : {}) },
  };
}

/** The message for a value outside its range, fit to show a person. */
export function limitRangeText(k: LimitField): string {
  const r = RUN_LIMIT_RANGES[k];
  return k === "turns" ? `Max turns must be a whole number from ${r.min} to ${r.max}.`
    : k === "wallClockSeconds" ? `Max time must be from ${r.min / 60} to ${r.max / 60} minutes.`
    : `Max cost per run must be from $${r.min} to $${r.max}.`;
}

/** Whether one field is in range (cost may have cents). */
export function limitInRange(k: LimitField, x: unknown): x is number {
  const r = RUN_LIMIT_RANGES[k];
  return typeof x === "number" && Number.isFinite(x) && x >= r.min && x <= r.max && (k === "costUsd" || Number.isInteger(x));
}

/** The station override of a project's current flow, as stored. */
export async function stationRunLimits(db: Queryable, orgId: string, projectId: string, station: string): Promise<RunLimits> {
  const r = (await db.query<{ doc: { stations?: Record<string, { runLimits?: unknown }> } | null }>(
    `select f.doc from flow_versions f join projects p on p.org_id = f.org_id and p.id = f.project_id and p.current_flow_version = f.version where f.org_id = $1 and f.project_id = $2`, [orgId, projectId],
  )).rows[0];
  return readRunLimits(r?.doc?.stations?.[station]?.runLimits);
}

/** What the run is bound by now: the attempt's one-off raise, the station override of the project, the pinned agent version (a draft only when the run has no version), the defaults. */
export async function loadRunLimits(db: Queryable, c: { orgId: string; projectId: string; station: string; attemptData: Record<string, unknown> }, agent: { body: Record<string, unknown>; data: Record<string, unknown>; budgetUsd?: unknown }): Promise<ResolvedLimits> {
  const draft = Object.keys(agent.body).length ? {} : agent.data;
  const oneOff = (c.attemptData.limitRaise as { limits?: unknown } | undefined)?.limits;
  return resolveRunLimits({ oneOff, station: await stationRunLimits(db, c.orgId, c.projectId, c.station), agent: agent.body.limits ?? draft.limits, agentBudget: agent.budgetUsd });
}

/** The limits written on the run when it was dispatched (runs.data.limits), or null for a run that has none. A run is bound by these for its whole life: a later edit of the station or the agent changes the next run, never this one. */
export function frozenRunLimits(runData: Record<string, unknown>): { turns: number; wallClockSeconds: number; costUsd?: number } | null {
  const l = runData.limits as Record<string, unknown> | undefined;
  const turns = int(l?.turns), wallClockSeconds = int(l?.wallClockSeconds), costUsd = usd(l?.costUsd);
  return turns && wallClockSeconds ? { turns, wallClockSeconds, ...(costUsd ? { costUsd } : {}) } : null;
}

/** What the spec and the meter read: the run's frozen limits, else (a run dispatched before they were recorded) the live resolution. */
export async function runLimitsOf(db: Queryable, c: { orgId: string; projectId: string; station: string; attemptData: Record<string, unknown>; runData: Record<string, unknown> }, agent: { body: Record<string, unknown>; data: Record<string, unknown>; budgetUsd?: unknown }): Promise<{ turns: number; wallClockSeconds: number; costUsd?: number }> {
  return frozenRunLimits(c.runData) ?? (await loadRunLimits(db, c, agent));
}
