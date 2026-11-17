import { enqueue, withTx, type Job, type Tx } from "@gantry/db";
import { evaluateAllTrust, failEvalAttempt, gradeEvalAttempt, parseJob, progressEval, publishChange, sweepEvals, type EvalResultInput } from "@gantry/api/core";
import { recordEvent } from "../alerts.js";
import type { BuiltJob } from "@gantry/api/core";
import type { Deps } from "../deps.js";
import { PermanentError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";
import type { AttemptInfo } from "./common.js";

/** Enqueues the jobs an eval transition returned, in the same transaction as the transition. */
export async function enqueueJobs(tx: Tx, orgId: string, jobs: readonly BuiltJob[]): Promise<void> {
  // The screen's eval views refresh on every transition (the worker publishes the same change the API's commands do).
  await publishChange(tx, { org: orgId, keys: ["evalRuns", "suites", "agents", "scorecards"] });
  for (const j of jobs) await enqueue(tx, { orgId, kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}), ...(j.priority !== undefined ? { priority: j.priority } : {}) });
}

/**
 * eval.dispatch (spec 13.2): starts the next cases of an eval run within the organisation's eval concurrency cap, behind work-order jobs, and finishes the run when none remain.
 * The cases themselves start through the ordinary attempt.dispatch, so they run in sandboxes through the launcher and the edge exactly as real work does.
 */
export async function evalDispatch(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("eval.dispatch", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  return withTx(ctx.deps.pool, async (tx) => {
    const r = await progressEval(tx, job.orgId, p.value.runId, ctx.deps.now());
    await enqueueJobs(tx, job.orgId, r.jobs);
    return { started: r.jobs.length, finished: r.finished, status: r.status };
  });
}

/** A case's attempt could not start or finish: its item ends with an error (neither a pass nor a fail of the agent) and the run moves on. */
export async function failEvalCase(deps: Deps, a: AttemptInfo, code: string, msg: string): Promise<unknown> {
  return withTx(deps.pool, async (tx) => {
    const r = await failEvalAttempt(tx, a.orgId, a.attemptId, { code, msg }, deps.now());
    await enqueueJobs(tx, a.orgId, r.jobs);
    return { eval: true, failed: code, applied: r.applied };
  });
}

/** The stored result of an eval case's run: graded here, never published, never applied through the flow engine. */
export async function gradeEvalCase(deps: Deps, a: AttemptInfo, result: EvalResultInput): Promise<unknown> {
  return withTx(deps.pool, async (tx) => {
    const r = await gradeEvalAttempt(tx, a.orgId, a.attemptId, a.fencing, result, deps.now());
    await enqueueJobs(tx, a.orgId, r.jobs);
    return { eval: true, graded: r.applied, ...(r.reason ? { reason: r.reason } : {}) };
  });
}

/** Reaper side: eval attempts that lost their lease or sat behind a stop end with an error, and open runs are nudged. */
export async function evalSweep(deps: Deps, orgId: string): Promise<number> {
  return withTx(deps.pool, async (tx) => {
    const r = await sweepEvals(tx, orgId, deps.now());
    await enqueueJobs(tx, orgId, r.jobs);
    return r.ended;
  });
}

/** trust.evaluate (spec 13.3): the daily look at every cell, for promotions the passing of time made possible. Proposals are only made while levels above L1 are switched on. */
export async function trustEvaluate(job: Job, ctx: HandlerCtx): Promise<unknown> {
  return withTx(ctx.deps.pool, async (tx) => {
    const events: Array<Parameters<Parameters<typeof evaluateAllTrust>[3]>[0]> = [];
    const out = await evaluateAllTrust(tx, job.orgId, ctx.deps.now(), (e) => events.push(e));
    // Each change reaches only the people who see its project; one with no project reaches factory-wide readers alone.
    for (const project of new Set(events.map((e) => e.projectId ?? null))) await publishChange(tx, { org: job.orgId, keys: ["trust", "audit"], ...(project ? { project } : {}) });
    for (const e of events) {
      await recordEvent(tx, { orgId: job.orgId, type: e.type, category: e.category ?? "trust", subject: e.subject ?? null, projectId: e.projectId ?? null, before: e.before, after: e.after, outcome: e.outcome ?? "ok" });
    }
    return out;
  });
}
