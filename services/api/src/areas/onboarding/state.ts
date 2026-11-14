/**
 * Onboarding state of a repository (spec 11.3). The current view is the legacy `repo.onboarding` object, kept on `repos.data.onboarding` and changed only by the
 * functions here and in commands.ts / apply.ts, always in the same transaction as the event that explains the change. The history lives in the normalised tables:
 * `onboarding_runs` (one per assessment), `onboarding_findings`, `onboarding_prs` and `onboarding_verifications`. `repos.onboarding_stage` mirrors the stage so work
 * orders, metrics and the Floor can ask with one column.
 */
import type { Queryable, Tx } from "@gantry/db";
import type { OnboardFinding, RepoOnboarding, TimelineEntry } from "@gantry/domain";
import { notFound } from "../../core/errors.js";

export interface RepoRow {
  id: string;
  project_id: string;
  team_id: string | null;
  name: string;
  github_full_name: string | null;
  lang: string;
  tags: string[];
  onboarding_stage: string;
  ready_at: Date | null;
  data: Record<string, unknown>;
  version: number;
  default_branch: string | null;
  branch_prefix: string | null;
  merge_strategy: string | null;
  required_checks: string[] | null;
  protected_paths: string[] | null;
}

/** The onboarding document: the legacy shape plus the run it belongs to. */
export interface Doc extends RepoOnboarding {
  runId?: string;
}

export const REPO_SELECT = `select r.id, r.project_id, r.team_id, r.name, r.github_full_name, r.lang, r.tags, r.onboarding_stage, r.ready_at, r.data, r.version,
        c.default_branch, c.branch_prefix, c.merge_strategy, c.required_checks, c.protected_paths
   from repos r left join repo_config c on c.org_id = r.org_id and c.repo_id = r.id`;

/** The repo by id (or full name), locked for the rest of the transaction. */
export async function lockRepo(tx: Queryable, orgId: string, idOrName: string): Promise<RepoRow> {
  const { rows } = await tx.query<RepoRow>(`${REPO_SELECT} where r.org_id = $1 and (r.id = $2 or r.name = $2) order by (r.id = $2) desc limit 1 for update of r`, [orgId, idOrName]);
  const r = rows[0];
  if (!r) throw notFound("No such repo.");
  return r;
}

export async function readRepoRow(db: Queryable, orgId: string, idOrName: string): Promise<RepoRow | null> {
  const { rows } = await db.query<RepoRow>(`${REPO_SELECT} where r.org_id = $1 and (r.id = $2 or r.name = $2) order by (r.id = $2) desc limit 1`, [orgId, idOrName]);
  return rows[0] ?? null;
}

/** The repo's full name on GitHub, or null when it has no GitHub identity (a seeded demo repo). */
export const githubName = (r: Pick<RepoRow, "github_full_name">): string | null => r.github_full_name;

export const docOf = (r: Pick<RepoRow, "data">, now = Date.now()): Doc => {
  const d = r.data?.onboarding as Doc | undefined;
  return d && typeof d === "object"
    ? { ...d, findings: Array.isArray(d.findings) ? d.findings : [], timeline: Array.isArray(d.timeline) ? d.timeline : [], pr: d.pr ?? null, exception: d.exception ?? null }
    : { stage: "connected", findings: [], pr: null, timeline: [], exception: null, startedAt: now };
};

const MAX_TIMELINE = 300;

export const stamp = (doc: Doc, who: string, text: string, at: Date): void => {
  doc.timeline.push({ at: at.getTime(), who, text: text.slice(0, 1000) } satisfies TimelineEntry);
  if (doc.timeline.length > MAX_TIMELINE) doc.timeline.splice(0, doc.timeline.length - MAX_TIMELINE);
};

/** Writes the document and the stage column together, bumps the repo version, and keeps the project's status in step with its repos. */
export async function saveDoc(tx: Tx, orgId: string, r: RepoRow, doc: Doc, o: { lang?: string } = {}): Promise<number> {
  const readyAt = doc.stage === "ready" ? (doc.readyAt ? new Date(doc.readyAt) : (r.ready_at ?? new Date())) : null;
  const { rows } = await tx.query<{ version: number }>(
    `update repos set data = coalesce(data, '{}'::jsonb) || jsonb_build_object('onboarding', $3::jsonb), onboarding_stage = $4, ready_at = $5, lang = coalesce($6, lang), version = version + 1, updated_at = now()
      where org_id = $1 and id = $2 returning version`,
    [orgId, r.id, JSON.stringify(doc), doc.stage, readyAt, o.lang ?? null],
  );
  await syncProjectStatus(tx, orgId, r.project_id);
  return rows[0]!.version;
}

/** A project with repos is `onboarding` until every one is Ready, then `active`. An archived project and an `active` one that gains a repo are left alone. */
export async function syncProjectStatus(tx: Tx, orgId: string, projectId: string): Promise<void> {
  const { rows } = await tx.query<{ status: string; total: string; ready: string }>(
    `select p.status, (select count(*) from repos r where r.org_id = p.org_id and r.project_id = p.id) as total,
            (select count(*) from repos r where r.org_id = p.org_id and r.project_id = p.id and r.onboarding_stage = 'ready') as ready
       from projects p where p.org_id = $1 and p.id = $2`,
    [orgId, projectId],
  );
  const p = rows[0];
  if (!p || p.status === "archived") return;
  const total = Number(p.total), ready = Number(p.ready);
  const next = p.status === "new" && total > 0 ? "onboarding" : p.status === "onboarding" && total > 0 && ready === total ? "active" : p.status;
  if (next !== p.status) await tx.query(`update projects set status = $3, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [orgId, projectId, next]);
}

export const isBusy = (d: Doc): boolean => !!d.busy;
export const BUSY_TEXT: Record<NonNullable<Doc["busy"]>, string> = {
  assessing: "The assessment is running", opening_pr: "The onboarding PR is being opened", updating_pr: "The onboarding PR is being updated", merging: "The merge is being requested", verifying: "Verification is running",
};

/** Findings a pull request can fix: a gap with a file to add or edit. Manual gaps (an admin must act) are not among them. The Gantry config file is always the PR's to add. */
export const fixableGaps = (findings: OnboardFinding[]): OnboardFinding[] => findings.filter((f) => !f.ok && !!f.file && !f.manual);

/* ------------------------------------------------------------------ runs, findings, pull requests ---- */

export async function startRun(tx: Tx, orgId: string, repoId: string, by: string, o: { guidelines: { org: number; project: number } }): Promise<string> {
  const n = Number((await tx.query<{ n: string }>(`select count(*)::text as n from onboarding_runs where org_id = $1 and repo_id = $2`, [orgId, repoId])).rows[0]!.n) + 1;
  const id = `onb-${repoId}-${n}`;
  await tx.query(
    `insert into onboarding_runs (org_id, id, repo_id, status, guideline_version, started_by, data) values ($1,$2,$3,'running',$4,$5,$6::jsonb)`,
    [orgId, id, repoId, o.guidelines.org, by, JSON.stringify({ projectGuidelineVersion: o.guidelines.project })],
  );
  return id;
}

export async function finishRun(tx: Tx, orgId: string, runId: string, status: "succeeded" | "failed" | "needs_person" | "cancelled", o: { blocker?: string | null; timeline?: TimelineEntry[]; data?: Record<string, unknown> } = {}): Promise<void> {
  await tx.query(
    `update onboarding_runs set status = $3, blocker = $4, timeline = coalesce($5::jsonb, timeline), data = data || $6::jsonb, finished_at = now(), updated_at = now() where org_id = $1 and id = $2`,
    [orgId, runId, status, o.blocker ?? null, o.timeline ? JSON.stringify(o.timeline) : null, JSON.stringify(o.data ?? {})],
  );
}

export async function storeFindings(tx: Tx, orgId: string, runId: string, findings: Array<OnboardFinding & { required?: boolean; detail?: string }>): Promise<void> {
  await tx.query(`delete from onboarding_findings where org_id = $1 and run_id = $2`, [orgId, runId]);
  for (const f of findings) {
    await tx.query(
      `insert into onboarding_findings (org_id, id, run_id, check_id, label, ok, severity, fix, file, manual, required, detail) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [orgId, `${runId}:${f.id}`, runId, f.id, f.check, f.ok, f.sev, f.fix, f.file, f.manual === true, f.required === true, f.detail ?? ""],
    );
  }
}

export async function currentRunId(db: Queryable, orgId: string, repoId: string): Promise<string | null> {
  return (await db.query<{ id: string }>(`select id from onboarding_runs where org_id = $1 and repo_id = $2 order by started_at desc, id desc limit 1`, [orgId, repoId])).rows[0]?.id ?? null;
}

/** Whether a stop of the repo's own scope that Gantry raised for readiness is in force (it is lifted when readiness is regained). */
export async function readinessHalt(db: Queryable, orgId: string, repoId: string): Promise<{ id: string } | null> {
  return (await db.query<{ id: string }>(`select id from stops where org_id = $1 and scope_type = 'repo' and repo_id = $2 and mode = 'halt' and cause = 'readiness' and lifted_at is null limit 1`, [orgId, repoId])).rows[0] ?? null;
}
