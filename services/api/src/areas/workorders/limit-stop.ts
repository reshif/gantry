/**
 * A run that stopped on one of its limits (turns, wall clock) says which limit and the numbers, so a person can raise it knowingly. The runner reports
 * `max_turns` ("turn limit N reached") and `wall_clock` ("wall-clock limit Ns reached"); the worker's watchdog reports `wall_clock_exceeded`. The limits the run was bound
 * by are on the run (runs.data.limits, written at dispatch); the number in the runner's own message is the fallback for a run dispatched before that.
 * A run that reaches its cost limit is stopped by the budget halt (stops, cause budget), whose reason says the same in words (see internal/runs.ts).
 */
import type { Queryable } from "@gantry/db";

export interface LimitStop {
  limit: "turns" | "time" | "cost";
  used: number;
  max: number;
  unit: "turns" | "seconds" | "usd";
  text: string;
  station: string;
  attempt: string;
}

const minutes = (s: number): string => `${Math.round((s / 60) * 10) / 10}`;

export function limitStopText(limit: LimitStop["limit"], used: number, max: number): string {
  if (limit === "turns") return `Stopped at the turn limit: used ${used} of ${max} turns.`;
  if (limit === "time") return `Stopped at the time limit: used ${minutes(used)} of ${minutes(max)} minutes.`;
  return `Stopped at the cost limit: used $${used.toFixed(2)} of $${max.toFixed(2)} for this run.`;
}

export async function limitStopOf(db: Queryable, orgId: string, attemptId: string, station: string, error: { code: string; msg: string } | undefined): Promise<LimitStop | null> {
  if (!error) return null;
  const kind = error.code === "max_turns" ? "turns" : error.code === "wall_clock" || error.code === "wall_clock_exceeded" ? "time" : null;
  if (!kind) return null;
  const run = (await db.query<{ limits: { turns?: number; wallClockSeconds?: number } | null }>(`select data->'limits' as limits from runs where org_id = $1 and attempt_id = $2 order by started_at desc nulls last limit 1`, [orgId, attemptId])).rows[0];
  const fromMsg = Number(/(\d+)/.exec(error.msg)?.[1] ?? NaN);
  const max = (kind === "turns" ? run?.limits?.turns : run?.limits?.wallClockSeconds) ?? (Number.isFinite(fromMsg) ? fromMsg : 0);
  if (!max) return null;
  // The harness stops the moment it reaches the limit, so the run used all of it.
  return { limit: kind, used: max, max, unit: kind === "turns" ? "turns" : "seconds", text: limitStopText(kind, max, max), station, attempt: attemptId };
}
