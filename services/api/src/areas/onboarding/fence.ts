/**
 * The fence for the GitHub broker's repository-level onboarding writes (spec 4.4, 11.3). These belong to no work order, so the work-order fence does not apply:
 * the broker names the repository and what it is about to do. A kill (factory or project) refuses everything; a halt refuses only the merge, as the decision point does
 * for `onboarding.merge`; an archived project refuses everything. A halt Gantry raised itself for readiness never blocks the canary or the pull request, because
 * those are how readiness is regained.
 */
import type { Queryable } from "@gantry/db";

export type OnboardingFencePurpose = "write" | "merge" | "canary";
export type OnboardingFence = { allow: true; repoId: string; projectId: string } | { allow: false; code: "unknown" | "stopped" | "archived"; reason: string; repoId: string | null; projectId: string | null };

export async function fenceOnboarding(db: Queryable, orgId: string, repo: string, purpose: OnboardingFencePurpose): Promise<OnboardingFence> {
  const r = (await db.query<{ id: string; project_id: string; name: string; status: string }>(
    `select r.id, r.project_id, r.name, p.status from repos r join projects p on p.org_id = r.org_id and p.id = r.project_id
      where r.org_id = $1 and (lower(r.github_full_name) = lower($2) or lower(r.name) = lower($2)) limit 1`,
    [orgId, repo],
  )).rows[0];
  if (!r) return { allow: false, code: "unknown", reason: `${repo} is not connected to Gantry.`, repoId: null, projectId: null };
  const deny = (code: "stopped" | "archived", reason: string): OnboardingFence => ({ allow: false, code, reason, repoId: r.id, projectId: r.project_id });
  if (r.status === "archived") return deny("archived", `The project is archived; ${r.name} is read-only.`);
  const { rows } = await db.query<{ scope_type: string; mode: string; reason: string; cause: string }>(
    `select scope_type, mode, reason, cause from stops where org_id = $1 and lifted_at is null
        and (scope_type = 'factory' or (scope_type = 'project' and project_id = $2) or (scope_type = 'repo' and repo_id = $3))
      order by (mode = 'kill') desc, set_at`,
    [orgId, r.project_id, r.id],
  );
  const hit = rows.find((s) => s.mode === "kill") ?? (purpose === "merge" ? rows.find((s) => s.cause !== "readiness") : undefined);
  return hit ? deny("stopped", `${hit.mode === "kill" ? "Killed" : "Halted"} at ${hit.scope_type} scope${hit.reason ? `: ${hit.reason}` : "."}`) : { allow: true, repoId: r.id, projectId: r.project_id };
}
