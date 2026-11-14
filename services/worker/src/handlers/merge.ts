import { parseJob, recordMerged, recordNewHead } from "@gantry/api/core";
import { withTx, type Job } from "@gantry/db";
import { raiseAlert, recordEvent } from "../alerts.js";
import { PermanentError, TransientError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";
import { coveringStops, loadRepo } from "./common.js";

/**
 * merge.request (spec 11.5, F4): merge a pull request at the exact commit that was approved.
 *  1. The intent is recorded (an event keyed by work order, pull request and commit) before anything is sent to GitHub.
 *  2. Before every call, including every retry, the real pull request is read: already merged means no second call, a moved head reopens the gate.
 *  3. Only GitHub reporting the pull request as merged closes the gate (`recordMerged`).
 * A crash between the merge call and the commit therefore leaves one merge: the retry sees it merged and only records it.
 */
export async function mergeRequest(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const { deps } = ctx;
  const p = parseJob("merge.request", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { woId, prNumber, headSha } = p.value;
  const org = job.orgId;

  const wo = (await deps.pool.query<{ project_id: string; repo_id: string | null; parent_id: string | null; data: { merging?: { prNumber?: number } } }>(
    `select project_id, repo_id, parent_id, data from work_orders where org_id = $1 and id = $2`, [org, woId],
  )).rows[0];
  if (!wo) return { skipped: "unknown work order" };
  const stops = await coveringStops(deps.pool, org, { woId, projectId: wo.project_id, repoId: wo.repo_id, parentId: wo.parent_id });
  if (stops.length) return { skipped: `${stops[0]!.mode} at ${stops[0]!.scopeType} scope` };
  if (wo.data.merging?.prNumber !== prNumber) return { skipped: "no merge is waiting for that pull request" };
  const pr = (await deps.pool.query<{ head_sha: string | null; state: string }>(`select head_sha, state from pull_requests where org_id = $1 and wo_id = $2 and number = $3`, [org, woId, prNumber])).rows[0];
  if (!pr || pr.state !== "open") return { skipped: "the pull request is not open" };
  if (pr.head_sha !== headSha) return { skipped: "the head moved after approval; the gate reopens on the new head" };
  const repo = await loadRepo(deps.pool, org, wo.repo_id);
  if (!repo?.full) throw new PermanentError("The work order's repository has no GitHub identity.", "no_repo");

  const key = `merge:${woId}:${prNumber}:${headSha}`;
  await withTx(deps.pool, (tx) => recordEvent(tx, {
    orgId: org, type: "github.merge.requested", category: "integrations", subject: { type: "wo", id: woId }, woId, projectId: wo.project_id,
    after: { repo: repo.full, number: prNumber, headSha, method: repo.mergeStrategy }, idempotencyKey: `${key}:requested`,
  }));

  const finish = async (mergeSha: string | null): Promise<unknown> => {
    await withTx(deps.pool, async (tx) => {
      await recordEvent(tx, {
        orgId: org, type: "github.merge.completed", category: "integrations", subject: { type: "wo", id: woId }, woId, projectId: wo.project_id,
        after: { repo: repo.full, number: prNumber, headSha, mergeSha }, idempotencyKey: `${key}:completed`,
      });
      await recordMerged(tx, org, woId, { prNumber, ...(mergeSha ? { mergeSha } : {}) });
    });
    return { merged: true, mergeSha };
  };
  const reopen = async (newHead: string): Promise<unknown> => {
    await withTx(deps.pool, (tx) => recordNewHead(tx, org, woId, newHead));
    return { skipped: "head moved", headSha: newHead };
  };

  // F4: look at GitHub before acting.
  const state = await deps.broker.pullState(repo.full, prNumber);
  if (state.pullRequest.state === "merged") return finish(state.pullRequest.mergeCommitSha ?? null);
  if (state.pullRequest.state === "closed") return { skipped: "the pull request was closed without merging" };
  if (state.pullRequest.headSha && state.pullRequest.headSha !== headSha) return reopen(state.pullRequest.headSha);

  const res = await deps.broker.merge({ woId, repo: repo.full, number: prNumber, headSha, method: repo.mergeStrategy });
  if (res.ok) {
    if (res.merged) return finish(res.mergeSha);
    throw new TransientError(`GitHub did not merge #${prNumber}.`, "not_merged");
  }
  if (res.code === "head_moved") return res.headSha ? reopen(res.headSha) : { skipped: "head moved" };
  if (res.code === "not_open" || res.code === "fenced") return { skipped: res.code };
  // Branch rules or checks not satisfied yet: retry with backoff; when the queue gives up, a person is told.
  if (ctx.last) {
    await withTx(deps.pool, (tx) => raiseAlert(tx, {
      orgId: org, type: "github.merge.blocked", category: "integrations", subject: { type: "wo", id: woId }, woId, projectId: wo.project_id,
      after: { repo: repo.full, number: prNumber, headSha, reason: res.msg }, key: `${key}:blocked`,
    }));
    return { blocked: res.msg };
  }
  throw new TransientError(res.msg, res.code);
}
