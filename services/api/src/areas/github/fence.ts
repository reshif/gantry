/**
 * Fence checks for the GitHub broker (spec 4.4, 6.5, 8.11): before any write to GitHub the broker presents the attempt's fencing number
 * (or, for gate, merge and stop writes that belong to a work order rather than to an attempt, the work order). A superseded attempt,
 * a stopped scope or a repo mismatch is refused.
 */
import type { Queryable } from "@gantry/db";

/** Writes that make the world more restrictive stay possible under a stop: that is how a stop reaches GitHub (spec 11.2). */
export const RESTRICTIVE_PURPOSES = ["check_fail", "draft"] as const;
export const ATTEMPT_PURPOSES = ["publish"] as const;
export const WO_PURPOSES = ["pr", "check_pass", "check_pending", "merge", "check_fail", "draft"] as const;
export type FencePurpose = (typeof ATTEMPT_PURPOSES)[number] | (typeof WO_PURPOSES)[number];

export type FenceCode = "unknown" | "superseded" | "stopped" | "repo_mismatch" | "wo_closed";

export interface FenceOk { allow: true; woId: string; attemptId: string | null; projectId: string; repoId: string | null; repoName: string | null; githubFullName: string | null; branch: string; stopsIgnored: boolean }
export interface FenceDenied { allow: false; code: FenceCode; reason: string; woId: string | null; projectId: string | null }
export type FenceResult = FenceOk | FenceDenied;

interface Row {
  wo_id: string; project_id: string; repo_id: string | null; parent_id: string | null; wo_state: string; repo_name: string | null; github_full_name: string | null; branch_prefix: string | null;
  attempt_id?: string; fencing?: string; attempt_state?: string;
}

const sameRepo = (r: Row, given: string): boolean => {
  const g = given.toLowerCase();
  return [r.github_full_name, r.repo_name].some((n) => n && (n.toLowerCase() === g || g.endsWith(`/${n.toLowerCase()}`)));
};

async function stopFor(db: Queryable, orgId: string, r: Row): Promise<string | null> {
  const { rows } = await db.query<{ scope_type: string; mode: string; reason: string }>(
    `select scope_type, mode, reason from stops where org_id = $1 and lifted_at is null
        and (scope_type = 'factory' or (scope_type = 'project' and project_id = $2) or (scope_type = 'repo' and repo_id = $3) or (scope_type = 'wo' and (wo_id = $4 or wo_id = $5)))
      order by (mode = 'kill') desc, set_at limit 1`,
    [orgId, r.project_id, r.repo_id, r.wo_id, r.parent_id],
  );
  const s = rows[0];
  return s ? `${s.mode === "kill" ? "Killed" : "Halted"} at ${s.scope_type} scope${s.reason ? `: ${s.reason}` : "."}` : null;
}

const SELECT = `select w.id as wo_id, w.project_id, w.repo_id, w.parent_id, w.state as wo_state, r.name as repo_name, r.github_full_name, c.branch_prefix`;
const JOIN = `from work_orders w left join repos r on r.org_id = w.org_id and r.id = w.repo_id left join repo_config c on c.org_id = r.org_id and c.repo_id = r.id`;

function finish(r: Row, attemptId: string | null, stopMsg: string | null, purpose: FencePurpose, repo: string | undefined): FenceResult {
  const deny = (code: FenceCode, reason: string): FenceDenied => ({ allow: false, code, reason, woId: r.wo_id, projectId: r.project_id });
  if (repo && !sameRepo(r, repo)) return deny("repo_mismatch", `Work order ${r.wo_id} does not belong to repository ${repo}.`);
  const restrictive = (RESTRICTIVE_PURPOSES as readonly string[]).includes(purpose);
  if (stopMsg && !restrictive) return deny("stopped", stopMsg);
  if (!restrictive && ["killed", "declined"].includes(r.wo_state)) return deny("wo_closed", `Work order ${r.wo_id} is ${r.wo_state}.`);
  return { allow: true, woId: r.wo_id, attemptId, projectId: r.project_id, repoId: r.repo_id, repoName: r.repo_name, githubFullName: r.github_full_name, branch: `${r.branch_prefix ?? "gantry/"}${r.wo_id}`, stopsIgnored: !!stopMsg };
}

/** The attempt route: the fencing number must be the attempt's current one and the attempt must be live (a finished run is still publishable). */
export async function fenceAttempt(db: Queryable, orgId: string, attemptId: string, fencing: number, purpose: FencePurpose, repo?: string): Promise<FenceResult> {
  const { rows } = await db.query<Row>(
    `${SELECT}, a.id as attempt_id, a.fencing::text as fencing, a.state as attempt_state ${JOIN.replace("from work_orders w", "from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id")} where a.org_id = $1 and a.id = $2`,
    [orgId, attemptId],
  );
  const r = rows[0];
  if (!r) return { allow: false, code: "unknown", reason: `No attempt ${attemptId}.`, woId: null, projectId: null };
  const deny = (code: FenceCode, reason: string): FenceDenied => ({ allow: false, code, reason, woId: r.wo_id, projectId: r.project_id });
  if (String(r.fencing) !== String(fencing)) return deny("superseded", "This attempt was superseded by a newer one (fencing number changed).");
  if (!["running", "succeeded"].includes(r.attempt_state ?? "")) return deny("superseded", `The attempt is ${r.attempt_state}, not current.`);
  // Spec 4.4 step 2: a live attempt is superseded by any stop in its scope set after it began, even one lifted since (the engine's attemptIsCurrent rule).
  // A succeeded attempt finished before such a stop, so its re-publish is judged by the stops in force only.
  const stopMsg = await stopFor(db, orgId, r);
  if (r.attempt_state === "running" && !stopMsg) {
    const sup = await db.query(
      `select 1 from stops where org_id = $1 and fencing > $2
          and (scope_type = 'factory' or (scope_type = 'project' and project_id = $3) or (scope_type = 'repo' and repo_id = $4) or (scope_type = 'wo' and (wo_id = $5 or wo_id = $6))) limit 1`,
      [orgId, r.fencing, r.project_id, r.repo_id, r.wo_id, r.parent_id],
    );
    if (sup.rowCount) return deny("superseded", "A stop superseded this attempt (fencing number).");
  }
  return finish(r, attemptId, stopMsg, purpose, repo);
}

/** The work-order route, for gate, merge and stop-enforcement writes. */
export async function fenceWorkOrder(db: Queryable, orgId: string, woId: string, purpose: FencePurpose, repo?: string): Promise<FenceResult> {
  const { rows } = await db.query<Row>(`${SELECT} ${JOIN} where w.org_id = $1 and w.id = $2`, [orgId, woId]);
  const r = rows[0];
  if (!r) return { allow: false, code: "unknown", reason: `No work order ${woId}.`, woId: null, projectId: null };
  return finish(r, null, await stopFor(db, orgId, r), purpose, repo);
}
