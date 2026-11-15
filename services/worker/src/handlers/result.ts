import { applyStationResult, attemptIsCurrent, endCarrierAttempt, isCarrier, parseJob, type StationResult } from "@gantry/api/core";
import { enqueue, withTx, type Job, type Queryable } from "@gantry/db";
import type { PublishOutcome } from "../clients/broker.js";
import type { Deps } from "../deps.js";
import { errMsg, PermanentError } from "../errors.js";
import { recordEvent } from "../alerts.js";
import type { HandlerCtx } from "../runner.js";
import { loadAttempt, runIdFor, volumeFor, type AttemptInfo } from "./common.js";
import { gradeEvalCase } from "./evals.js";
import { teardownRun } from "./teardown.js";

interface StoredResult {
  outcome: "succeeded" | "failed" | "interrupted" | "needs_person";
  summary: string;
  body: { output?: Record<string, unknown> | null; usage?: Array<{ inputTokens?: number; outputTokens?: number; costUsd?: number }>; error?: { code: string; msg: string } | null };
}

/** Station output that produced code: the Build station always, any other station when it reports commits. */
const producedCommits = (a: AttemptInfo, output: Record<string, unknown> | null | undefined): boolean =>
  a.station === "build" || (Array.isArray(output?.commits) && (output!.commits as unknown[]).length > 0);

async function usageOf(db: Queryable, orgId: string, runId: string, stored: StoredResult): Promise<StationResult["usage"]> {
  const r = (await db.query<{ tokens: string; micros: string; n: string }>(
    `select coalesce(sum(input_tokens + output_tokens),0)::text as tokens, coalesce(sum(cost_micros),0)::text as micros, count(*)::text as n from run_usage where org_id = $1 and run_id = $2`,
    [orgId, runId],
  )).rows[0]!;
  // The edge's metering is the authority (it saw every call); the runner's own report is the fallback when nothing was metered.
  if (Number(r.n) > 0) return { tokens: Number(r.tokens), costUsd: Number(r.micros) / 1e6 };
  const rep = stored.body.usage ?? [];
  return { tokens: rep.reduce((s, u) => s + (u.inputTokens ?? 0) + (u.outputTokens ?? 0), 0), costUsd: rep.reduce((s, u) => s + (u.costUsd ?? 0), 0) };
}

async function filesOf(db: Queryable, orgId: string, woId: string, shas: string[]): Promise<Array<{ path: string; additions: number; deletions: number }>> {
  if (!shas.length) return [];
  const { rows } = await db.query<{ path: string; additions: number; deletions: number }>(
    `select f.path, sum(f.additions)::int as additions, sum(f.deletions)::int as deletions from changed_files f join commits c on c.org_id = f.org_id and c.id = f.commit_id
      where f.org_id = $1 and c.wo_id = $2 and c.sha = any($3) group by f.path order by f.path`,
    [orgId, woId, shas],
  );
  return rows;
}

/** Publishes the attempt's workspace through gantry-github (spec 11.4, step 7). The broker fence-checks the attempt itself. */
export async function publishAttempt(deps: Deps, a: AttemptInfo, summary: string): Promise<PublishOutcome | null> {
  if (!a.repo?.full) return null;
  return deps.broker.publish({
    attemptId: a.attemptId, fencing: a.fencing, repo: a.repo.full, volume: volumeFor(runIdFor(a.attemptId)), branch: `${a.repo.branchPrefix}${a.woId}`,
    baseBranch: a.repo.defaultBranch, title: `${a.woId}: ${a.title}`.slice(0, 250), ...(summary ? { body: summary.slice(0, 60000) } : {}),
  });
}

/** Keeps the attempt's lease alive while the result is being published: the runner is done, the work is not. */
async function holdLease(deps: Deps, a: AttemptInfo): Promise<void> {
  await deps.pool.query(
    `update attempts set lease_until = $3, lease_holder = 'worker', updated_at = now() where org_id = $1 and id = $2 and state in ('queued','running')`,
    [a.orgId, a.attemptId, new Date(deps.now().getTime() + deps.cfg.publishLeaseMs)],
  );
}

/**
 * run.result (spec 4.3 step 7): applies the stored station result through the flow engine, after publishing the workspace's commits when the
 * station produced code, then tears the run down. A result from a superseded attempt is rejected by the engine (F3) and only the teardown happens.
 */
export async function runResult(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const { deps } = ctx;
  const p = parseJob("run.result", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { runId, attemptId, fencing } = p.value;
  const a = await loadAttempt(deps.pool, job.orgId, attemptId);
  if (!a) return { skipped: "unknown attempt" };
  const sr = (await deps.pool.query<StoredResult>(`select outcome, summary, body from station_results where org_id = $1 and id = $2`, [job.orgId, `sr-${runId}`])).rows[0];
  if (!sr) throw new PermanentError(`No stored result for run ${runId}.`, "no_result");

  const cur = await attemptIsCurrent(deps.pool, job.orgId, attemptId, fencing);
  // Spec 13.2: an eval case's result is graded and recorded, never published to a repository and never applied through the flow.
  if (a.woData.eval) {
    const graded = cur.current ? await gradeEvalCase(deps, a, { status: sr.outcome === "needs_person" ? "succeeded" : sr.outcome, output: sr.body.output ?? null, error: sr.body.error ?? null }) : { superseded: cur.reason };
    // An eval run that stopped to ask delivered a result (its questions are in output.dialogue for the checks to read).
    await teardownRun(deps, job.orgId, runId, sr.outcome === "succeeded" || sr.outcome === "needs_person" ? "succeeded" : "failed");
    return graded;
  }
  // An onboarding agent step: its result stays in station_results for the collector to validate; nothing is published and the flow engine never hears of it.
  if (isCarrier(a.woData)) {
    const ended = cur.current
      ? await withTx(deps.pool, async (tx) => {
          const j = await endCarrierAttempt(tx, job.orgId, attemptId, sr.outcome === "succeeded" ? { code: "succeeded", msg: "The agent delivered its result.", delivered: true } : { code: sr.body.error?.code ?? sr.outcome, msg: sr.body.error?.msg ?? sr.summary ?? `The run ${sr.outcome}.` }, deps.now());
          if (j) await enqueue(tx, { orgId: job.orgId, kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}) });
          return j !== null;
        })
      : false;
    await teardownRun(deps, job.orgId, runId, sr.outcome === "succeeded" ? "succeeded" : "failed");
    return { onboarding: true, collected: ended, ...(cur.current ? {} : { superseded: cur.reason }) };
  }
  let outcome: unknown = { superseded: cur.reason };
  if (cur.current) {
    const output = sr.body.output ?? null;
    let status: StationResult["status"] = sr.outcome;
    let error = sr.body.error ?? null;
    let summary = sr.summary;
    const observed: NonNullable<StationResult["observed"]> = {};
    let fenced = false;
    if (sr.outcome === "succeeded" && producedCommits(a, output) && a.repo?.full) {
      await holdLease(deps, a);
      const pub = await publishAttempt(deps, a, sr.summary);
      if (pub && pub.ok) {
        if (pub.result.headSha) observed.headSha = pub.result.headSha;
        const files = await filesOf(deps.pool, job.orgId, a.woId, pub.result.commits.map((c) => c.sha));
        if (files.length) observed.files = files;
        await withTx(deps.pool, (tx) => recordEvent(tx, {
          orgId: job.orgId, type: "run.published", category: "flow", subject: { type: "wo", id: a.woId }, woId: a.woId, projectId: a.projectId,
          after: { attempt: attemptId, branch: pub.result.branch, headSha: pub.result.headSha, commits: pub.result.commits.length, noop: pub.result.noop, pr: pub.result.pullRequest?.number ?? null },
          idempotencyKey: `run.published:${attemptId}`,
        }));
      } else if (pub && !pub.ok) {
        if (pub.fenced) fenced = true;
        else {
          // The workspace itself cannot be published (history the broker refuses, a bad branch): the station did not deliver.
          status = "failed";
          error = { code: `publish_${pub.code}`, msg: pub.msg };
          summary = `Publishing the work failed: ${pub.msg}`;
        }
      }
    }
    if (!fenced) {
      const usage = await usageOf(deps.pool, job.orgId, runId, sr);
      const result: StationResult = { status, ...(summary ? { summary } : {}), output, ...(error ? { error } : {}), ...(usage ? { usage } : {}), ...(Object.keys(observed).length ? { observed } : {}) };
      outcome = await withTx(deps.pool, (tx) => applyStationResult(tx, attemptId, fencing, result));
    } else outcome = { fenced: true };
  }
  // A run that stopped to ask delivered what it was asked to: it ends as succeeded; the work order waits in the bay.
  await teardownRun(deps, job.orgId, runId, sr.outcome === "succeeded" || sr.outcome === "needs_person" ? "succeeded" : "failed");
  return outcome;
}

/** publish (spec 11.4): publish an attempt's workspace on its own, for a retry or a re-publish. Refused for a superseded attempt. */
export async function publishJob(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const { deps } = ctx;
  const p = parseJob("publish", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const a = await loadAttempt(deps.pool, job.orgId, p.value.attemptId);
  if (!a) return { skipped: "unknown attempt" };
  if (a.fencing !== p.value.fencing) return { skipped: "superseded", reason: "The fencing number is not the attempt's." };
  const pub = await publishAttempt(deps, a, "");
  if (!pub) return { skipped: "no GitHub repository" };
  if (!pub.ok) {
    if (pub.fenced) return { skipped: "superseded", reason: pub.msg };
    throw new PermanentError(`Publish refused: ${pub.code}: ${pub.msg}`, pub.code);
  }
  await withTx(deps.pool, async (tx) => {
    await tx.query(`update attempts set data = data || $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [
      job.orgId, a.attemptId, JSON.stringify({ publish: { branch: pub.result.branch, headSha: pub.result.headSha, commits: pub.result.commits.length, pr: pub.result.pullRequest?.number ?? null, at: deps.now().toISOString() } }),
    ]);
    await recordEvent(tx, {
      orgId: job.orgId, type: "run.published", category: "flow", subject: { type: "wo", id: a.woId }, woId: a.woId, projectId: a.projectId,
      after: { attempt: a.attemptId, branch: pub.result.branch, headSha: pub.result.headSha, commits: pub.result.commits.length, noop: pub.result.noop, pr: pub.result.pullRequest?.number ?? null }, idempotencyKey: `run.published:${a.attemptId}`,
    });
  });
  return { published: true, headSha: pub.result.headSha };
}

void errMsg;
