import { job as buildJob, parseJob, reconcileStop } from "@gantry/api/core";
import { enqueue, withTx, type Job } from "@gantry/db";
import { raiseAlert, recordEvent } from "../alerts.js";
import type { Deps } from "../deps.js";
import { errMsg, PermanentError, TransientError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";

interface StopRow { org_id: string; id: string; scope_type: "factory" | "project" | "repo" | "wo"; project_id: string | null; repo_id: string | null; wo_id: string | null; mode: "halt" | "kill"; in_flight: string | null; lifted_at: Date | null }

const scopeSql = (s: StopRow): { cond: string; params: unknown[] } => {
  switch (s.scope_type) {
    case "factory": return { cond: "true", params: [] };
    case "project": return { cond: "w.project_id = $2", params: [s.project_id] };
    case "repo": return { cond: "w.repo_id = $2", params: [s.repo_id] };
    default: return { cond: "(w.id = $2 or w.parent_id = $2)", params: [s.wo_id] };
  }
};

async function inScope(deps: Deps, s: StopRow): Promise<{ runs: string[]; wos: string[]; merges: number; prs: Array<{ woId: string; repo: string; number: number; headSha: string | null }> }> {
  const sc = scopeSql(s);
  const base = [s.org_id, ...sc.params];
  const runs = (await deps.pool.query<{ id: string }>(
    `select r.id from runs r join work_orders w on w.org_id = r.org_id and w.id = r.wo_id where r.org_id = $1 and r.state in ('starting','running') and ${sc.cond} order by r.created_at`, base,
  )).rows.map((r) => r.id);
  const wos = (await deps.pool.query<{ id: string }>(`select w.id from work_orders w where w.org_id = $1 and ${sc.cond} and w.state not in ('done') order by w.id`, base)).rows.map((r) => r.id);
  const prs = (await deps.pool.query<{ wo_id: string; number: number; head_sha: string | null; repo: string | null; name: string }>(
    `select p.wo_id, p.number, p.head_sha, r.github_full_name as repo, r.name from pull_requests p join work_orders w on w.org_id = p.org_id and w.id = p.wo_id join repos r on r.org_id = p.org_id and r.id = p.repo_id
      where p.org_id = $1 and p.state = 'open' and ${sc.cond}`, base,
  )).rows.flatMap((p) => {
    const repo = p.repo ?? (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.name) ? p.name : null);
    return repo ? [{ woId: p.wo_id, repo, number: p.number, headSha: p.head_sha }] : [];
  });
  return { runs, wos, merges: 0, prs };
}

/** Queued merges for work orders in scope never run (spec 9.7: no merges in scope). A merge already in flight is stopped by the broker's fence check. */
async function cancelMerges(deps: Deps, org: string, woIds: string[]): Promise<number> {
  if (!woIds.length) return 0;
  const r = await deps.pool.query(
    `update jobs set status = 'done', result = '{"cancelled":"stop"}'::jsonb, completed_at = now(), updated_at = now()
      where org_id = $1 and kind = 'merge.request' and status = 'queued' and payload->>'woId' = any($2)`,
    [org, woIds],
  );
  return r.rowCount ?? 0;
}

async function stopRuns(deps: Deps, s: StopRow, runIds: string[]): Promise<void> {
  const queue = [...runIds];
  const errors: string[] = [];
  const lane = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        await deps.launcher.stop(id, { keepWorkspace: false });
      } catch (e) {
        errors.push(`${id}: ${errMsg(e)}`);
      }
    }
  };
  await Promise.all([lane(), lane(), lane(), lane()]);
  if (errors.length) deps.log.warn({ stop: s.id, errors }, "launcher stop incomplete");
}

/** Only a run the launcher no longer lists is marked stopped; one that survives stays in scope so a retry finds it again. */
async function markStopped(deps: Deps, s: StopRow, runIds: string[]): Promise<void> {
  if (!runIds.length) return;
  await deps.pool.query(
    `update runs set state = case when state in ('starting','running') then 'stopped' else state end, ended_at = coalesce(ended_at, now()), updated_at = now(), data = data || $3::jsonb where org_id = $1 and id = any($2)`,
    [s.org_id, runIds, JSON.stringify({ endedBy: `stop ${s.id}` })],
  );
}

/** Spec 4.4 step 4: the worker checks that every affected container is gone; the ones that are not raise a "termination unconfirmed" alert. */
async function verifyGone(deps: Deps, s: StopRow, runIds: string[]): Promise<string[]> {
  const deadline = deps.now().getTime() + deps.cfg.terminationVerifyMs;
  let remaining = runIds;
  for (;;) {
    const live = await deps.launcher.list();
    remaining = runIds.filter((id) => live.some((r) => r.runId === id && (r.container || r.network || r.volume)));
    if (!remaining.length || deps.now().getTime() >= deadline) return remaining;
    await deps.sleep(deps.cfg.terminationPollMs);
    await stopRuns(deps, s, remaining);
  }
}

/**
 * stop.enforce (spec 4.4, 9.7). In order:
 *  1. `reconcileStop`: the database side (attempts cancelled, run tokens revoked so the edge refuses within seconds, slots, gates, work order states);
 *  2. queued merges in scope are cancelled;
 *  3. the launcher terminates every run in scope (the agent is never asked to cooperate);
 *  4. the worker verifies the containers are gone, otherwise raises "termination unconfirmed" and retries;
 *  5. for a kill, the Gantry check on open pull requests is failed; a kill-cancel also converts them to draft.
 * Lifting a stop only reconciles (resume and restore start fresh attempts there). Every step is idempotent, so a retry repeats safely.
 */
export async function stopEnforce(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const { deps } = ctx;
  const p = parseJob("stop.enforce", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const org = job.orgId;
  const row = (await deps.pool.query<StopRow>(`select org_id, id, scope_type, project_id, repo_id, wo_id, mode, in_flight, lifted_at from stops where org_id = $1 and id = $2`, [org, p.value.stopId])).rows[0];
  if (!row) return { skipped: "unknown stop" };

  const rec = await withTx(deps.pool, (tx) => reconcileStop(tx, row.id, { orgId: org, now: deps.now(), haltGraceMs: deps.cfg.haltGraceMs }));
  if (row.lifted_at) return { lifted: true, reconcile: rec.action };
  if (rec.action === "enforcing" && rec.retryAt) {
    // Spec 4.5: a halt lets the run checkpoint at the turn boundary. Model calls are already refused at the edge; nothing is torn down until the grace ends.
    const j = buildJob("stop.enforce", { stopId: row.id, scope: row.scope_type, targetId: row.wo_id ?? row.repo_id ?? row.project_id ?? null, mode: row.mode }, { dedupeKey: `stop.enforce:${row.id}:grace:${rec.retryAt.getTime()}` });
    await enqueue(deps.pool, { orgId: org, kind: j.kind, queue: j.queue, payload: j.payload, runAt: rec.retryAt, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}), ...(j.priority !== undefined ? { priority: j.priority } : {}) });
    return { grace: true, retryAt: rec.retryAt.toISOString() };
  }

  const scope = await inScope(deps, row);
  const cancelledMerges = await cancelMerges(deps, org, scope.wos);
  if (scope.runs.length) await stopRuns(deps, row, scope.runs);
  const stuck = scope.runs.length ? await verifyGone(deps, row, scope.runs) : [];
  await markStopped(deps, row, scope.runs.filter((id) => !stuck.includes(id)));
  if (stuck.length) {
    await withTx(deps.pool, async (tx) => {
      for (const runId of stuck) {
        await raiseAlert(tx, { orgId: org, type: "run.termination_unconfirmed", category: "kill", subject: { type: "run", id: runId }, after: { stop: row.id, run: runId, scope: row.scope_type, mode: row.mode }, key: `termination_unconfirmed:${row.id}:${runId}` });
      }
    });
    throw new TransientError(`Termination unconfirmed for ${stuck.join(", ")}.`, "termination_unconfirmed");
  }

  let checksFailed = 0;
  let drafted = 0;
  const errors: string[] = [];
  if (row.mode === "kill") {
    for (const pr of scope.prs) {
      if (!pr.headSha) continue;
      try {
        const c = await deps.broker.gateCheck({ woId: pr.woId, repo: pr.repo, headSha: pr.headSha, state: "failing", summary: `Gantry: ${row.scope_type} kill is in force. This pull request must not merge.` });
        if (c.ok) checksFailed++;
        if (row.in_flight === "cancel") {
          const d = await deps.broker.convertToDraft({ woId: pr.woId, repo: pr.repo, number: pr.number });
          if (d.ok) drafted++;
        }
      } catch (e) {
        errors.push(`${pr.repo}#${pr.number}: ${errMsg(e)}`);
      }
    }
  }
  if (errors.length) throw new TransientError(`GitHub could not be told about the stop: ${errors.join("; ")}`, "github_unavailable");

  await withTx(deps.pool, (tx) => recordEvent(tx, {
    orgId: org, type: "stop.enforced", category: "kill", subject: { type: row.scope_type, id: row.wo_id ?? row.repo_id ?? row.project_id ?? "factory" }, projectId: row.project_id, woId: row.wo_id,
    after: { stop: row.id, mode: row.mode, runsStopped: scope.runs.length, mergesCancelled: cancelledMerges, checksFailed, draftsConverted: drafted, workOrders: rec.workOrders },
    idempotencyKey: `stop.enforced:${row.id}`,
  }));
  return { enforced: true, runsStopped: scope.runs.length, mergesCancelled: cancelledMerges, checksFailed, drafted };
}
