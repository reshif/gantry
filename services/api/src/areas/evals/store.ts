/** Suites and runs to the legacy `G.store.suites` and `G.store.evalRuns` shapes, with the counts and ranges spec 13.2 asks for. */
import type { Queryable } from "@gantry/db";
import type { EvalCase, EvalResult, EvalRun, Suite } from "@gantry/domain";
import { wilson, type CheckResult, type CheckSpec } from "./checks.js";
import type { RunData } from "./engine.js";

const ms = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : 0);
const num = (v: unknown, d = 0.85): number => (v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);

export interface CaseOut extends EvalCase {
  by?: string;
  added?: number;
  task: string;
  repo: string | null;
  commit: string | null;
  golden: boolean;
  /** In the person's words. */
  checks: string;
  rules: CheckSpec[];
  skill?: string;
  cls?: string;
}
export interface SuiteOut extends Omit<Suite, "cases"> {
  cases: CaseOut[];
  /** A run of this suite is queued or running. */
  running: string | null;
  version: number;
}

export const caseOut = (r: { id: string; name: string; body: Record<string, unknown>; golden: boolean; created_at: Date }): CaseOut => {
  const b = r.body;
  return {
    id: r.id, name: r.name, ...(typeof b.by === "string" ? { by: b.by } : {}), added: typeof b.added === "number" ? b.added : ms(r.created_at),
    task: typeof b.task === "string" && b.task ? b.task : r.name, repo: typeof b.repo === "string" ? b.repo : null, commit: typeof b.commit === "string" ? b.commit : null, golden: r.golden,
    checks: typeof b.checks === "string" ? b.checks : "", rules: Array.isArray(b.rules) ? (b.rules as CheckSpec[]) : [], ...(typeof b.skill === "string" ? { skill: b.skill } : {}), ...(typeof b.cls === "string" ? { cls: b.cls } : {}),
  };
};

export async function readSuites(db: Queryable, orgId: string): Promise<SuiteOut[]> {
  const [suites, cases, running] = await Promise.all([
    db.query<{ id: string; name: string; station: string | null; agent_id: string | null; data: Record<string, unknown>; version: number }>(`select id, name, station, agent_id, data, version from suites where org_id = $1 order by created_at, id`, [orgId]),
    db.query<{ id: string; suite_id: string; name: string; body: Record<string, unknown>; golden: boolean; created_at: Date }>(`select id, suite_id, name, body, golden, created_at from eval_cases where org_id = $1 order by created_at, id`, [orgId]),
    db.query<{ suite_id: string; id: string }>(`select suite_id, id from eval_runs where org_id = $1 and status in ('queued','running')`, [orgId]),
  ]);
  return suites.rows.map((s) => ({
    id: s.id, name: s.name, station: s.station ?? "", threshold: num(s.data.threshold), agent: s.agent_id ?? "", version: s.version, ...(s.data.builtin === true ? { builtin: true } : {}),
    cases: cases.rows.filter((c) => c.suite_id === s.id).map(caseOut), running: running.rows.find((r) => r.suite_id === s.id)?.id ?? null,
  }));
}

export interface RunOut extends EvalRun {
  status: string;
  /** Tasks that were graded, how many passed, and the 95% range of the pass share. */
  count: number;
  passed: number;
  range: [number, number];
  repeats: number;
  /** Items finished and total, while a run is going. */
  done: number;
  total: number;
  finishedAt: number | null;
  override: boolean;
  vendor: string | null;
  seeded: boolean;
}

/** The runs of one suite, oldest first; with no suite, the most recent runs of every suite (one request for the whole Evals screen). */
export async function readRuns(db: Queryable, orgId: string, suiteId: string | null, runId?: string): Promise<RunOut[]> {
  const args: unknown[] = [orgId];
  const where = ["org_id = $1"];
  if (suiteId) where.push(`suite_id = $${args.push(suiteId)}`);
  if (runId) where.push(`id = $${args.push(runId)}`);
  const runs = (await db.query<{ id: string; suite_id: string; status: string; score: string | null; started_by: string | null; started_at: Date; finished_at: Date | null; data: RunData }>(
    `select * from (select id, suite_id, status, score::text, started_by, started_at, finished_at, data from eval_runs where ${where.join(" and ")} order by started_at desc, id desc limit ${suiteId ? 500 : 400}) r order by started_at, id`, args,
  )).rows;
  if (!runs.length) return [];
  const ids = runs.map((r) => r.id);
  const [res, cost] = await Promise.all([
    db.query<{ run_id: string; case_id: string; passed: boolean; score: string | null; detail: Record<string, unknown> }>(`select run_id, case_id, passed, score::text, detail from eval_results where org_id = $1 and run_id = any($2::text[]) order by created_at, case_id`, [orgId, ids]),
    db.query<{ run: string; cost: string }>(`select w.data->'eval'->>'run' as run, coalesce(sum(ru.cost_micros), 0)::text as cost from run_usage ru join work_orders w on w.org_id = ru.org_id and w.id = ru.wo_id where ru.org_id = $1 and w.source = 'eval' and w.data->'eval'->>'run' = any($2::text[]) group by 1`, [orgId, ids]),
  ]);
  const costBy = new Map(cost.rows.map((c) => [c.run, Number(c.cost) / 1e6]));
  return runs.map((r) => {
    const d = r.data;
    const mine = res.rows.filter((x) => x.run_id === r.id);
    const order = d.items ? [...new Set(d.items.map((i) => i.case))] : [];
    mine.sort((a, b) => (order.indexOf(a.case_id) < 0 ? 999 : order.indexOf(a.case_id)) - (order.indexOf(b.case_id) < 0 ? 999 : order.indexOf(b.case_id)));
    const results: EvalResult[] = mine.map((x) => {
      const det = x.detail as { reason?: string; ms?: number; repeats?: number; passes?: number; graded?: number; checks?: CheckResult[]; errors?: string[] };
      return { caseId: x.case_id, pass: x.passed, reason: det.reason ?? "", ms: det.ms ?? 0, ...(det.repeats && det.repeats > 1 ? { repeats: det.repeats, passes: det.passes ?? 0 } : {}), ...(det.checks?.some((c) => c.advisory) ? { advisory: det.checks.filter((c) => c.advisory) } : {}), ...(det.errors?.length ? { errors: det.errors } : {}) } as EvalResult;
    });
    const graded = mine.filter((x) => ((x.detail as { graded?: number }).graded ?? 1) > 0).length;
    const passed = mine.filter((x) => x.passed).length;
    const total = d.items?.length ?? 0;
    const done = d.items?.filter((i) => i.state === "done" || i.state === "cancelled").length ?? total;
    return {
      id: r.id, suite: r.suite_id, agent: d.agent, version: d.version, model: d.model, at: ms(r.started_at), score: r.score === null ? 0 : Number(r.score), results, by: r.started_by ?? "", cost: costBy.get(r.id) ?? 0,
      status: r.status, count: graded, passed, range: wilson(passed, graded), repeats: d.repeats ?? 1, done, total, finishedAt: r.finished_at ? ms(r.finished_at) : null, override: d.override === true, vendor: d.vendor ?? null, seeded: d.seeded === true,
    };
  });
}
