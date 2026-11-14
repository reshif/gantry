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
 * The commit a workspace is seeded at (spec 4.3 step 2): the head of the work order's pull request, else its latest published commit,
 * else the commit recorded for the repository (repo_config.data.baseSha / repos.data.baseSha, written by onboarding and reconciliation).
 */
export async function resolveSeedCommit(db: Queryable, orgId: string, woId: string, repoId: string): Promise<string> {
  const pr = (await db.query<{ head_sha: string | null }>(`select head_sha from pull_requests where org_id = $1 and wo_id = $2 and state = 'open' and head_sha is not null order by number desc limit 1`, [orgId, woId])).rows[0];
  if (pr?.head_sha && SHA.test(pr.head_sha)) return pr.head_sha;
  const c = (await db.query<{ sha: string }>(`select sha from commits where org_id = $1 and wo_id = $2 order by committed_at desc nulls last, created_at desc limit 1`, [orgId, woId])).rows[0];
  if (c && SHA.test(c.sha)) return c.sha;
  const r = (await db.query<{ cfg: string | null; repo: string | null }>(
    `select (select data->>'baseSha' from repo_config where org_id = $1 and repo_id = $2) as cfg, (select data->>'baseSha' from repos where org_id = $1 and id = $2) as repo`,
    [orgId, repoId],
  )).rows[0];
  for (const v of [r?.cfg, r?.repo]) if (v && SHA.test(v)) return v;
  throw new PermanentError("No commit is recorded for this repository, so the workspace cannot be seeded. Run onboarding or a reconcile first.", "no_commit");
}
