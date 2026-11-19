import { applyJobDead, applyStationResult, endCarrierAttempt, expireLeases, failEvalAttempt, pendingStops, revokeRunTokens, job as buildJob } from "@gantry/api/core";
import { enqueue, withTx, type Job, type Tx } from "@gantry/db";
import type { Deps } from "../deps.js";
import { errMsg } from "../errors.js";
import type { HandlerCtx } from "../runner.js";
import { enqueueJobs, evalSweep } from "./evals.js";

export interface SweepReport {
  stopsRequeued: number;
  leasesExpired: number;
  orphansRemoved: string[];
  watchdog: string[];
  diskCritical?: string[];
  /** Repos whose onboarding step's job died and were handed back to a person. */
  onboardingFreed?: string[];
}

const BUSY_JOB: Record<string, string[]> = {
  assessing: ["onboarding.assess"], opening_pr: ["onboarding.open_pr"], updating_pr: ["onboarding.open_pr"], merging: ["onboarding.merge"], verifying: ["onboarding.verify"],
};

/**
 * A repo whose onboarding step is marked busy but whose job is dead (all attempts or the lease used up) and has nothing else queued or running would be refused every command
 * forever. Hand it back to a person with the job's error (the API's `applyJobDead`).
 */
export async function onboardingSweep(deps: Deps, orgId: string): Promise<string[]> {
  const { rows } = await deps.pool.query<{ id: string; busy: string }>(`select id, data->'onboarding'->>'busy' as busy from repos where org_id = $1 and data->'onboarding'->>'busy' is not null order by id`, [orgId]);
  const freed: string[] = [];
  for (const r of rows) {
    const kinds = BUSY_JOB[r.busy] ?? [];
    if (!kinds.length) continue;
    const live = (await deps.pool.query(`select 1 from jobs where org_id = $1 and kind like 'onboarding.%' and payload->>'repoId' = $2 and status in ('queued','running') limit 1`, [orgId, r.id])).rowCount;
    if (live) continue;
    const last = (await deps.pool.query<{ status: string; last_error: string | null }>(`select status, last_error from jobs where org_id = $1 and kind = any($3) and payload->>'repoId' = $2 order by created_at desc, id desc limit 1`, [orgId, r.id, kinds])).rows[0];
    if (!last || last.status !== "dead") continue;
    const out = await withTx(deps.pool, (tx) => applyJobDead(tx, orgId, { repoId: r.id, now: deps.now(), error: last.last_error ?? "the job died" }));
    if (out.applied) freed.push(r.id);
  }
  return freed;
}

/** Removes every launcher resource without a live attempt lease (spec 4.6). A run whose attempt is queued or running, within its lease plus a grace, is live. */
export async function reapOrphans(deps: Deps, orgId: string): Promise<string[]> {
  const live = await deps.launcher.list();
  const removed: string[] = [];
  const graceMs = deps.cfg.reaperGraceMs;
  for (const r of live) {
    const row = (await deps.pool.query<{ state: string; attempt_state: string; lease_until: Date | null; created_at: Date; evidence: boolean }>(
      `select r.state, a.state as attempt_state, a.lease_until, r.created_at, (r.data->'blocker'->>'code' = 'host_disk_critical' and r.updated_at > now() - interval '1 hour') as evidence from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id where r.org_id = $1 and r.id = $2`,
      [orgId, r.runId],
    )).rows[0];
    const now = deps.now().getTime();
    let orphan: boolean;
    if (!row) orphan = true;
    else if (!["queued", "running"].includes(row.attempt_state) || ["stopped", "reaped", "succeeded", "failed"].includes(row.state)) orphan = true;
    else orphan = row.lease_until !== null && row.lease_until.getTime() + graceMs < now;
    // Another organisation's run is not ours to remove: a run row that exists in no org at all is.
    if (!row && (await deps.pool.query(`select 1 from runs where id = $1 and org_id <> $2 limit 1`, [r.runId, orgId])).rowCount) continue;
    if (!orphan || row?.evidence) continue;
    try {
      await deps.launcher.stop(r.runId, { keepWorkspace: false });
      removed.push(r.runId);
      if (row) await deps.pool.query(`update runs set state = case when state in ('starting','running') then 'reaped' else state end, ended_at = coalesce(ended_at, now()), updated_at = now() where org_id = $1 and id = $2`, [orgId, r.runId]);
    } catch (e) {
      deps.log.warn({ run: r.runId, err: errMsg(e) }, "reaper could not remove a run; it is retried on the next sweep");
    }
  }
  return removed;
}

/** Ends a run's attempt with a failed result, the way the flow engine expects for each kind of work order (eval case, onboarding step, real work). */
async function failRunAttempt(tx: Tx, deps: Deps, orgId: string, r: { attempt_id: string; fencing: string }, code: string, msg: string): Promise<void> {
  // An eval case ends with an error on its item; real work goes through the flow engine.
  const isEval = (await tx.query(`select 1 from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id where a.org_id = $1 and a.id = $2 and w.source = 'eval'`, [orgId, r.attempt_id])).rowCount;
  const isCarrierWo = (await tx.query(`select 1 from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id where a.org_id = $1 and a.id = $2 and w.source = 'onboarding'`, [orgId, r.attempt_id])).rowCount;
  if (isCarrierWo) {
    const j = await endCarrierAttempt(tx, orgId, r.attempt_id, { code, msg }, deps.now());
    if (j) await enqueue(tx, { orgId, kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}) });
  } else if (isEval) {
    const f = await failEvalAttempt(tx, orgId, r.attempt_id, { code, msg }, deps.now());
    await enqueueJobs(tx, orgId, f.jobs);
  } else await applyStationResult(tx, r.attempt_id, Number(r.fencing), { status: "failed", summary: msg, error: { code, msg } });
}

/**
 * Runs the launcher stopped because the host disk was critically low (its hard-floor monitor): the order's blocker says so, instead of a lease timeout (R1).
 * The workspace was kept as evidence; reapOrphans leaves it for an hour.
 */
export async function diskCriticalSweep(deps: Deps, orgId: string): Promise<string[]> {
  const stops = await deps.launcher.criticalStops().catch(() => []);
  const out: string[] = [];
  for (const s of stops) {
    const r = (await deps.pool.query<{ id: string; attempt_id: string; fencing: string }>(
      `select r.id, r.attempt_id, a.fencing::text as fencing from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id
        where r.org_id = $1 and r.id = $2 and r.state in ('starting','running') and a.state in ('queued','running')`, [orgId, s.runId],
    )).rows[0];
    if (!r) continue;
    const msg = "Host disk critically low: the run was stopped so the host disk does not fill. Its workspace is kept for an hour for review. Free disk space, then run the station again.";
    await withTx(deps.pool, async (tx) => {
      await revokeRunTokens(tx, { orgId, runIds: [r.id], reason: "host disk critically low" });
      await tx.query(`update runs set state = 'stopped', ended_at = now(), updated_at = now(), data = (data - 'dispatchWait') || $3::jsonb where org_id = $1 and id = $2`, [orgId, r.id, JSON.stringify({ endedBy: "host disk critically low", blocker: { code: "host_disk_critical", label: "Host disk critically low", at: new Date(s.at).toISOString() } })]);
      await failRunAttempt(tx, deps, orgId, r, "host_disk_critical", msg);
    });
    out.push(r.id);
  }
  return out;
}

/**
 * Wall-clock watchdog (spec 10.5): time per run is enforced here, outside the runner. A run past its limit is torn down and its attempt fails,
 * which the flow engine counts toward the bounded retry (F9).
 */
export async function wallClockWatchdog(deps: Deps, orgId: string): Promise<string[]> {
  const { rows } = await deps.pool.query<{ id: string; attempt_id: string; fencing: string; limit_s: string }>(
    `select r.id, r.attempt_id, a.fencing::text as fencing, (r.data->>'wallClockSeconds') as limit_s from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id
      where r.org_id = $1 and r.state in ('starting','running') and a.state in ('queued','running') and r.data ? 'wallClockSeconds' and r.data->'dispatch'->>'phase' = 'started'
        and r.started_at + ((r.data->>'wallClockSeconds')::int * interval '1 second') < $2 limit 50`,
    [orgId, deps.now()],
  );
  const out: string[] = [];
  for (const r of rows) {
    try {
      // S-94: the token is revoked first (the edge refuses the next call within seconds), then the launcher is asked to stop the run. With the launcher
      // down, the run keeps no usable credential past its wall clock; the next pass finds it again (it is still starting/running) and retries the stop.
      await withTx(deps.pool, (tx) => revokeRunTokens(tx, { orgId, runIds: [r.id], reason: "wall-clock limit" }));
      await deps.launcher.stop(r.id, { keepWorkspace: false });
      await withTx(deps.pool, async (tx) => {
        await tx.query(`update runs set state = 'stopped', ended_at = now(), updated_at = now(), data = data || '{"endedBy":"wall-clock watchdog"}'::jsonb where org_id = $1 and id = $2`, [orgId, r.id]);
        await failRunAttempt(tx, deps, orgId, r, "wall_clock_exceeded", `The run exceeded its wall-clock limit of ${r.limit_s} seconds and was stopped.`);
      });
      out.push(r.id);
    } catch (e) {
      deps.log.warn({ run: r.id, err: errMsg(e) }, "watchdog could not stop a run; retried on the next pass");
    }
  }
  return out;
}

/**
 * reaper.sweep (every minute): re-enqueues stop enforcement that was lost (the stop is committed but its job never ran), expires lapsed leases
 * (F9: bounded retry, then "Needs a person"), enforces wall-clock limits, and removes orphaned runners, networks and volumes.
 */
export async function reaperSweep(job: Job, ctx: HandlerCtx): Promise<SweepReport> {
  const { deps } = ctx;
  const org = job.orgId;
  const report: SweepReport = { stopsRequeued: 0, leasesExpired: 0, orphansRemoved: [], watchdog: [] };
  for (const s of await pendingStops(deps.pool)) {
    if (s.orgId !== org) continue;
    const j = buildJob("stop.enforce", { stopId: s.id, scope: s.scope, targetId: s.target, mode: s.mode }, { dedupeKey: `stop.enforce:${s.id}:sweep` });
    await enqueue(deps.pool, { orgId: org, kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}) });
    report.stopsRequeued++;
  }
  report.leasesExpired = (await withTx(deps.pool, (tx) => expireLeases(tx, { now: deps.now() }))).length;
  // Eval cases that lost their lease or sat behind a stop end with an error, so an eval run is never stuck (spec 13.2).
  report.leasesExpired += await evalSweep(deps, org);
  report.watchdog = await wallClockWatchdog(deps, org);
  report.diskCritical = await diskCriticalSweep(deps, org);
  report.orphansRemoved = await reapOrphans(deps, org);
  report.onboardingFreed = await onboardingSweep(deps, org);
  return report;
}
