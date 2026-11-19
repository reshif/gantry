/**
 * Storing GitHub facts (spec 7.3 Code, 11.4, 11.6): pull requests, commits with their per-file stats and patches, checks, reviews and labelled issues
 * are copied from GitHub keyed by GitHub ids. Gantry is not the system of record for code, so every write is an idempotent upsert, and any difference
 * between what Gantry believed and what GitHub reports is recorded as a `github.drift` event (the stored value is then corrected).
 */
import { createHash } from "node:crypto";
import type { Tx } from "@gantry/db";
import { checkMatches } from "@gantry/domain";
import type { EventSpec } from "../../core/command.js";
import { parkMergeBlocked, recheckAutoGate, recordMerged, recordNewHead } from "../workorders/station.js";
import type { CheckFact, GithubFacts, IssueFact, PublishedCommitFact, PullRequestFact, ReviewFact } from "./facts.js";

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export interface ApplyResult {
  events: EventSpec[];
  /** Legacy store slices to notify (SSE). */
  changes: string[];
  counts: { pullRequests: number; commits: number; checks: number; reviews: number; issues: number; drift: number };
  /** Repo not known to Gantry: nothing was stored. */
  unknownRepo?: boolean;
  /** Pull requests that merged on GitHub and closed the merge intent. */
  merged: number[];
}

interface RepoRow { id: string; project_id: string }

export async function findRepo(tx: Pick<Tx, "query">, orgId: string, full: string): Promise<RepoRow | null> {
  const short = full.split("/")[1] ?? full;
  const { rows } = await tx.query<RepoRow>(
    `select id, project_id from repos where org_id = $1 and (github_full_name = $2 or lower(name) = lower($2) or lower(name) = lower($3))
      order by (github_full_name = $2) desc nulls last limit 1`,
    [orgId, full, short],
  );
  return rows[0] ?? null;
}

const woFromBranch = (branch: string | null | undefined, prefix: string): string | null => (branch && branch.startsWith(prefix) && branch.length > prefix.length ? branch.slice(prefix.length) : null);

async function repoBranchPrefix(tx: Tx, orgId: string, repoId: string): Promise<string> {
  const { rows } = await tx.query<{ branch_prefix: string }>(`select branch_prefix from repo_config where org_id = $1 and repo_id = $2`, [orgId, repoId]);
  return rows[0]?.branch_prefix ?? "gantry/";
}

/** Applies one batch of facts inside the caller's transaction. */
export async function applyFacts(tx: Tx, orgId: string, f: GithubFacts, o: { now?: Date } = {}): Promise<ApplyResult> {
  const out: ApplyResult = { events: [], changes: [], counts: { pullRequests: 0, commits: 0, checks: 0, reviews: 0, issues: 0, drift: 0 }, merged: [] };
  const repo = await findRepo(tx, orgId, f.repo);
  if (!repo) return { ...out, unknownRepo: true };
  const prefix = await repoBranchPrefix(tx, orgId, repo.id);
  const sub = { type: "repo", id: repo.id };
  const touched = new Set<string>();

  if (f.base) {
    // Quiet bookkeeping (no event): the worker seeds new workspaces from repo_config.data.baseSha when a work order has no commit of its own. `baseAt` is when the
    // commit was last confirmed, so dispatch can tell a recorded commit that is fresh from one that has to be checked against GitHub (S-140).
    await tx.query(
      `update repo_config set data = data || jsonb_build_object('baseSha', $3::text, 'baseBranch', $4::text, 'baseAt', $5::text), updated_at = now()
        where org_id = $1 and repo_id = $2`,
      [orgId, repo.id, f.base.sha, f.base.branch, (o.now ?? new Date()).toISOString()],
    );
  }

  if (f.publish) {
    const p = f.publish;
    const wo = await woExists(tx, orgId, p.woId);
    const prId = p.prNumber ? prIdOf(repo.id, p.prNumber) : null;
    for (const c of p.commits) {
      if (await storeCommit(tx, orgId, repo.id, wo ? p.woId : null, prId, c)) {
        out.counts.commits++;
        out.events.push({ type: "github.commit.published", category: "integrations", subject: { type: "commit", id: c.sha }, projectId: repo.project_id, woId: wo ? p.woId : null,
          after: { repo: f.repo, sha: c.sha, localSha: c.localSha, branch: p.branch, attemptId: p.attemptId, files: c.files.length, additions: c.files.reduce((n, x) => n + x.additions, 0), deletions: c.files.reduce((n, x) => n + x.deletions, 0) } });
      }
    }
    if (out.counts.commits) touched.add("code");
  }

  for (const pr of f.pullRequests) {
    const r = await storePullRequest(tx, orgId, repo, f.repo, prefix, pr, f.source, o.now);
    out.events.push(...r.events);
    out.counts.pullRequests += r.changed ? 1 : 0;
    out.counts.drift += r.drift;
    if (r.merged) out.merged.push(pr.number);
    if (r.changed) touched.add("workOrders");
  }

  const settled = new Set<string>();
  for (const c of f.checks) {
    const ev = await storeCheck(tx, orgId, repo.id, c);
    if (ev) { out.events.push({ ...ev, projectId: repo.project_id, subject: sub }); out.counts.checks++; touched.add("workOrders"); if (c.status === "completed") settled.add(c.headSha); }
  }
  // A finished check is evidence for an automatic gate that is waiting on this head (G4 reads the real CI results).
  for (const sha of settled) {
    const prs = (await tx.query<{ wo_id: string }>(`select wo_id from pull_requests where org_id = $1 and repo_id = $2 and head_sha = $3 and state = 'open' and wo_id is not null`, [orgId, repo.id, sha])).rows;
    for (const p of prs) if ((await recheckAutoGate(tx, orgId, p.wo_id, sha, o.now ? { now: o.now } : {})).reopened) touched.add("workOrders");
  }

  for (const rv of f.reviews) {
    const ev = await storeReview(tx, orgId, repo.id, rv);
    if (ev) { out.events.push({ ...ev, projectId: repo.project_id, subject: sub }); out.counts.reviews++; touched.add("workOrders"); }
  }

  for (const is of f.issues) {
    const ev = await storeIssue(tx, orgId, f.repo, is);
    if (ev) { out.events.push({ ...ev, projectId: repo.project_id, subject: sub }); out.counts.issues++; }
  }

  out.changes = [...touched];
  return out;
}

const woExists = async (tx: Tx, orgId: string, woId: string): Promise<boolean> => !!(await tx.query(`select 1 from work_orders where org_id = $1 and id = $2`, [orgId, woId])).rowCount;
export const prIdOf = (repoId: string, n: number): string => `pr-${repoId}-${n}`;
const ts = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);

// ---------------------------------------------------------------- commits

/** Returns true when the commit was new. */
async function storeCommit(tx: Tx, orgId: string, repoId: string, woId: string | null, prId: string | null, c: PublishedCommitFact): Promise<boolean> {
  const id = `gh-${repoId}-${c.sha}`;
  const ins = await tx.query(
    `insert into commits (org_id, id, repo_id, sha, wo_id, pr_id, author, message, committed_at, local_sha, parent_shas)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (org_id, repo_id, sha) do update set pr_id = coalesce(excluded.pr_id, commits.pr_id), wo_id = coalesce(commits.wo_id, excluded.wo_id), updated_at = now()
     returning (xmax = 0) as inserted, id`,
    [orgId, id, repoId, c.sha, woId, prId, c.author ?? null, c.message, ts(c.committedAt), c.localSha, c.parents],
  );
  const row = ins.rows[0] as { inserted: boolean; id: string };
  if (!row.inserted) return false;
  let i = 0;
  for (const file of c.files) {
    await tx.query(`insert into changed_files (org_id, id, pr_id, commit_id, path, status, additions, deletions) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, id) do nothing`,
      [orgId, `${row.id}:${i++}`, prId, row.id, file.path, file.status, file.additions, file.deletions]);
  }
  const patch = Buffer.from(c.patch, "utf8");
  const hash = sha256(patch);
  await tx.query(`insert into github_blobs (org_id, hash, kind, content, size_bytes) values ($1,$2,'patch',$3,$4) on conflict do nothing`, [orgId, hash, patch, patch.length]);
  await tx.query(`insert into patches (org_id, id, wo_id, pr_id, commit_id, content_hash, size_bytes) values ($1,$2,$3,$4,$5,$6,$7) on conflict (org_id, id) do nothing`, [orgId, `pt-${row.id}`, woId, prId, row.id, hash, patch.length]);
  return true;
}

// ---------------------------------------------------------------- pull requests

async function storePullRequest(
  tx: Tx, orgId: string, repo: RepoRow, full: string, prefix: string, pr: PullRequestFact, source: string, now?: Date,
): Promise<{ events: EventSpec[]; changed: boolean; drift: number; merged: boolean }> {
  const id = prIdOf(repo.id, pr.number);
  const candidate = woFromBranch(pr.headBranch, prefix);
  const woId = candidate && (await woExists(tx, orgId, candidate)) ? candidate : null;
  const prev = (await tx.query<{ state: string; head_sha: string | null; draft: boolean; wo_id: string | null; seen: string | null }>(`select state, head_sha, draft, wo_id, data->>'sourceUpdatedAt' as seen from pull_requests where org_id = $1 and id = $2 for update`, [orgId, id])).rows[0];
  // S-63: webhooks are hints and the newest fact wins. A delivery older than what is stored changes nothing; a merged pull request is never set back, and a closed one is reopened only by
  // a delivery that is newer (a real reopen carries a newer updated_at).
  if (prev) {
    const at = pr.updatedAt ? Date.parse(pr.updatedAt) : NaN;
    const seen = prev.seen ? Date.parse(prev.seen) : NaN;
    const older = Number.isFinite(at) && Number.isFinite(seen) && at < seen;
    const backFromMerged = prev.state === "merged" && pr.state !== "merged";
    const reopenedStale = source === "hook" && prev.state === "closed" && pr.state === "open" && !(Number.isFinite(at) && (!Number.isFinite(seen) || at > seen));
    if (older || backFromMerged || reopenedStale) {
      return { events: [{ subject: { type: "pull_request", id: `${full}#${pr.number}` }, projectId: repo.project_id, woId: prev.wo_id, category: "integrations", type: "github.pull_request.stale_ignored", before: { state: prev.state, headSha: prev.head_sha }, after: { state: pr.state, headSha: pr.headSha, updatedAt: pr.updatedAt ?? null, seenUpdatedAt: prev.seen, source } }], changed: false, drift: 0, merged: false };
    }
  }
  const data = { labels: pr.labels, author: pr.author ?? null, mergeCommitSha: pr.mergeCommitSha ?? null, ...(pr.updatedAt ? { sourceUpdatedAt: pr.updatedAt } : {}) };
  await tx.query(
    `insert into pull_requests (org_id, id, repo_id, wo_id, number, github_id, title, state, draft, head_sha, base_branch, head_branch, url, merged_at, data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     on conflict (org_id, id) do update set wo_id = coalesce(excluded.wo_id, pull_requests.wo_id), github_id = coalesce(excluded.github_id, pull_requests.github_id), title = excluded.title, state = excluded.state, draft = excluded.draft,
       head_sha = excluded.head_sha, base_branch = excluded.base_branch, head_branch = excluded.head_branch, url = excluded.url, merged_at = excluded.merged_at, data = pull_requests.data || excluded.data, updated_at = now()`,
    [orgId, id, repo.id, woId, pr.number, pr.githubId ?? null, pr.title, pr.state, pr.draft, pr.headSha, pr.baseBranch ?? null, pr.headBranch ?? null, pr.url ?? null, ts(pr.mergedAt), JSON.stringify(data)],
  );
  const linked = woId ?? prev?.wo_id ?? null;
  const events: EventSpec[] = [];
  const subject = { type: "pull_request", id: `${full}#${pr.number}` };
  const base = { subject, projectId: repo.project_id, woId: linked, category: "integrations" as const };
  let drift = 0;
  const unchanged = prev && prev.state === pr.state && prev.head_sha === pr.headSha && prev.draft === pr.draft;
  if (!prev) events.push({ ...base, type: "github.pull_request.seen", after: { repo: full, number: pr.number, state: pr.state, headSha: pr.headSha, draft: pr.draft, source } });
  else if (!unchanged) events.push({ ...base, type: "github.pull_request.updated", before: { state: prev.state, headSha: prev.head_sha, draft: prev.draft }, after: { state: pr.state, headSha: pr.headSha, draft: pr.draft, source } });

  let merged = false;
  if (linked) {
    // A head commit that Gantry did not publish is a difference between the two systems (spec 11.6): record it, then let the flow engine reopen the gate on the new head.
    if (prev && pr.headSha && prev.head_sha !== pr.headSha && pr.state === "open") {
      const ours = (await tx.query(`select 1 from commits where org_id = $1 and repo_id = $2 and sha = $3 and wo_id is not null`, [orgId, repo.id, pr.headSha])).rowCount;
      if (!ours) {
        drift++;
        events.push({ ...base, type: "github.drift", outcome: "regression", before: { headSha: prev.head_sha }, after: { kind: "head_changed_outside_gantry", headSha: pr.headSha, number: pr.number, repo: full } });
      }
      await recordNewHead(tx, orgId, linked, pr.headSha, now ? { now } : {});
    }
    if (pr.state === "merged" && prev?.state !== "merged") {
      const r = await recordMerged(tx, orgId, linked, { prNumber: pr.number, ...(pr.mergeCommitSha ? { mergeSha: pr.mergeCommitSha } : {}), ...(now ? { now } : {}) });
      merged = r.applied;
      if (!r.applied) {
        drift++;
        events.push({ ...base, type: "github.drift", outcome: "regression", before: { state: prev?.state ?? null }, after: { kind: "merged_without_request", number: pr.number, repo: full, note: r.reason ?? null } });
      }
    } else if (pr.state === "closed" && prev && prev.state === "open") {
      drift++;
      events.push({ ...base, type: "github.drift", outcome: "regression", before: { state: "open" }, after: { kind: "closed_without_merge", number: pr.number, repo: full } });
      // An approved merge waiting on this pull request cannot happen: the order goes to Needs a person, with Retry merge.
      if (linked) await parkMergeBlocked(tx, orgId, linked, { prNumber: pr.number, reason: `Pull request #${pr.number} was closed without merging.`, ...(now ? { now } : {}) });
    }
  }
  return { events, changed: !unchanged, drift, merged };
}

// ---------------------------------------------------------------- checks, reviews, issues

async function storeCheck(tx: Tx, orgId: string, repoId: string, c: CheckFact): Promise<Omit<EventSpec, "subject" | "projectId"> | null> {
  const id = `ck-${repoId}-${c.headSha}-${sha256(c.name).slice(0, 12)}`;
  const prev = (await tx.query<{ status: string; conclusion: string | null }>(`select status, conclusion from checks where org_id = $1 and id = $2`, [orgId, id])).rows[0];
  const pr = (await tx.query<{ id: string }>(`select id from pull_requests where org_id = $1 and repo_id = $2 and head_sha = $3 order by number desc limit 1`, [orgId, repoId, c.headSha])).rows[0];
  const required = ((await tx.query<{ required_checks: string[] | null }>(`select required_checks from repo_config where org_id = $1 and repo_id = $2`, [orgId, repoId])).rows[0]?.required_checks ?? []).some((n) => checkMatches(n, c.name));
  await tx.query(
    `insert into checks (org_id, id, repo_id, pr_id, head_sha, name, status, conclusion, required, github_id, completed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (org_id, id) do update set pr_id = coalesce(excluded.pr_id, checks.pr_id), status = excluded.status, conclusion = excluded.conclusion, required = excluded.required, github_id = coalesce(excluded.github_id, checks.github_id), completed_at = excluded.completed_at, updated_at = now()`,
    [orgId, id, repoId, pr?.id ?? null, c.headSha, c.name, c.status, c.conclusion ?? null, required, c.githubId ?? null, ts(c.completedAt)],
  );
  if (prev && prev.status === c.status && prev.conclusion === (c.conclusion ?? null)) return null;
  return { type: "github.check.changed", category: "integrations", before: prev ? { status: prev.status, conclusion: prev.conclusion } : null, after: { name: c.name, headSha: c.headSha, status: c.status, conclusion: c.conclusion ?? null, required } };
}

async function storeReview(tx: Tx, orgId: string, repoId: string, r: ReviewFact): Promise<Omit<EventSpec, "subject" | "projectId"> | null> {
  const pr = (await tx.query<{ id: string; wo_id: string | null }>(`select id, wo_id from pull_requests where org_id = $1 and repo_id = $2 and number = $3`, [orgId, repoId, r.prNumber])).rows[0];
  if (!pr) return null;
  const id = `rv-${repoId}-${r.githubId ?? sha256(`${r.prNumber}:${r.reviewer}:${r.submittedAt}`).slice(0, 16)}`;
  const prev = (await tx.query<{ state: string }>(`select state from reviews where org_id = $1 and id = $2`, [orgId, id])).rows[0];
  await tx.query(
    `insert into reviews (org_id, id, pr_id, github_id, reviewer, state, body, submitted_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (org_id, id) do update set state = excluded.state, body = excluded.body, updated_at = now()`,
    [orgId, id, pr.id, r.githubId ?? null, r.reviewer, r.state, r.body, ts(r.submittedAt)],
  );
  if (prev && prev.state === r.state) return null;
  return { type: "github.review.recorded", category: "integrations", woId: pr.wo_id, before: prev ? { state: prev.state } : null, after: { prNumber: r.prNumber, reviewer: r.reviewer, state: r.state } };
}

/** A labelled issue is remembered by (repo, number, labels) in inbound_deliveries so a trigger sees each labelling once (spec 11.7); creating work from it is the trigger's job. */
async function storeIssue(tx: Tx, orgId: string, repo: string, i: IssueFact): Promise<Omit<EventSpec, "subject" | "projectId"> | null> {
  const labels = [...i.labels].sort();
  if (!labels.length) return null;
  const body = JSON.stringify({ repo, ...i, labels });
  const delivery = `${repo}#${i.number}:${sha256(labels.join(",")).slice(0, 12)}`;
  const hash = sha256(body);
  await tx.query(`insert into github_blobs (org_id, hash, kind, content, size_bytes) values ($1,$2,'payload',$3,$4) on conflict do nothing`, [orgId, hash, Buffer.from(body), Buffer.byteLength(body)]);
  const r = await tx.query(
    `insert into inbound_deliveries (org_id, id, source, delivery_id, event_type, payload_hash, status) values ($1,$2,'github-issue',$3,'issues.labelled',$4,'processed') on conflict (org_id, source, delivery_id) do nothing`,
    [orgId, `gh-issue-${hash.slice(0, 24)}`, delivery, hash],
  );
  if (!r.rowCount) return null;
  return { type: "github.issue.labelled", category: "integrations", after: { repo, number: i.number, title: i.title, labels, author: i.author ?? null } };
}
