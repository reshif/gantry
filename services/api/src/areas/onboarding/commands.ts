/**
 * Onboarding commands (spec 8.6, 11.3). Each runs inside `command()`: the decision point has already allowed it (and refused it in a stopped scope), and the body changes the
 * repo's state and writes its event in the same transaction. Anything that needs GitHub is a job for the worker; the command only records that it was asked for
 * and returns, so no request waits on GitHub and no transaction holds a lock across a network call.
 */
import type { Tx } from "@gantry/db";
import type { Decision } from "@gantry/domain";
import type { z } from "zod";
import type { Actor, CommandResult, EventSpec } from "../../core/command.js";
import { refuseDecision } from "../../core/decide.js";
import { conflict, invalid, notFound, stale } from "../../core/errors.js";
import { job, type BuiltJob } from "../../core/jobs-contract.js";
import { readRepos } from "../../core/read/index.js";
import type { ConfigBody, ConnectBody } from "./schemas.js";
import { guidelinesFor } from "./guidelines.js";
import { BUSY_TEXT, docOf, finishRun, fixableGaps, isBusy, lockRepo, readinessHalt, saveDoc, stamp, startRun, syncProjectStatus, type Doc, type RepoRow } from "./state.js";
import { liftReadinessHalt } from "./apply.js";

type Out<X extends object = Record<string, unknown>> = CommandResult<X>;

const subject = (r: Pick<RepoRow, "id">) => ({ type: "repo", id: r.id });
const ev = (type: string, r: RepoRow, extra: Partial<EventSpec> = {}): EventSpec => ({ type, category: "onboarding", subject: subject(r), projectId: r.project_id, ...extra });

/** An archived project is read-only (the decision point covers kills and halts). */
async function ensureOpen(tx: Tx, orgId: string, projectId: string): Promise<{ id: string; name: string; status: string; regulated: boolean }> {
  const p = (await tx.query<{ id: string; name: string; status: string; regulated: boolean }>(`select id, name, status, regulated from projects where org_id = $1 and id = $2`, [orgId, projectId])).rows[0];
  if (!p) throw notFound("No such project.");
  if (p.status === "archived") {
    const d: Decision = { allowed: false, reason: `${p.name} is archived and read-only. Unarchive it to change it.`, rule: { kind: "stop", id: "STOP", name: "Stop state" }, needs: "" };
    throw refuseDecision(d);
  }
  return p;
}

/** The repo, locked, with the project open and the caller's `If-Match` (the repo version) checked against the locked row. */
async function openRepo(tx: Tx, a: Actor, repoId: string): Promise<{ repo: RepoRow; doc: Doc }> {
  const repo = await lockRepo(tx, a.orgId, repoId);
  await ensureOpen(tx, a.orgId, repo.project_id);
  if (a.ifMatch !== null && repo.version !== a.ifMatch) throw stale();
  return { repo, doc: docOf(repo, a.now.getTime()) };
}

const guard = (doc: Doc): void => {
  if (isBusy(doc)) throw conflict(`${BUSY_TEXT[doc.busy!]}. Wait for it to finish.`);
};

const readOne = async (tx: Tx, orgId: string, id: string) => (await readRepos(tx, orgId)).find((r) => r.id === id);

/* ------------------------------------------------------------------ connect ---- */

export async function connectRepo(tx: Tx, a: Actor, projectId: string, b: z.infer<typeof ConnectBody>): Promise<Out> {
  const p = await ensureOpen(tx, a.orgId, projectId);
  const name = b.name;
  const [owner, short] = name.split("/") as [string, string];
  // GitHub names are case-insensitive: the same repository under another spelling is the same repository.
  const dup = (await tx.query<{ id: string; project_id: string; name: string }>(`select id, project_id, name from repos where org_id = $1 and (lower(name) = lower($2) or lower(github_full_name) = lower($2))`, [a.orgId, name])).rows[0];
  if (dup) {
    const mine = dup.project_id === projectId;
    const pn = (await tx.query<{ name: string }>(`select name from projects where org_id = $1 and id = $2`, [a.orgId, dup.project_id])).rows[0]?.name;
    throw conflict(`${name} is already connected to ${mine ? p.name : pn ? "another project" : "another project"}.`);
  }
  if (b.source) {
    const i = (await tx.query<{ id: string; type_id: string; name: string; enabled: boolean; health: string }>(`select id, type_id, name, enabled, health from integration_instances where org_id = $1 and id = $2`, [a.orgId, b.source])).rows[0];
    if (!i) throw invalid(`That source is not a source-control integration open to ${p.name}.`);
    if (i.type_id !== "github") throw invalid(`${i.name} is a ${i.type_id} source. Only GitHub sources can be onboarded in this build.`);
    if (!i.enabled || i.health === "offline") throw conflict(`${i.name} is offline. Fix it in Integrations or pick another source.`);
  }
  const team = b.team ?? (await tx.query<{ team_id: string }>(`select team_id from project_teams where org_id = $1 and project_id = $2 order by created_at, team_id limit 1`, [a.orgId, projectId])).rows[0]?.team_id ?? null;
  if (team && !(await tx.query(`select 1 from teams where org_id = $1 and id = $2`, [a.orgId, team])).rowCount) throw invalid("No such team.");
  const taken = (await tx.query(`select 1 from repos where org_id = $1 and id = $2`, [a.orgId, short])).rowCount;
  const id = (taken ? `${owner}-${short}` : short).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  await tx.query(
    `insert into repos (org_id, id, project_id, team_id, name, github_full_name, lang, tags, onboarding_stage, data) values ($1,$2,$3,$4,$5,$5,'',$6,'connected',$7::jsonb)`,
    [a.orgId, id, projectId, team, name, p.regulated ? ["regulated"] : [], JSON.stringify({ mcp: [], notifyOverrides: [], triggers: true, ...(b.source ? { source: b.source } : {}) })],
  );
  await tx.query(`insert into repo_config (org_id, repo_id, merge_strategy, required_checks, protected_paths) values ($1,$2,$3,$4,$5)`, [a.orgId, id, p.regulated ? "merge" : "squash", ["ci/test"], [".github/workflows/**"]]);
  const g = await guidelinesFor(tx, a.orgId, projectId);
  const runId = await startRun(tx, a.orgId, id, a.id, { guidelines: { org: g.org.version, project: g.project?.version ?? 0 } });
  const doc: Doc = { stage: "connected", findings: [], pr: null, timeline: [], exception: null, startedAt: a.now.getTime(), busy: "assessing", runId };
  stamp(doc, a.personId ?? a.id, `Connected through ${b.source ? "an integration" : "the GitHub App"}.`, a.now);
  const row = await lockRepo(tx, a.orgId, id);
  await saveDoc(tx, a.orgId, row, doc);
  await syncProjectStatus(tx, a.orgId, projectId);
  return {
    msg: `${name} connected. Gantry will assess it.`,
    events: [ev("repo.connect", row, { after: { name, project: projectId, team, source: b.source ?? "github-app" } })],
    extra: { repo: await readOne(tx, a.orgId, id) },
    jobs: [job("onboarding.assess", { repoId: id, runId }, { dedupeKey: `onboarding.assess:${runId}` })],
    changes: ["repos", "projects", "audit"], project: projectId,
  };
}

/* ------------------------------------------------------------------ configure ---- */

export async function configureRepo(tx: Tx, a: Actor, repoId: string, b: ConfigBody): Promise<Out> {
  const { repo, doc } = await openRepo(tx, a, repoId);
  const keys = Object.keys(b).filter((k) => k !== "via");
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const data = { ...repo.data } as Record<string, unknown>;
  if (b.team !== undefined) {
    if (!(await tx.query(`select 1 from teams where org_id = $1 and id = $2`, [a.orgId, b.team])).rowCount) throw invalid("No such team.");
    before.team = repo.team_id; after.team = b.team;
    await tx.query(`update repos set team_id = $3 where org_id = $1 and id = $2`, [a.orgId, repo.id, b.team]);
  }
  if (b.tags !== undefined) { before.tags = repo.tags; after.tags = b.tags; await tx.query(`update repos set tags = $3 where org_id = $1 and id = $2`, [a.orgId, repo.id, b.tags]); }
  if (b.guidelines !== undefined) { before.guidelines = "(text)"; after.guidelines = "(text)"; await tx.query(`update repos set guidelines = $3 where org_id = $1 and id = $2`, [a.orgId, repo.id, b.guidelines]); }
  for (const k of ["mcp", "notifyOverrides", "triggers"] as const) {
    if (b[k] !== undefined) { before[k] = data[k] ?? null; after[k] = b[k]; data[k] = b[k]; }
  }
  if (b.source !== undefined) {
    if (b.source) {
      const i = (await tx.query<{ type_id: string; name: string; enabled: boolean }>(`select type_id, name, enabled from integration_instances where org_id = $1 and id = $2`, [a.orgId, b.source])).rows[0];
      if (!i) throw invalid("That source is not a source-control integration.");
      if (i.type_id !== "github") throw invalid(`${i.name} is a ${i.type_id} source. Only GitHub sources can be onboarded in this build.`);
    }
    before.source = data.source ?? null; after.source = b.source;
    if (b.source) data.source = b.source; else delete data.source;
  }
  if (b.config) {
    const c = b.config;
    const cur = { defaultBranch: repo.default_branch ?? "main", branchPrefix: repo.branch_prefix ?? "gantry/", merge: repo.merge_strategy ?? "squash", tagging: "", requiredChecks: repo.required_checks ?? [], protectedPaths: repo.protected_paths ?? [] };
    before.config = cur; after.config = { ...cur, ...c };
    const upd = await tx.query(
      `update repo_config set default_branch = coalesce($3, default_branch), branch_prefix = coalesce($4, branch_prefix), merge_strategy = coalesce($5, merge_strategy), tagging = coalesce($6, tagging),
              required_checks = coalesce($7, required_checks), protected_paths = coalesce($8, protected_paths), version = version + 1, updated_at = now() where org_id = $1 and repo_id = $2`,
      [a.orgId, repo.id, c.defaultBranch ?? null, c.branchPrefix ?? null, c.merge ?? null, c.tagging ?? null, c.requiredChecks ?? null, c.protectedPaths ?? null],
    );
    if (!upd.rowCount) {
      await tx.query(
        `insert into repo_config (org_id, repo_id, default_branch, branch_prefix, merge_strategy, tagging, required_checks, protected_paths) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [a.orgId, repo.id, c.defaultBranch ?? "main", c.branchPrefix ?? "gantry/", c.merge ?? "squash", c.tagging ?? "semver-patch", c.requiredChecks ?? [], c.protectedPaths ?? []],
      );
    }
  }
  await tx.query(`update repos set data = $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, repo.id, JSON.stringify(data)]);
  stamp(doc, a.personId ?? a.id, `Changed settings: ${keys.join(", ")}.`, a.now);
  const row = await lockRepo(tx, a.orgId, repo.id);
  const version = await saveDoc(tx, a.orgId, row, doc);
  return { msg: `Saved ${repo.name}.`, events: [ev("repo.config", repo, { before, after })], extra: { version }, changes: ["repos", "audit"], project: repo.project_id };
}

/* ------------------------------------------------------------------ assessment and pull request ---- */

/** Starts a fresh assessment run: the previous run's findings stay as history, the open pull request (if any) stays open. */
export async function rerunAssessment(tx: Tx, a: Actor, repoId: string): Promise<Out> {
  const { repo, doc } = await openRepo(tx, a, repoId);
  guard(doc);
  if (doc.stage === "ready") throw conflict("Already ready; re-assessing would restart onboarding.");
  const g = await guidelinesFor(tx, a.orgId, repo.project_id);
  const prev = doc.runId;
  if (prev) await finishRun(tx, a.orgId, prev, "cancelled", { blocker: null });
  const runId = await startRun(tx, a.orgId, repo.id, a.id, { guidelines: { org: g.org.version, project: g.project?.version ?? 0 } });
  doc.runId = runId;
  if (doc.pr && doc.pr.state !== "open") doc.pr = null;
  // An open onboarding PR keeps its place in the lifecycle: a re-assessment never takes a repo back to an earlier stage.
  const keep = doc.pr?.state === "open" && (doc.stage === "pr_opened" || doc.stage === "pr_checks");
  if (!keep) doc.stage = "connected";
  doc.busy = "assessing";
  delete doc.blocker;
  stamp(doc, a.personId ?? a.id, keep ? `Asked for a new assessment; PR #${doc.pr!.number} stays open at '${doc.stage}'.` : "Asked for a new assessment.", a.now);
  await saveDoc(tx, a.orgId, repo, doc);
  return {
    msg: `Assessment re-run for ${repo.name}.`, events: [ev("onboarding.assess", repo, { after: { run: runId, requestedBy: a.id } })],
    jobs: [job("onboarding.assess", { repoId: repo.id, runId }, { dedupeKey: `onboarding.assess:${runId}` })], changes: ["repos", "audit"], project: repo.project_id,
  };
}

export async function openOnboardingPr(tx: Tx, a: Actor, repoId: string): Promise<Out> {
  const { repo, doc } = await openRepo(tx, a, repoId);
  guard(doc);
  if (doc.pr && doc.pr.state === "open") throw conflict(`${repo.name} already has an open onboarding PR (#${doc.pr.number}).`);
  if (!["assessed", "failed"].includes(doc.stage)) throw conflict(`An onboarding PR is opened after the assessment; ${repo.name} is at '${doc.stage}'.`);
  if (!doc.findings.length) throw conflict("There are no findings yet. Re-run the assessment first.");
  if (!fixableGaps(doc.findings).length) throw conflict("Nothing to add: the repo already has everything a pull request can add. Verify it instead.");
  doc.busy = "opening_pr";
  delete doc.blocker;
  stamp(doc, a.personId ?? a.id, "Asked Gantry to open the pull request.", a.now);
  await saveDoc(tx, a.orgId, repo, doc);
  const runId = doc.runId ?? "";
  return {
    msg: `Gantry is opening the PR on ${repo.name}.`, events: [ev("onboarding.pr.requested", repo, { after: { run: runId, requestedBy: a.id } })],
    jobs: [job("onboarding.open_pr", { repoId: repo.id, runId, by: a.personId }, { dedupeKey: `onboarding.open_pr:${runId}:${a.requestId}` })], changes: ["repos", "audit"], project: repo.project_id,
  };
}

export async function requestChanges(tx: Tx, a: Actor, repoId: string, text: string): Promise<Out> {
  const { repo, doc } = await openRepo(tx, a, repoId);
  guard(doc);
  if (!doc.pr) throw conflict("No onboarding PR yet.");
  if (doc.pr.state !== "open") throw conflict("The PR is already merged.");
  doc.stage = "pr_opened";
  doc.pr.checks = "pending";
  doc.busy = "updating_pr";
  stamp(doc, a.personId ?? a.id, `Requested changes: ${text}`, a.now);
  await saveDoc(tx, a.orgId, repo, doc);
  const runId = doc.runId ?? "";
  return {
    msg: "Change requested. Gantry will update the pull request.", events: [ev("onboarding.changes", repo, { after: { pr: doc.pr.number, text } })],
    jobs: [job("onboarding.open_pr", { repoId: repo.id, runId, by: a.personId, request: text }, { dedupeKey: `onboarding.open_pr:${runId}:${a.requestId}` })], changes: ["repos", "audit"], project: repo.project_id,
  };
}

/* ------------------------------------------------------------------ merge ---- */

export async function mergeOnboardingPr(tx: Tx, a: Actor, repoId: string): Promise<Out> {
  const { repo, doc } = await openRepo(tx, a, repoId);
  guard(doc);
  const pr = doc.pr;
  if (!pr) throw conflict("No onboarding PR yet.");
  if (pr.state !== "open") throw conflict("The PR is already merged.");
  // A repo with no CI (nothing reported within the grace period) can still have its onboarding PR merged by a person; it will not reach Ready without CI.
  if ((pr.checks !== "green" && pr.checks !== "none") || doc.stage !== "pr_checks") throw conflict("Checks are not green yet.");
  if (!pr.headSha) throw conflict("The head commit of the PR is not known yet. Wait for the next check.");
  doc.busy = "merging";
  stamp(doc, a.personId ?? a.id, `Approved PR #${pr.number} for merge at ${pr.headSha.slice(0, 7)}.`, a.now);
  await saveDoc(tx, a.orgId, repo, doc);
  const runId = doc.runId ?? "";
  return {
    msg: `Merge of ${repo.name}#${pr.number} requested. GitHub's own rules decide whether it goes through.`,
    events: [ev("onboarding.merge", repo, { after: { pr: pr.number, headSha: pr.headSha, approvedBy: a.id } })],
    jobs: [job("onboarding.merge", { repoId: repo.id, runId, prNumber: pr.number, headSha: pr.headSha, by: a.id }, { dedupeKey: `onboarding.merge:${runId}:${pr.number}:${pr.headSha}` })],
    changes: ["repos", "audit"], project: repo.project_id,
  };
}

/* ------------------------------------------------------------------ exception and verify ---- */

export async function markException(tx: Tx, a: Actor, repoId: string, reason: string): Promise<Out> {
  const { repo, doc } = await openRepo(tx, a, repoId);
  if (doc.stage === "ready") throw conflict(doc.exception ? "Already ready by exception." : "Already ready.");
  const before = doc.stage;
  const jobs: BuiltJob[] = [];
  doc.exception = { by: a.id, at: a.now.getTime(), reason };
  doc.stage = "ready";
  doc.readyAt = a.now.getTime();
  doc.busy = null;
  delete doc.blocker;
  stamp(doc, a.personId ?? a.id, `Marked ready by exception: ${reason}`, a.now);
  if (doc.runId) await finishRun(tx, a.orgId, doc.runId, "succeeded", { data: { exception: true } });
  const lifted = await liftReadinessHalt(tx, a.orgId, repo.id, a.id, a.now, "Ready by exception");
  if (lifted) jobs.push(lifted.job);
  await saveDoc(tx, a.orgId, repo, doc);
  const events = [ev("onboarding.exception", repo, { before: { stage: before }, after: { stage: "ready", exception: true, reason } })];
  if (lifted) events.push(lifted.event);
  return { msg: `${repo.name} marked ready by exception.`, events, jobs, changes: ["repos", "projects", "stops", "audit"], project: repo.project_id };
}

export async function verifyNow(tx: Tx, a: Actor, repoId: string): Promise<Out> {
  const { repo, doc } = await openRepo(tx, a, repoId);
  guard(doc);
  if (!repo.github_full_name) throw conflict(`${repo.name} has no GitHub identity, so there is nothing to verify.`);
  if (doc.exception) throw conflict("This repo is ready by exception; its gaps were accepted by a person.");
  // Verification follows the merge of the onboarding PR, or an assessment that left nothing for a PR to add; a Ready repo can be re-checked.
  const afterMerge = doc.pr?.state === "merged" || (doc.findings.length > 0 && !fixableGaps(doc.findings).length);
  if (doc.stage === "connected") throw conflict("Assessment has not finished yet.");
  if (doc.stage !== "ready" && (["pr_opened", "pr_checks"].includes(doc.stage) || !afterMerge)) throw conflict("Verification runs after the onboarding PR is merged.");
  doc.busy = "verifying";
  stamp(doc, a.personId ?? a.id, "Asked for a live verification.", a.now);
  await saveDoc(tx, a.orgId, repo, doc);
  return {
    msg: `Verifying ${repo.name} against GitHub.`, events: [ev("onboarding.verify.requested", repo, { after: { requestedBy: a.id } })],
    jobs: [job("onboarding.verify", { repoId: repo.id, runId: doc.runId ?? null, trigger: "manual", by: a.id }, { dedupeKey: `onboarding.verify:${repo.id}:${a.requestId}` })], changes: ["repos", "audit"], project: repo.project_id,
  };
}

export { readinessHalt };
