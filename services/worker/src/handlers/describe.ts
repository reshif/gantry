import { parseJob } from "@gantry/api/core";
import { withTx, type Job } from "@gantry/db";
import { recordEvent } from "../alerts.js";
import { PermanentError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";
import { coveringStops, loadRepo } from "./common.js";

/**
 * pr.describe: the Review agent's pull request description is written to the work order's pull request, through gantry-github (the broker fences it, keeps it to
 * the work order's own branch, redacts secrets and writes with the App's one-repository token). It runs again for every Review attempt, so a re-run updates the text.
 * A review that was replaced by a newer attempt writes nothing: the newer job carries the current text.
 */
export async function prDescribe(job: Job, ctx: HandlerCtx): Promise<unknown> {
  const { deps } = ctx;
  const p = parseJob("pr.describe", job.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { woId, attemptId } = p.value;
  const org = job.orgId;
  const wo = (await deps.pool.query<{ project_id: string; repo_id: string | null; parent_id: string | null; data: { review?: { attempt?: string; verdict?: string; headSha?: string | null; description?: { title: string | null; body: string } | null } } }>(
    `select project_id, repo_id, parent_id, data from work_orders where org_id = $1 and id = $2`, [org, woId],
  )).rows[0];
  if (!wo) return { skipped: "unknown work order" };
  const rv = wo.data.review;
  if (!rv?.description?.body) return { skipped: "the review wrote no description" };
  if (rv.attempt !== attemptId) return { skipped: "a newer review replaced this one" };
  const stops = await coveringStops(deps.pool, org, { woId, projectId: wo.project_id, repoId: wo.repo_id, parentId: wo.parent_id });
  if (stops.length) return { skipped: `${stops[0]!.mode} at ${stops[0]!.scopeType} scope` };
  const pr = (await deps.pool.query<{ number: number; head_sha: string | null }>(`select number, head_sha from pull_requests where org_id = $1 and wo_id = $2 and state = 'open' order by number desc limit 1`, [org, woId])).rows[0];
  if (!pr) return { skipped: "the work order has no open pull request" };
  const repo = await loadRepo(deps.pool, org, wo.repo_id);
  if (!repo?.full) throw new PermanentError("The work order's repository has no GitHub identity.", "no_repo");
  const verdict = rv.verdict === "approve" ? "approved by the Review agent" : rv.verdict === "changes_requested" ? "the Review agent requested changes" : "reviewed";
  const body = `${rv.description.body.trim()}\n\n---\nGantry work order ${woId}${rv.headSha ? ` · reviewed at ${rv.headSha.slice(0, 7)}` : ""} · ${verdict}.`;
  const res = await deps.broker.describePr({ woId, repo: repo.full, number: pr.number, ...(rv.description.title ? { title: rv.description.title } : {}), body });
  if (!res.ok) return { skipped: res.code, msg: res.msg };
  await withTx(deps.pool, (tx) => recordEvent(tx, {
    orgId: org, type: "github.pr.described", category: "integrations", subject: { type: "wo", id: woId }, woId, projectId: wo.project_id,
    after: { repo: repo.full, number: pr.number, changed: res.changed, redacted: res.redacted, attempt: attemptId }, idempotencyKey: `pr.described:${woId}:${attemptId}`,
  }));
  return { described: true, changed: res.changed, redacted: res.redacted };
}
