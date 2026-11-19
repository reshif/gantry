import { createHash } from "node:crypto";
import type { Queryable } from "@gantry/db";
import { PermanentError } from "../errors.js";

/** Deterministic run id for an attempt, so a retried dispatch finds its own run. Matches the launcher's id pattern. */
export const runIdFor = (attemptId: string): string => `r-${createHash("sha256").update(attemptId).digest("hex").slice(0, 24)}`;
export const volumeFor = (runId: string): string => `ws-${runId}`;

export interface AttemptInfo {
  orgId: string;
  attemptId: string;
  fencing: number;
  state: string;
  station: string;
  woId: string;
  projectId: string;
  repoId: string | null;
  parentId: string | null;
  title: string;
  woData: Record<string, unknown>;
  attemptData: Record<string, unknown>;
  tupleId: string | null;
  repo: RepoInfo | null;
}

export interface RepoInfo {
  id: string;
  /** owner/name when the repository has a GitHub identity (repos.github_full_name, or a name containing a slash). */
  full: string | null;
  defaultBranch: string;
  branchPrefix: string;
  mergeStrategy: "squash" | "merge" | "rebase";
}

export async function loadRepo(db: Queryable, orgId: string, repoId: string | null): Promise<RepoInfo | null> {
  if (!repoId) return null;
  const { rows } = await db.query<{ id: string; name: string; github_full_name: string | null; default_branch: string | null; branch_prefix: string | null; merge_strategy: "squash" | "merge" | "rebase" | null }>(
    `select r.id, r.name, r.github_full_name, c.default_branch, c.branch_prefix, c.merge_strategy
       from repos r left join repo_config c on c.org_id = r.org_id and c.repo_id = r.id where r.org_id = $1 and r.id = $2`,
    [orgId, repoId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    full: r.github_full_name ?? (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.name) ? r.name : null),
    defaultBranch: r.default_branch ?? "main",
    branchPrefix: r.branch_prefix ?? "gantry/",
    mergeStrategy: r.merge_strategy ?? "squash",
  };
}

export async function loadAttempt(db: Queryable, orgId: string, attemptId: string): Promise<AttemptInfo | null> {
  const { rows } = await db.query<{
    id: string; fencing: string; state: string; station: string; wo_id: string; tuple_id: string | null; a_data: Record<string, unknown>;
    project_id: string; repo_id: string | null; parent_id: string | null; title: string; w_data: Record<string, unknown>;
  }>(
    `select a.id, a.fencing::text as fencing, a.state, a.station, a.wo_id, a.tuple_id, a.data as a_data, w.project_id, w.repo_id, w.parent_id, w.title, w.data as w_data
       from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id where a.org_id = $1 and a.id = $2`,
    [orgId, attemptId],
  );
  const a = rows[0];
  if (!a) return null;
  return {
    orgId, attemptId: a.id, fencing: Number(a.fencing), state: a.state, station: a.station, woId: a.wo_id, projectId: a.project_id, repoId: a.repo_id, parentId: a.parent_id,
    title: a.title, woData: a.w_data ?? {}, attemptData: a.a_data ?? {}, tupleId: a.tuple_id, repo: await loadRepo(db, orgId, a.repo_id),
  };
}

export interface ActiveStop { id: string; scopeType: string; mode: "halt" | "kill" }

/** Stops that cover a work order (its factory, project, repo, itself or its epic), kill before halt. */
export async function coveringStops(db: Queryable, orgId: string, w: { woId: string; projectId: string; repoId: string | null; parentId: string | null }): Promise<ActiveStop[]> {
  const { rows } = await db.query<{ id: string; scope_type: string; mode: "halt" | "kill" }>(
    `select id, scope_type, mode from stops where org_id = $1 and lifted_at is null
       and (scope_type = 'factory' or (scope_type = 'project' and project_id = $2) or (scope_type = 'repo' and repo_id = $3) or (scope_type = 'wo' and (wo_id = $4 or wo_id = $5)))
     order by (mode = 'kill') desc, set_at`,
    [orgId, w.projectId, w.repoId, w.woId, w.parentId],
  );
  return rows.map((r) => ({ id: r.id, scopeType: r.scope_type, mode: r.mode }));
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * The branch whose head is the base of this work order's change, or null when there is no change yet to compare (a first Build, Spec, Plan, onboarding, evals).
 * With a pull request it is the branch the pull request targets; with only published commits it is the repository's default branch. The broker fetches that
 * head into the workspace so `git diff <base>...<head>` works offline in the runner.
 */
export async function resolveSeedBase(db: Queryable, orgId: string, woId: string, defaultBranch: string): Promise<string | null> {
  const pr = (await db.query<{ base_branch: string | null }>(`select base_branch from pull_requests where org_id = $1 and wo_id = $2 and state = 'open' and head_sha is not null order by number desc limit 1`, [orgId, woId])).rows[0];
  if (pr) return pr.base_branch || defaultBranch;
  const c = (await db.query(`select 1 from commits where org_id = $1 and wo_id = $2 limit 1`, [orgId, woId])).rowCount;
  return c ? defaultBranch : null;
}

export type SeedSource = "eval_pin" | "pr_head" | "wo_commit" | "default_head" | "base_sha";

export interface SeedChoice {
  commit: string;
  source: SeedSource;
  /** Why this commit, in a sentence: recorded on the run and shown with it. */
  why: string;
}

/** The commit a workspace is seeded at, decided from what is stored (no network): the head of the work order's pull request, its latest published commit, else the recorded base commit. */
export async function storedSeedChoice(db: Queryable, orgId: string, woId: string, repoId: string): Promise<SeedChoice> {
  // An eval case is pinned to the snapshot it was written against (spec 13.2), not to whatever the repository's head is now.
  const pinned = (await db.query<{ c: string | null }>(`select coalesce(data->'eval'->>'commit', data->'onboarding'->>'commit') as c from work_orders where org_id = $1 and id = $2 and source in ('eval','onboarding')`, [orgId, woId])).rows[0]?.c;
  if (pinned && SHA.test(pinned)) return { commit: pinned, source: "eval_pin", why: "The snapshot this eval case or onboarding step was written against." };
  const pr = (await db.query<{ head_sha: string | null }>(`select head_sha from pull_requests where org_id = $1 and wo_id = $2 and state = 'open' and head_sha is not null order by number desc limit 1`, [orgId, woId])).rows[0];
  if (pr?.head_sha && SHA.test(pr.head_sha)) return { commit: pr.head_sha, source: "pr_head", why: "The head of this work order's open pull request." };
  const c = (await db.query<{ sha: string }>(`select sha from commits where org_id = $1 and wo_id = $2 order by committed_at desc nulls last, created_at desc limit 1`, [orgId, woId])).rows[0];
  if (c && SHA.test(c.sha)) return { commit: c.sha, source: "wo_commit", why: "The latest commit published for this work order." };
  const r = (await db.query<{ cfg: string | null; repo: string | null }>(
    `select (select data->>'baseSha' from repo_config where org_id = $1 and repo_id = $2) as cfg, (select data->>'baseSha' from repos where org_id = $1 and id = $2) as repo`,
    [orgId, repoId],
  )).rows[0];
  for (const v of [r?.cfg, r?.repo]) if (v && SHA.test(v)) return { commit: v, source: "base_sha", why: "The commit recorded for the repository." };
  throw new PermanentError("No commit is recorded for this repository, so the workspace cannot be seeded. Run onboarding or a reconcile first.", "no_commit");
}

/**
 * The commit a workspace is seeded at (spec 4.3 step 2): the head of the work order's pull request, else its latest published commit, else the commit recorded for the
 * repository (repo_config.data.baseSha / repos.data.baseSha, kept current by the push webhook, the poll and dispatch).
 */
export async function resolveSeedCommit(db: Queryable, orgId: string, woId: string, repoId: string): Promise<string> {
  return (await storedSeedChoice(db, orgId, woId, repoId)).commit;
}

export interface FreshenDeps {
  broker: { defaultHead(repo: string): Promise<{ ok: true; branch: string; sha: string } | { ok: false; code: string; msg: string }> };
  now: () => Date;
  staleMs: number;
}

/**
 * Like `storedSeedChoice`, but a work order that has no commit of its own starts from the repository's default branch as it is now (S-140): when the recorded base
 * commit is older than `staleMs` (or has no recorded time, as onboarding writes it), the default branch head is asked of GitHub through the broker and recorded on the
 * repository, so the first stations see merged work and the current AGENTS.md. A broker that cannot answer leaves the recorded commit in use, and the reason is said.
 */
export async function chooseSeedCommit(db: Queryable, orgId: string, woId: string, repo: { id: string; full: string | null }, d: FreshenDeps): Promise<SeedChoice> {
  const stored = await storedSeedChoice(db, orgId, woId, repo.id);
  if (stored.source !== "base_sha" || !repo.full) return stored;
  const at = (await db.query<{ at: string | null }>(`select data->>'baseAt' as at from repo_config where org_id = $1 and repo_id = $2`, [orgId, repo.id])).rows[0]?.at;
  const age = at ? d.now().getTime() - Date.parse(at) : Number.POSITIVE_INFINITY;
  if (age <= d.staleMs) return { ...stored, why: `The repository's default branch head, recorded ${Math.max(0, Math.round(age / 60_000))} min ago (within ${Math.round(d.staleMs / 60_000)} min).` };
  const head = await d.broker.defaultHead(repo.full).catch((e: unknown) => ({ ok: false as const, code: "unreachable", msg: e instanceof Error ? e.message : String(e) }));
  if (!head.ok) return { ...stored, why: `The recorded base commit${at ? ` (from ${at})` : " (no time recorded)"}; asking GitHub for the default branch head failed (${head.code}: ${head.msg.slice(0, 160)}).` };
  await db.query(
    `update repo_config set data = data || jsonb_build_object('baseSha', $3::text, 'baseBranch', $4::text, 'baseAt', $5::text), updated_at = now() where org_id = $1 and repo_id = $2`,
    [orgId, repo.id, head.sha, head.branch, d.now().toISOString()],
  );
  return { commit: head.sha, source: "default_head", why: `The default branch ${head.branch} head, read from GitHub at dispatch because the recorded base commit was ${at ? `${Math.round(age / 60_000)} min old` : "of unknown age"}${head.sha === stored.commit ? " (unchanged)" : ` (it was ${stored.commit.slice(0, 12)})`}.` };
}
