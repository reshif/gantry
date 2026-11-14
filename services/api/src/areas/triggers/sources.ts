/**
 * Where trigger events come from (spec 11.7). GitHub reports labelled issues, pull request comments and failing default-branch builds. They reach triggers two ways:
 *   - the facts the broker polls and the webhook processor stores: `github.issue.labelled` and `github.check.changed` events, seen by an event observer;
 *   - webhook payloads that carry no stored fact (a PR comment, a workflow or suite that failed), offered from `processGithubDelivery`.
 * Both only enqueue a `trigger.evaluate` job: the event is a hint, evaluation is a job (retried, deduplicated by the event's identity per trigger).
 */
import { addEventObserver, enqueue, type EventInput, type Queryable, type Tx } from "@gantry/db";
import { job, type JobPayloadInput } from "../../core/jobs-contract.js";
import { obj } from "../../core/read/rows.js";
import { resolveRepo } from "./run.js";

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const FAILED = new Set(["failure", "timed_out", "startup_failure", "cancelled_by_policy"]);

type Eval = JobPayloadInput<"trigger.evaluate">;

async function offer(tx: Tx, orgId: string, input: Eval): Promise<void> {
  const j = job("trigger.evaluate", input, { dedupeKey: `trigger.evaluate:${input.dedupeKey}` });
  await enqueue(tx, { orgId, ...j });
}

/** What a webhook payload means to triggers. Pure: no repository lookup (the evaluation job resolves it). */
export function triggerInputsFromWebhook(event: string, payload: Json, repoId: string): Eval[] {
  const repoFull = str(obj(payload.repository).full_name) ?? repoId;
  const defaultBranch = str(obj(payload.repository).default_branch);
  if (event === "issue_comment") {
    const c = obj(payload.comment);
    const issue = obj(payload.issue);
    // Only comments on pull requests, only when created, and never Gantry's own or another bot's (a reply must not trigger a loop).
    if (payload.action !== "created" || !issue.pull_request || obj(c.user).type === "Bot") return [];
    const id = c.id;
    if (typeof id !== "number" && typeof id !== "string") return [];
    return [{
      kind: "comment", repo: repoId, comment: str(c.body) ?? "", author: str(obj(c.user).login) ?? undefined, ref: `${repoFull}#${String(issue.number)}`,
      ...(str(c.html_url) ? { url: str(c.html_url)! } : {}), dedupeKey: `gh:comment:${repoId}:${String(id)}`,
    }];
  }
  const failing = (conclusion: unknown): boolean => typeof conclusion === "string" && FAILED.has(conclusion);
  const onDefault = (branch: unknown): boolean => !!defaultBranch && branch === defaultBranch;
  if (event === "workflow_run") {
    const r = obj(payload.workflow_run);
    if (payload.action !== "completed" || !failing(r.conclusion) || !onDefault(r.head_branch) || !str(r.head_sha)) return [];
    return [{ kind: "ci", repo: repoId, check: str(r.name) ?? "workflow", ref: `${repoFull}@${str(r.head_sha)!.slice(0, 7)}`, ...(str(r.html_url) ? { url: str(r.html_url)! } : {}), dedupeKey: `gh:ci:${repoId}:${str(r.head_sha)!}` }];
  }
  if (event === "check_suite") {
    const r = obj(payload.check_suite);
    if (payload.action !== "completed" || !failing(r.conclusion) || !onDefault(r.head_branch) || !str(r.head_sha)) return [];
    return [{ kind: "ci", repo: repoId, check: str(obj(r.app).name) ?? "checks", ref: `${repoFull}@${str(r.head_sha)!.slice(0, 7)}`, dedupeKey: `gh:ci:${repoId}:${str(r.head_sha)!}` }];
  }
  if (event === "check_run") {
    const r = obj(payload.check_run);
    if (payload.action !== "completed" || !failing(r.conclusion) || !onDefault(obj(r.check_suite).head_branch) || !str(r.head_sha)) return [];
    return [{ kind: "ci", repo: repoId, check: str(r.name) ?? "check", ref: `${repoFull}@${str(r.head_sha)!.slice(0, 7)}`, ...(str(r.html_url) ? { url: str(r.html_url)! } : {}), dedupeKey: `gh:ci:${repoId}:${str(r.head_sha)!}` }];
  }
  return [];
}

/** Called by the webhook processor with a stored delivery's payload. */
export async function offerWebhookToTriggers(tx: Tx, orgId: string, event: string, payload: Json): Promise<number> {
  if (!["issue_comment", "workflow_run", "check_suite", "check_run"].includes(event)) return 0;
  const full = str(obj(payload.repository).full_name);
  if (!full) return 0;
  const repo = await resolveRepo(tx, orgId, full);
  if (!repo) return 0;
  const inputs = triggerInputsFromWebhook(event, payload, repo.id);
  for (const i of inputs) await offer(tx, orgId, i);
  return inputs.length;
}

/** The stored facts: a labelled issue, and a completed failing check on the commit the default branch points at. */
export async function offerEventToTriggers(tx: Tx, e: EventInput): Promise<void> {
  if (e.type !== "github.issue.labelled" && e.type !== "github.check.changed") return;
  const sub = e.subject;
  if (sub?.type !== "repo" || !sub.id) return;
  const a = obj(e.after);
  if (e.type === "github.issue.labelled") {
    const number = a.number;
    if (typeof number !== "number") return;
    const full = str(a.repo) ?? sub.id;
    await offer(tx, e.orgId, {
      kind: "issue", repo: sub.id, title: str(a.title) ?? "", labels: Array.isArray(a.labels) ? a.labels.filter((l): l is string => typeof l === "string") : [], ...(str(a.author) ? { author: str(a.author)! } : {}),
      ref: `${full}#${number}`, dedupeKey: `gh:issue:${sub.id}#${number}`,
    });
    return;
  }
  const sha = str(a.headSha);
  if (a.status !== "completed" || !failing(a.conclusion) || !sha) return;
  const cfg = (await tx.query<{ base: string | null }>(`select data ->> 'baseSha' as base from repo_config where org_id = $1 and repo_id = $2`, [e.orgId, sub.id])).rows[0];
  if (!cfg?.base || cfg.base !== sha) return; // not the commit the default branch points at
  await offer(tx, e.orgId, { kind: "ci", repo: sub.id, check: str(a.name) ?? "check", ref: `${sub.id}@${sha.slice(0, 7)}`, dedupeKey: `gh:ci:${sub.id}:${sha}` });
}
const failing = (c: unknown): boolean => typeof c === "string" && FAILED.has(c);

let installed: (() => void) | null = null;
/** Installs the observer once per process (the API and the worker both apply GitHub facts). */
export function registerTriggerSources(): void {
  installed?.();
  installed = addEventObserver((tx, e) => offerEventToTriggers(tx, e));
}
export const unregisterTriggerSources = (): void => {
  installed?.();
  installed = null;
};
export type { Queryable };
