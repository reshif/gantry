/**
 * Running an eval suite through the same runtime as production (spec 13.2).
 *
 * Each case (repeated `repeats` times) becomes one attempt on a carrier work order: a row with source 'eval', never shown on the floor, in a list or in any count.
 * The worker's ordinary `attempt.dispatch` starts it in a sandbox through the launcher and the edge, exactly as for real work. Three differences, all on purpose:
 *  - the workspace is seeded read-only at the case's pinned commit and its result is never published, so no real repository is written;
 *  - the run executes the agent version the person picked (and the model they picked), not necessarily the live one;
 *  - the suite has its own concurrency cap, and its jobs run at a lower priority than work orders.
 * The result is graded by deterministic checks only (`checks.ts`); the attempt then ends and the next case starts.
 */
import { randomBytes } from "node:crypto";
import { appendEvent, type Queryable, type Tx } from "@gantry/db";
import { job, type BuiltJob } from "../../core/jobs-contract.js";
import { grade, wilson, type CheckResult, type CheckSpec } from "./checks.js";

export const DEFAULT_CAP = 2;
/** Eval jobs run behind every work-order job. */
export const EVAL_PRIORITY = -10;

export type ItemState = "pending" | "running" | "done" | "cancelled";
export interface EvalItem {
  case: string;
  n: number;
  state: ItemState;
  pass?: boolean;
  reason?: string;
  ms?: number;
  attempt?: string;
  wo?: string;
  checks?: CheckResult[];
  /** The run ended without a graded result: it never reported, the sandbox was lost, a stop covered it. Not a pass and not a fail of the agent. */
  error?: string;
}
export interface CaseSnapshot {
  name: string;
  task: string;
  repo: string | null;
  commit: string | null;
  project: string;
  cls: string;
  checks: CheckSpec[];
}
export interface RunData {
  agent: string;
  version: string;
  versionNumber: number;
  model: string;
  vendor: string | null;
  /** The model is not the one the version pins: the score says how that model does, and does not qualify the version. */
  override: boolean;
  repeats: number;
  station: string;
  cap: number;
  items: EvalItem[];
  cases: Record<string, CaseSnapshot>;
  /** Set for the dev seed's history only. */
  seeded?: boolean;
}

interface RunRow { id: string; suite_id: string; status: string; score: string | null; started_by: string | null; started_at: Date; finished_at: Date | null; data: RunData }

export async function evalCap(db: Queryable, orgId: string): Promise<number> {
  const r = (await db.query<{ n: string | null }>(`select settings->'evals'->>'maxConcurrent' as n from orgs where id = $1`, [orgId])).rows[0];
  const n = Number(r?.n);
  return Number.isInteger(n) && n >= 1 && n <= 32 ? n : DEFAULT_CAP;
}

const lockRun = async (tx: Tx, orgId: string, runId: string): Promise<RunRow | undefined> =>
  (await tx.query<RunRow>(`select id, suite_id, status, score::text, started_by, started_at, finished_at, data from eval_runs where org_id = $1 and id = $2 for update`, [orgId, runId])).rows[0];

const saveRun = (tx: Tx, orgId: string, id: string, data: RunData, set: { status?: string; score?: number | null; finished?: boolean } = {}): Promise<unknown> =>
  tx.query(
    `update eval_runs set data = $3::jsonb, status = coalesce($4, status), score = case when $5::boolean then $6::numeric else score end, finished_at = case when $7::boolean then now() else finished_at end, updated_at = now() where org_id = $1 and id = $2`,
    [orgId, id, JSON.stringify(data), set.status ?? null, set.score !== undefined, set.score ?? null, set.finished === true],
  );

/** How many eval attempts are live in the organisation, across every run: the cap is per organisation, not per run. */
async function liveAttempts(tx: Queryable, orgId: string): Promise<number> {
  return Number((await tx.query<{ n: string }>(`select count(*)::text as n from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id where a.org_id = $1 and w.source = 'eval' and a.state in ('queued','running')`, [orgId])).rows[0]!.n);
}

const runNumber = (id: string): string => id.replace(/\D+/g, "") || id;

/** Creates the carrier work order and the queued attempt for one item, and enqueues its dispatch behind every work-order job. */
async function startItem(tx: Tx, orgId: string, run: RunRow, d: RunData, it: EvalItem, now: Date): Promise<BuiltJob> {
  const snap = d.cases[it.case]!;
  const woId = `EV-${runNumber(run.id)}-${it.case}-${it.n}`;
  const attemptId = `ATT-${woId}-${d.station}-1`;
  const fv = (await tx.query<{ v: number | null }>(`select current_flow_version as v from projects where org_id = $1 and id = $2`, [orgId, snap.project])).rows[0]?.v ?? 1;
  await tx.query(
    `insert into work_orders (org_id, id, project_id, repo_id, title, class, priority, source, position, state, flow_version, data, closed_at)
     values ($1,$2,$3,$4,$5,$6,'P3','eval',$7,'done',$8,$9::jsonb,$10) on conflict (org_id, id) do nothing`,
    [orgId, woId, snap.project, snap.repo, `Eval ${it.case}: ${snap.name}`.slice(0, 200), snap.cls, d.station, fv, JSON.stringify({ eval: { run: run.id, suite: run.suite_id, case: it.case, n: it.n, commit: snap.commit } }), now],
  );
  const { rows } = await tx.query<{ fencing: string }>(
    `insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,$4,1,'queued',$5::jsonb) on conflict (org_id, id) do update set updated_at = now() returning fencing`,
    [orgId, attemptId, woId, d.station, JSON.stringify({
      agent: d.agent, agentVersion: d.versionNumber, ...(d.model ? { model: d.model } : {}), eval: { run: run.id, case: it.case, n: it.n },
      // What the agent is given: the task, never the checks or any rubric.
      input: { title: snap.name, goal: snap.task, task: snap.task, class: snap.cls, ...(snap.repo ? { repo: snap.repo, commit: snap.commit } : {}), eval: true },
    })],
  );
  it.state = "running";
  it.attempt = attemptId;
  it.wo = woId;
  return job("attempt.dispatch", { woId, station: d.station, attemptId, fencing: Number(rows[0]!.fencing) }, { dedupeKey: `attempt:${attemptId}`, priority: EVAL_PRIORITY });
}

export const progressJob = (runId: string, tag = ""): BuiltJob => job("eval.dispatch", { runId }, { dedupeKey: `eval.dispatch:${runId}${tag}`, priority: EVAL_PRIORITY });

/**
 * Starts as many pending items as the cap allows, and finishes the run when nothing is pending or running. Safe to call any number of times.
 * Returns the jobs to enqueue (the caller's transaction does it, so the attempts and their jobs commit together).
 */
export async function progressEval(tx: Tx, orgId: string, runId: string, now: Date): Promise<{ jobs: BuiltJob[]; finished: boolean; status: string }> {
  const run = await lockRun(tx, orgId, runId);
  if (!run) return { jobs: [], finished: true, status: "missing" };
  if (["completed", "failed", "cancelled"].includes(run.status)) return { jobs: [], finished: true, status: run.status };
  const d = run.data;
  const jobs: BuiltJob[] = [];
  const cap = await evalCap(tx, orgId);
  let free = cap - (await liveAttempts(tx, orgId));
  for (const it of d.items) {
    if (free <= 0) break;
    if (it.state !== "pending") continue;
    jobs.push(await startItem(tx, orgId, run, d, it, now));
    free--;
  }
  const open = d.items.some((i) => i.state === "pending" || i.state === "running");
  if (open) {
    await saveRun(tx, orgId, runId, d, { status: "running" });
    return { jobs, finished: false, status: "running" };
  }
  const status = await finalize(tx, orgId, run, d, now);
  return { jobs, finished: true, status };
}

/** Writes the per-case results, the score and the run's final state, and the event the notifications and the audit read. */
async function finalize(tx: Tx, orgId: string, run: RunRow, d: RunData, _now: Date): Promise<string> {
  const caseIds = [...new Set(d.items.map((i) => i.case))];
  let passed = 0;
  let graded = 0;
  for (const c of caseIds) {
    const items = d.items.filter((i) => i.case === c);
    const done = items.filter((i) => i.state === "done" && i.error === undefined);
    const passes = done.filter((i) => i.pass).length;
    const ok = done.length > 0 && passes / done.length >= 0.5;
    const first = items.find((i) => i.state === "done" && i.error === undefined && !i.pass) ?? items[0]!;
    const ms = Math.round(items.reduce((s, i) => s + (i.ms ?? 0), 0) / Math.max(1, items.length));
    const reason = done.length === 0 ? items.find((i) => i.error)?.error ?? "No attempt finished." : ok ? "" : first.reason || "Failed";
    if (done.length) {
      graded++;
      if (ok) passed++;
    }
    await tx.query(
      `insert into eval_results (org_id, id, run_id, case_id, passed, score, detail) values ($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict (org_id, run_id, case_id) do update set passed = excluded.passed, score = excluded.score, detail = excluded.detail, updated_at = now()`,
      [orgId, `ER-${run.id}-${c}`, run.id, c, ok, done.length ? Math.round((passes / done.length) * 1000) / 1000 : 0, JSON.stringify({ reason, ms, repeats: items.length, passes, graded: done.length, checks: (items.find((i) => i.checks) ?? first).checks ?? [], errors: items.filter((i) => i.error).map((i) => i.error) })],
    );
  }
  const cancelled = d.items.every((i) => i.state === "cancelled");
  const status = cancelled ? "cancelled" : graded === 0 ? "failed" : "completed";
  const score = graded ? Math.round((passed / graded) * 1000) / 1000 : null;
  await saveRun(tx, orgId, run.id, d, { status, score, finished: true });
  const th = Number((await tx.query<{ t: string | null }>(`select data->>'threshold' as t from suites where org_id = $1 and id = $2`, [orgId, run.suite_id])).rows[0]?.t);
  const threshold = Number.isFinite(th) && th > 0 ? th : 0.85;
  const prev = (await tx.query<{ score: string }>(
    `select score::text from eval_runs where org_id = $1 and suite_id = $2 and status = 'completed' and score is not null and id <> $3 and data->>'version' = $4 and coalesce(data->>'override','false') = 'false' order by started_at desc limit 1`,
    [orgId, run.suite_id, run.id, d.version],
  )).rows[0];
  const regression = score !== null && (score < threshold || (prev !== undefined && score < Number(prev.score) - 0.03));
  const [lo, hi] = wilson(passed, graded);
  await appendEvent(tx, {
    orgId, type: "eval.finished", category: "agents", actor: "system", channel: "system", subject: { type: "suite", id: run.suite_id }, projectId: null,
    outcome: status === "failed" ? "failed" : regression ? "regression" : "ok",
    after: { run: run.id, suite: run.suite_id, agent: d.agent, version: d.version, model: d.model, status, score, tasks: graded, passed, range: [lo, hi], threshold, override: d.override },
  });
  return status;
}

/** Items in a run whose attempt this is. */
const itemOf = (d: RunData, attemptId: string): EvalItem | undefined => d.items.find((i) => i.attempt === attemptId);

export interface EvalResultInput { status: "succeeded" | "failed" | "interrupted"; output: unknown; error?: { code: string; msg: string } | null }

/**
 * The runner's result arrived for an eval attempt: grade it, end the attempt, record the item, and start the next case. A result for an attempt that is no longer
 * live (stopped, superseded) is ignored. Returns the jobs to enqueue.
 */
export async function gradeEvalAttempt(tx: Tx, orgId: string, attemptId: string, fencing: number, r: EvalResultInput, now: Date): Promise<{ applied: boolean; jobs: BuiltJob[]; reason?: string }> {
  const a = (await tx.query<{ state: string; fencing: string; started_at: Date | null; data: { eval?: { run: string } } }>(`select state, fencing::text, started_at, data from attempts where org_id = $1 and id = $2 for update`, [orgId, attemptId])).rows[0];
  if (!a || Number(a.fencing) !== fencing) return { applied: false, jobs: [], reason: "superseded" };
  if (a.state !== "queued" && a.state !== "running") return { applied: false, jobs: [], reason: `attempt is ${a.state}` };
  const runId = a.data.eval?.run;
  const run = runId ? await lockRun(tx, orgId, runId) : undefined;
  if (!run) return { applied: false, jobs: [], reason: "no such run" };
  const d = run.data;
  const it = itemOf(d, attemptId);
  if (!it) return { applied: false, jobs: [], reason: "no such item" };
  const snap = d.cases[it.case]!;
  const seconds = a.started_at ? (now.getTime() - a.started_at.getTime()) / 1000 : 0;
  const g = grade(snap.checks, { status: r.status, output: r.output, error: r.error ?? null, seconds });
  await tx.query(`update attempts set state = $3, outcome = $4, ended_at = $5, lease_until = null, updated_at = now(), version = version + 1 where org_id = $1 and id = $2`, [orgId, attemptId, r.status === "succeeded" ? "succeeded" : r.status === "failed" ? "failed" : "cancelled", r.status, now]);
  it.state = "done";
  it.pass = g.pass;
  it.reason = g.reason;
  it.ms = Math.round(seconds * 1000);
  it.checks = g.checks;
  if (r.status === "interrupted") it.error = "The run was interrupted before it finished.";
  await saveRun(tx, orgId, run.id, d);
  const next = await progressEval(tx, orgId, run.id, now);
  return { applied: true, jobs: next.jobs };
}

/** An eval attempt that cannot produce a result (could not start, lost its lease, was stopped): the item ends with an error, which is neither a pass nor a fail of the agent. */
export async function failEvalAttempt(tx: Tx, orgId: string, attemptId: string, why: { code: string; msg: string; cancelled?: boolean }, now: Date): Promise<{ applied: boolean; jobs: BuiltJob[] }> {
  const a = (await tx.query<{ state: string; data: { eval?: { run: string } } }>(`select state, data from attempts where org_id = $1 and id = $2 for update`, [orgId, attemptId])).rows[0];
  if (!a || (a.state !== "queued" && a.state !== "running")) return { applied: false, jobs: [] };
  const runId = a.data.eval?.run;
  const run = runId ? await lockRun(tx, orgId, runId) : undefined;
  await tx.query(`update attempts set state = $3, outcome = $4, ended_at = $5, lease_until = null, updated_at = now(), version = version + 1 where org_id = $1 and id = $2`, [orgId, attemptId, why.cancelled ? "cancelled" : "failed", why.code, now]);
  if (!run) return { applied: true, jobs: [] };
  const it = itemOf(run.data, attemptId);
  if (it) {
    it.state = why.cancelled ? "cancelled" : "done";
    it.error = why.msg;
    it.reason = why.msg;
  }
  await saveRun(tx, orgId, run.id, run.data);
  const next = await progressEval(tx, orgId, run.id, now);
  return { applied: true, jobs: next.jobs };
}

/** Ends a whole run: every item not yet finished is cancelled and its live attempt ended. The work done so far stays on the run. */
export async function cancelEvalRun(tx: Tx, orgId: string, runId: string, now: Date): Promise<boolean> {
  const run = await lockRun(tx, orgId, runId);
  if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return false;
  for (const it of run.data.items) {
    if (it.state === "pending") it.state = "cancelled";
    else if (it.state === "running" && it.attempt) {
      await tx.query(`update attempts set state = 'cancelled', outcome = 'cancelled', ended_at = $3, lease_until = null, updated_at = now(), version = version + 1 where org_id = $1 and id = $2 and state in ('queued','running')`, [orgId, it.attempt, now]);
      it.state = "cancelled";
      it.error = "The run was cancelled.";
    }
  }
  await progressEval(tx, orgId, runId, now).catch(() => undefined);
  const after = await lockRun(tx, orgId, runId);
  if (after && !["completed", "failed", "cancelled"].includes(after.status)) await saveRun(tx, orgId, runId, run.data, { status: "cancelled", finished: true });
  return true;
}

/**
 * Housekeeping for the reaper: eval attempts that lost their lease, or that sat queued behind a stop, end with an error so a run is never stuck; runs with
 * pending items and free capacity are nudged. Returns the number of attempts ended and the jobs to enqueue.
 */
export async function sweepEvals(tx: Tx, orgId: string, now: Date, o: { queuedGraceMs?: number } = {}): Promise<{ ended: number; jobs: BuiltJob[] }> {
  const jobs: BuiltJob[] = [];
  let ended = 0;
  const lost = (await tx.query<{ id: string }>(
    `select a.id from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id where a.org_id = $1 and w.source = 'eval' and a.state = 'running' and a.lease_until < $2 order by a.lease_until limit 25 for update of a skip locked`, [orgId, now],
  )).rows;
  for (const r of lost) {
    const f = await failEvalAttempt(tx, orgId, r.id, { code: "lease_expired", msg: "The run stopped heartbeating." }, now);
    if (f.applied) ended++;
    jobs.push(...f.jobs);
  }
  const grace = new Date(now.getTime() - (o.queuedGraceMs ?? 15 * 60_000));
  const stuck = (await tx.query<{ id: string }>(
    `select a.id from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id where a.org_id = $1 and w.source = 'eval' and a.state = 'queued' and a.created_at < $2
        and exists (select 1 from stops s where s.org_id = a.org_id and s.lifted_at is null and (s.scope_type = 'factory' or (s.scope_type = 'project' and s.project_id = w.project_id) or (s.scope_type = 'repo' and s.repo_id = w.repo_id)))
      limit 25 for update of a skip locked`, [orgId, grace],
  )).rows;
  for (const r of stuck) {
    const f = await failEvalAttempt(tx, orgId, r.id, { code: "stopped", msg: "A stop covers this project, so the case did not run.", cancelled: true }, now);
    if (f.applied) ended++;
    jobs.push(...f.jobs);
  }
  const open = (await tx.query<{ id: string }>(`select id from eval_runs where org_id = $1 and status in ('queued','running') order by started_at limit 25`, [orgId])).rows;
  for (const r of open) jobs.push(progressJob(r.id, ":sweep"));
  return { ended, jobs };
}

export const newRunId = async (tx: Queryable, orgId: string): Promise<string> => {
  const n = Number((await tx.query<{ n: string }>(`select (coalesce(max(substring(id from 5)::int), 0) + 1)::text as n from eval_runs where org_id = $1 and id ~ '^RUN-[0-9]+$'`, [orgId])).rows[0]!.n);
  return `RUN-${n}`;
};
export const newCaseSalt = (): string => randomBytes(2).toString("hex");
