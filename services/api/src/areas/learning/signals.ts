/**
 * Learning signals from real records (spec 13.4): gate rejections with their reasons, send-backs, post-release outcomes, classification overrides,
 * intake misses (all read from the work order records through the domain's `learningSignals`) and eval regressions (a suite whose score fell between two completed runs).
 */
import type { Queryable } from "@gantry/db";
import { learningSignals, type LearningSignal } from "@gantry/domain";
import { loadFlowState } from "../../core/read/state.js";
import { buildWorkOrders } from "../workorders/model.js";
import { REGRESSION_DROP } from "./config.js";

export interface Signal {
  signal: LearningSignal;
  /** The work order record this came from; empty for an eval regression (its run is in `ref`). */
  wo: string;
  project: string | null;
  agent: string | null;
  gate?: string;
  text: string;
  at: number;
  /** The record this signal points to when it is not a work order (an eval run). */
  ref?: string;
}

const ms = (d: Date | string | null): number => (d ? new Date(d).getTime() : 0);
const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;

/** A suite's score fell by at least REGRESSION_DROP from the run before it (comparing runs of the same suite, in order). */
export async function evalRegressions(db: Queryable, orgId: string): Promise<Signal[]> {
  const { rows } = await db.query<{ id: string; suite_id: string; suite: string; score: string; finished_at: Date | null; created_at: Date; version: string | null; agent: string | null }>(
    `select r.id, r.suite_id, s.name as suite, r.score, r.finished_at, r.created_at, r.data->>'version' as version,
            (select a.id from agents a where a.org_id = r.org_id and a.data->>'suite' = r.suite_id order by a.id limit 1) as agent
       from eval_runs r join suites s on s.org_id = r.org_id and s.id = r.suite_id
      where r.org_id = $1 and r.status = 'completed' and r.score is not null order by r.suite_id, coalesce(r.finished_at, r.created_at), r.id`,
    [orgId],
  );
  const out: Signal[] = [];
  let prev: (typeof rows)[number] | null = null;
  for (const r of rows) {
    if (prev && prev.suite_id === r.suite_id && Number(prev.score) - Number(r.score) >= REGRESSION_DROP) {
      out.push({
        signal: "regression", wo: "", project: null, agent: r.agent, ref: r.id, at: ms(r.finished_at ?? r.created_at),
        text: `${r.suite} fell from ${pct(Number(prev.score))} to ${pct(Number(r.score))}${r.version ? ` on ${r.version}` : ""} (${r.id})`,
      });
    }
    prev = r;
  }
  return out;
}

/** Every signal there is, newest first. `projects` limits work-order signals to those projects (null: all). Regressions are factory-wide. */
export async function collectSignals(db: Queryable, orgId: string, o: { projects?: readonly string[] | null } = {}): Promise<Signal[]> {
  const base = await loadFlowState(db, orgId);
  const wanted = o.projects ? base.projects.filter((p) => o.projects!.includes(p.id)) : base.projects;
  const wos = (await Promise.all(wanted.map((p) => buildWorkOrders(db, orgId, base.catalog, base.projects, { project: p.id })))).flat();
  const raw = learningSignals({ workOrders: wos, catalog: base.catalog });
  const wo: Signal[] = raw.map((x) => ({ signal: x.signal, wo: x.wo, project: x.project, agent: x.agent ?? null, ...(x.gate ? { gate: x.gate } : {}), text: x.text, at: x.at }));
  const regress = await evalRegressions(db, orgId);
  return [...wo, ...regress].sort((a, b) => b.at - a.at);
}

/** How many signals match a declared metric inside [from, to]. */
export function countMetric(signals: readonly Signal[], m: { signal: string; project: string | null; agent: string | null }, from: number, to: number): number {
  return signals.filter((s) => s.signal === m.signal && (!m.project || s.project === m.project) && (!m.agent || s.agent === m.agent) && s.at >= from && s.at <= to).length;
}
