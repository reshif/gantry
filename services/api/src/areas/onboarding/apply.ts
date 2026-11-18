/**
 * What the worker's onboarding jobs do to a repo's state (spec 11.3). The worker reads GitHub, then calls one of these inside its own transaction; each takes the repo
 * lock, checks that the run it belongs to is still the repo's current one (a newer assessment, an exception or a person's change makes an old job a no-op), changes the
 * onboarding document, the history tables and the stage, writes its event, and enqueues what comes next. Nothing here talks to GitHub.
 */
import { appendEvent, enqueue, type EventInput, type Queryable, type Tx } from "@gantry/db";
import {
  READINESS_CHECKS, ONBOARD_AGENT, assessorLabel, readinessLost, readinessUnknown, prChecksState, type AssessedFinding, type ObservedCheck, type OnboardAssessor, type PlannedFile, type ReadinessResult,
} from "@gantry/domain";
import { publishChange } from "../../core/changes.js";
import { job, type BuiltJob } from "../../core/jobs-contract.js";
import { apiStopId } from "../stops/targets.js";
import { postUpdate } from "./session/updates.js";
import { currentRunId, docOf, finishRun, lockRepo, readinessHalt, saveDoc, stamp, storeFindings, type Doc, type RepoRow } from "./state.js";

/** The actor of an entry or event that an Onboarding Agent run produced: only ever used when a run actually happened. Everything else Gantry does by rule is `system`. */
const AGENT = ONBOARD_AGENT;
const SYSTEM = "system";
const RULE_BASED: OnboardAssessor = { mode: "rule-based" };
const actorOf = (a: OnboardAssessor | undefined): string => (a?.mode === "agent" ? AGENT : SYSTEM);
export interface Applied { applied: boolean; reason?: string }
const skipped = (reason: string): Applied => ({ applied: false, reason });

/** Consecutive scheduled checks that must fail before readiness is declared lost (a single odd read from GitHub must not halt a repo). */
export const READINESS_STRIKES = 2;

async function sysEvent(tx: Tx, orgId: string, r: Pick<RepoRow, "id" | "project_id">, type: string, o: Partial<EventInput> = {}): Promise<void> {
  await appendEvent(tx, { orgId, type, category: "onboarding", actor: o.actor ?? SYSTEM, channel: o.channel ?? "system", subject: { type: "repo", id: r.id }, projectId: r.project_id, outcome: "ok", ...o });
}

const finish = async (tx: Tx, orgId: string, r: RepoRow, doc: Doc, keys: string[] = []): Promise<void> => {
  await saveDoc(tx, orgId, r, doc);
  await publishChange(tx, { org: orgId, keys: ["repos", "projects", "audit", ...keys], project: r.project_id });
};

/** One system post into the repo's onboarding session thread (idempotent per `key`), see session/updates.ts. */
const note = (tx: Tx, orgId: string, r: RepoRow, doc: Doc, now: Date, key: string, event: string, text: string, o: { followUp?: boolean; number?: number | null } = {}): Promise<boolean> =>
  postUpdate(tx, orgId, r, { key, event, text, now, runId: doc.runId ?? null, ...(o.number !== undefined ? { number: o.number } : {}), ...(o.followUp ? { followUp: true } : {}) });

/** The repo, locked, and its document, when `runId` is still the run the repo is on. */
async function current(tx: Tx, orgId: string, repoId: string, runId: string | null, now: Date, o: { excepted?: boolean } = {}): Promise<{ repo: RepoRow; doc: Doc } | Applied> {
  const repo = await lockRepo(tx, orgId, repoId).catch(() => null);
  if (!repo) return skipped("The repo no longer exists.");
  const doc = docOf(repo, now.getTime());
  if (runId && doc.runId && doc.runId !== runId) return skipped("A newer assessment replaced this run.");
  // A repo ready by exception is left as it is, except by a re-check or re-assessment a person asked for or the schedule runs: those report and never change the stage.
  if (doc.stage === "ready" && doc.exception && !o.excepted) return skipped("The repo was marked ready by exception.");
  return { repo, doc };
}
const isApplied = (x: { repo: RepoRow; doc: Doc } | Applied): x is Applied => "applied" in x;

/* ------------------------------------------------------------------ assessment ---- */

export type AssessmentResult =
  | { kind: "ok"; findings: AssessedFinding[]; language: string | null; defaultBranch: string; headSha: string }
  /** A person has to act (the App is not installed, the repo is empty or archived). */
  | { kind: "blocked"; code: string; msg: string }
  | { kind: "failed"; msg: string };

/**
 * What the assessment found for "Test command" (`<command> (<source>)`), kept beside the repository's settings as a proposal. It grants nothing: only commands a
 * person confirmed (`config.testCommands`) reach an agent's allow-list.
 */
function proposedTestCommand(findings: ReadonlyArray<{ id: string; ok: boolean; detail?: string | null }>): { testCommandProposed?: { command: string; source: string } } {
  const f = findings.find((x) => x.id === "test" && x.ok && x.detail);
  const m = f ? /^(.*?) \((.*)\)$/.exec(f.detail!) : null;
  return m ? { testCommandProposed: { command: m[1]!, source: m[2]! } } : {};
}

export async function applyAssessment(tx: Tx, orgId: string, o: { repoId: string; runId: string; now: Date; adapter?: string; assessor?: OnboardAssessor; result: AssessmentResult }): Promise<Applied> {
  const c = await current(tx, orgId, o.repoId, o.runId, o.now, { excepted: true });
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  if (doc.busy !== "assessing") return skipped("This repo is not waiting for an assessment.");
  doc.busy = null;
  // Ready by exception: the assessment reports (findings, history) and the repo stays Ready with its exception; only a person withdrawing the exception changes that.
  const excepted = doc.stage === "ready" && !!doc.exception;
  const assessor = o.assessor ?? RULE_BASED;
  const adapter = assessor.mode;
  const who = actorOf(assessor);
  doc.adapter = adapter;
  doc.assessor = assessor;
  const r = o.result;
  if (r.kind === "ok") {
    const gaps = r.findings.filter((f) => !f.ok);
    doc.findings = r.findings.map((f) => ({ id: f.id, check: f.check, ok: f.ok, sev: f.sev, fix: f.fix, file: f.file, ...(f.manual ? { manual: true } : {}), required: f.required, detail: f.detail, source: f.source ?? "observed", ...(f.note ? { note: f.note } : {}) }));
    // With an open onboarding PR the repo stays where the PR is; the PR is marked for an update instead of the stage regressing.
    const openPr = doc.pr?.state === "open" && (doc.stage === "pr_opened" || doc.stage === "pr_checks");
    if (excepted) { /* stays Ready */ }
    else if (!openPr) doc.stage = "assessed";
    else doc.prNeedsUpdate = true;
    delete doc.blocker;
    stamp(doc, who, `Assessment finished (${assessorLabel(assessor)}${assessor.mode === "rule-based" && assessor.reason ? `: ${assessor.reason}` : ""}): ${r.findings.length} findings, ${gaps.length} gap${gaps.length === 1 ? "" : "s"}${assessor.risk ? `; risk ${assessor.risk.level}` : ""}.`, o.now);
    await storeFindings(tx, orgId, o.runId, doc.findings);
    await finishRun(tx, orgId, o.runId, "succeeded", { data: { adapter, assessor, headSha: r.headSha, defaultBranch: r.defaultBranch, language: r.language } });
    // The base commit workspaces are seeded from, and the default branch GitHub reports, are facts: they replace what was guessed at connect.
    await tx.query(
      `insert into repo_config (org_id, repo_id, default_branch, data) values ($1,$2,$3,$4::jsonb)
       on conflict (org_id, repo_id) do update set default_branch = excluded.default_branch, data = repo_config.data || excluded.data, updated_at = now()`,
      [orgId, repo.id, r.defaultBranch, JSON.stringify({ baseSha: r.headSha, ...proposedTestCommand(r.findings) })],
    );
    if (repo.default_branch && repo.default_branch !== r.defaultBranch) stamp(doc, SYSTEM, `The default branch on GitHub is ${r.defaultBranch}, not ${repo.default_branch}. Settings updated.`, o.now);
    await sysEvent(tx, orgId, repo, "onboarding.assess", { actor: who, after: { run: o.runId, findings: r.findings.length, gaps: gaps.length, adapter, assessor, headSha: r.headSha }, occurredAt: o.now });
    await saveDoc(tx, orgId, repo, doc, r.language ? { lang: r.language } : {});
    await note(tx, orgId, repo, doc, o.now, `${o.runId}:assessed`, "assessed", `Assessment finished (${assessorLabel(assessor)}): ${r.findings.length} checks, ${gaps.length} gap${gaps.length === 1 ? "" : "s"}${assessor.risk ? `; risk ${assessor.risk.level}` : ""}.${doc.prNeedsUpdate ? ` PR #${doc.pr!.number} is open and may need an update.` : ""}`, { followUp: true });
    await publishChange(tx, { org: orgId, keys: ["repos", "projects", "audit", "home"], project: repo.project_id });
    return { applied: true };
  }
  // With an open onboarding PR the repo stays where the PR is (as a successful assessment does): the PR keeps syncing and stays mergeable, and the failure is shown as the blocker.
  const keepPr = excepted || (doc.pr?.state === "open" && (doc.stage === "pr_opened" || doc.stage === "pr_checks"));
  if (r.kind === "blocked") {
    if (!keepPr) doc.stage = "person";
    if (!excepted) doc.blocker = r.msg;
    stamp(doc, SYSTEM, `Needs a person: ${r.msg}`, o.now);
    await finishRun(tx, orgId, o.runId, "needs_person", { blocker: r.msg, data: { code: r.code, adapter } });
    await sysEvent(tx, orgId, repo, "onboarding.assess", { outcome: "failed", after: { run: o.runId, blocked: r.code, msg: r.msg }, occurredAt: o.now });
  } else {
    if (!keepPr) doc.stage = "failed";
    if (!excepted) doc.blocker = r.msg;
    stamp(doc, SYSTEM, `The assessment failed: ${r.msg}`, o.now);
    await finishRun(tx, orgId, o.runId, "failed", { blocker: r.msg, data: { adapter } });
    await sysEvent(tx, orgId, repo, "onboarding.assess", { outcome: "failed", after: { run: o.runId, error: r.msg }, occurredAt: o.now });
  }
  await note(tx, orgId, repo, doc, o.now, `${o.runId}:${r.kind}`, "assess.stopped", r.kind === "blocked" ? `Assessment needs a person: ${r.msg}` : `The assessment failed: ${r.msg}`);
  await finish(tx, orgId, repo, doc, ["home"]);
  return { applied: true };
}

/** The Onboarding Agent's run was started for this repo (`step`): the timeline and the audit say which version and model, before anything is decided. Only called when a run really exists. */
export async function applyAgentStarted(tx: Tx, orgId: string, o: { repoId: string; runId: string; now: Date; step: "assess" | "open_pr"; attemptId: string; agent: { version: number; model: string; instructionsHash: string | null } }): Promise<Applied> {
  const c = await current(tx, orgId, o.repoId, o.runId, o.now);
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  stamp(doc, AGENT, `Started the Onboarding Agent v${o.agent.version} (model ${o.agent.model}) to ${o.step === "assess" ? "review the observed findings" : "draft AGENTS.md"}. Gantry's own observations stay the source of truth.`, o.now);
  await sysEvent(tx, orgId, repo, "onboarding.agent.started", { actor: AGENT, after: { run: o.runId, step: o.step, attempt: o.attemptId, version: o.agent.version, model: o.agent.model, instructionsHash: o.agent.instructionsHash }, occurredAt: o.now });
  await finish(tx, orgId, repo, doc);
  return { applied: true };
}

/* ------------------------------------------------------------------ the pull request ---- */

export interface OpenedPr { number: number; url: string; headSha: string; branch: string; title: string; created: boolean; changed: boolean }

async function reviewersOf(db: Queryable, orgId: string, projectId: string): Promise<string[]> {
  const { rows } = await db.query<{ person_id: string }>(
    `select distinct person_id from effective_role_assignments where org_id = $1 and project_id = $2 and role_id in ('project_admin','release_manager') and revoked_at is null and (expires_at is null or expires_at > now()) order by person_id`,
    [orgId, projectId],
  );
  return rows.map((r) => r.person_id);
}

export async function applyPrOpened(tx: Tx, orgId: string, o: { repoId: string; runId: string; now: Date; pr: OpenedPr; files: PlannedFile[]; request: string | null; by: string | null; drafter?: OnboardAssessor }): Promise<Applied> {
  const c = await current(tx, orgId, o.repoId, o.runId, o.now);
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  if (doc.busy !== "opening_pr" && doc.busy !== "updating_pr") return skipped("This repo is not waiting for its pull request.");
  const update = !!doc.pr && doc.pr.number === o.pr.number;
  doc.busy = null;
  delete doc.prNeedsUpdate;
  doc.stage = "pr_opened";
  delete doc.blocker;
  const drafter = o.drafter ?? RULE_BASED;
  doc.drafter = drafter;
  doc.pr = {
    number: o.pr.number, title: o.pr.title, branch: o.pr.branch, files: o.files.map((f) => ({ path: f.path, plus: f.plus, minus: f.minus, finding: f.finding, source: f.source ?? "observed" })), checks: "pending", state: "open",
    reviewers: await reviewersOf(tx, orgId, repo.project_id), mergedBy: null, url: o.pr.url, headSha: o.pr.headSha,
  };
  stamp(doc, SYSTEM, update
    ? (o.pr.changed ? `Pushed an update to PR #${o.pr.number}${o.request ? " for the requested change" : ""}.` : `PR #${o.pr.number} already held these files; nothing was pushed.`)
    : `Opened PR #${o.pr.number} with ${o.files.length} files (${drafter.mode === "agent" ? `AGENTS.md drafted by ${assessorLabel(drafter)}` : `rule-based${drafter.reason ? `: ${drafter.reason}` : ""}`}).`, o.now);
  await tx.query(
    `insert into onboarding_prs (org_id, id, run_id, repo_id, number, title, branch, state, checks, files, reviewers, head_sha, url) values ($1,$2,$3,$4,$5,$6,$7,'open','pending',$8::jsonb,$9,$10,$11)
     on conflict (org_id, id) do update set number = excluded.number, title = excluded.title, branch = excluded.branch, state = 'open', checks = 'pending', files = excluded.files, reviewers = excluded.reviewers, head_sha = excluded.head_sha, url = excluded.url, updated_at = now()`,
    // The table keeps what the pull request tab previews (the added lines of each file); the document the repo list reads does not carry them.
    [orgId, `${doc.runId ?? o.runId}:pr`, doc.runId ?? o.runId, repo.id, o.pr.number, o.pr.title, o.pr.branch, JSON.stringify(o.files.map((f) => ({ path: f.path, plus: f.plus, minus: f.minus, finding: f.finding, mode: f.mode, added: f.added, source: f.source ?? "observed" }))), doc.pr.reviewers, o.pr.headSha, o.pr.url],
  );
  await sysEvent(tx, orgId, repo, update ? "onboarding.pr.updated" : "onboarding.pr", {
    after: { number: o.pr.number, url: o.pr.url, headSha: o.pr.headSha, files: o.files.map((f) => f.path), drafter, ...(o.request ? { request: o.request } : {}) }, occurredAt: o.now,
    ...(drafter.mode === "agent" ? { actor: AGENT } : {}),
    ...(o.by ? { onBehalfOf: o.by } : {}),
  });
  doc.pr.headAt = o.now.getTime();
  await enqueue(tx, { orgId, ...job("onboarding.sync", { repoId: repo.id }, { dedupeKey: `onboarding.sync:${repo.id}:${o.pr.headSha}`, runAt: new Date(o.now.getTime() + 15_000) }) });
  await note(tx, orgId, repo, doc, o.now, `pr:${o.pr.number}:${o.pr.headSha}`, "pr", `${update ? (o.pr.changed ? `Updated PR #${o.pr.number}` : `PR #${o.pr.number} already held these files`) : `Opened PR #${o.pr.number}`} with ${o.files.length} file${o.files.length === 1 ? "" : "s"}. Gantry watches its checks and will post here when they finish.`, { number: o.pr.number });
  await finish(tx, orgId, repo, doc, ["home"]);
  return { applied: true };
}

/** The pull request could not be opened. Nothing to add and a stop put the repo back at `assessed`; anything else fails it for a person to look at. */
export async function applyPrFailed(tx: Tx, orgId: string, o: { repoId: string; runId: string; now: Date; code: string; msg: string }): Promise<Applied> {
  const c = await current(tx, orgId, o.repoId, o.runId, o.now);
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  if (doc.busy !== "opening_pr" && doc.busy !== "updating_pr") return skipped("This repo is not waiting for its pull request.");
  const wasUpdate = doc.busy === "updating_pr";
  doc.busy = null;
  const soft = ["nothing_to_add", "fenced"].includes(o.code);
  if (wasUpdate) {
    // The pull request is still open; the change was not made.
    doc.stage = doc.pr?.checks === "green" ? "pr_checks" : "pr_opened";
    stamp(doc, SYSTEM, `Could not update the pull request: ${o.msg}`, o.now);
  } else if (soft) {
    doc.stage = "assessed";
    stamp(doc, SYSTEM, o.code === "nothing_to_add" ? `Nothing to add: ${o.msg}` : `The pull request was not opened: ${o.msg}`, o.now);
  } else {
    doc.stage = "failed";
    doc.blocker = o.msg;
    stamp(doc, SYSTEM, `Could not open the pull request: ${o.msg}`, o.now);
  }
  await sysEvent(tx, orgId, repo, "onboarding.pr", { outcome: "failed", after: { code: o.code, msg: o.msg }, occurredAt: o.now });
  await finish(tx, orgId, repo, doc);
  return { applied: true };
}

/** What a poll of the pull request on GitHub found. */
export interface PrObservation {
  state: "open" | "merged" | "closed";
  headSha: string | null;
  mergedBy?: string | null;
  checks: ObservedCheck[];
  /** Commit statuses reported on the head (0 when none). */
  statuses?: number;
}

/**
 * Brings the pull request's state up to date with GitHub: CI results (`pending`, `running`, `green`, `red`), a head commit that moved, a merge done on GitHub,
 * a close. A merge seen here (not asked for by Gantry) moves the repo on and starts verification. Returns whether anything changed.
 */
export async function applyPrObservation(tx: Tx, orgId: string, o: { repoId: string; now: Date; gateCheckName: string; noCiGraceMs?: number; obs: PrObservation }): Promise<Applied & { changed?: boolean }> {
  const c = await current(tx, orgId, o.repoId, null, o.now);
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  const pr = doc.pr;
  if (!pr || pr.state !== "open") return skipped("There is no open onboarding pull request.");
  if (["merging"].includes(doc.busy ?? "") && o.obs.state === "open") return skipped("A merge is being requested.");
  let changed = false;
  const required = repo.required_checks ?? [];
  if (o.obs.headSha && pr.headSha !== o.obs.headSha) { pr.headSha = o.obs.headSha; pr.headAt = o.now.getTime(); changed = true; }
  if (pr.headAt === undefined) { pr.headAt = o.now.getTime(); changed = true; }
  if (o.obs.state === "merged") {
    pr.state = "merged";
    pr.mergedBy = o.obs.mergedBy ? `github:${o.obs.mergedBy}` : null;
    pr.checks = "green";
    doc.stage = "pr_merged";
    doc.busy = null;
    stamp(doc, pr.mergedBy ?? "system", `PR #${pr.number} was merged on GitHub.`, o.now);
    await tx.query(`update onboarding_prs set state = 'merged', merged_by = $3, merged_at = $4, checks = 'green', updated_at = now() where org_id = $1 and repo_id = $2 and number = $5`, [orgId, repo.id, pr.mergedBy, o.now, pr.number]);
    await sysEvent(tx, orgId, repo, "onboarding.merged", { after: { number: pr.number, by: pr.mergedBy, via: "github" }, occurredAt: o.now });
    await enqueue(tx, { orgId, ...job("onboarding.verify", { repoId: repo.id, runId: doc.runId ?? null, trigger: "merge" }, { dedupeKey: `onboarding.verify:${repo.id}:merge:${pr.number}` }) });
    await note(tx, orgId, repo, doc, o.now, `merged:${pr.number}`, "merged", `PR #${pr.number} was merged${o.obs.mergedBy ? ` by ${o.obs.mergedBy}` : ""} on GitHub. Gantry is verifying the repository live and will post the result here.`, { number: pr.number });
    await finish(tx, orgId, repo, doc, ["home"]);
    return { applied: true, changed: true };
  }
  if (o.obs.state === "closed") {
    pr.state = "closed";
    doc.stage = "assessed";
    doc.busy = null;
    stamp(doc, "system", `PR #${pr.number} was closed without merging. Open a new one when ready.`, o.now);
    await tx.query(`update onboarding_prs set state = 'closed', updated_at = now() where org_id = $1 and repo_id = $2 and number = $3`, [orgId, repo.id, pr.number]);
    await sysEvent(tx, orgId, repo, "onboarding.pr.closed", { after: { number: pr.number }, occurredAt: o.now });
    const closed = pr.number;
    doc.pr = null;
    await note(tx, orgId, repo, doc, o.now, `closed:${closed}`, "closed", `PR #${closed} was closed without merging. The agent can propose a new one.`, { followUp: true, number: closed });
    await finish(tx, orgId, repo, doc, ["home"]);
    return { applied: true, changed: true };
  }
  // Nothing reported at all (no check run, no commit status) for longer than the grace period after the head appeared: the repo has no CI. It is not "pending" forever.
  const graced = o.now.getTime() - (pr.headAt ?? o.now.getTime()) >= (o.noCiGraceMs ?? 10 * 60_000) && (o.obs.statuses ?? 0) === 0;
  const next = (o.obs.statuses ?? 0) > 0 && !o.obs.checks.length ? "running" : prChecksState(required, o.obs.checks, o.gateCheckName, { noneAfterGrace: graced });
  if (next !== pr.checks) {
    stamp(doc, "ci", `Checks on PR #${pr.number}: ${next === "green" ? "all passed" : next === "red" ? "a check failed" : next === "running" ? "running" : next === "none" ? "none reported (this repo has no CI)" : "waiting to start"}.`, o.now);
    pr.checks = next;
    changed = true;
    const sha = (pr.headSha ?? "").slice(0, 7);
    const text = next === "green" ? `Checks on PR #${pr.number} all passed at ${sha}. It is ready for a person to approve and merge.`
      : next === "red" ? `A check failed on PR #${pr.number} at ${sha}${o.obs.checks.filter((c) => c.status === "completed" && c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion)).length ? `: ${o.obs.checks.filter((c) => c.status === "completed" && c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion)).map((c) => `${c.name} (${c.conclusion})`).join(", ")}` : ""}.`
      : next === "none" ? `No CI ran on PR #${pr.number}: no check run and no commit status was reported on ${sha} after ${Math.round((o.noCiGraceMs ?? 600_000) / 60_000)} minutes. This repo has no CI. A person may still merge the onboarding PR, but the repo will not reach Ready until CI exists (verification needs CI to report a check on the canary).`
      : null;
    if (text) await note(tx, orgId, repo, doc, o.now, `checks:${doc.runId ?? ""}:${pr.number}:${pr.headSha ?? ""}:${next}`, `checks.${next}`, text, { followUp: true, number: pr.number });
  }
  const stage = next === "pending" ? "pr_opened" : "pr_checks";
  // A repo an earlier build left at 'assessed' with its PR open (a re-assessment used to regress the stage) is put back where its PR is.
  if (doc.stage === "assessed" && !doc.busy) { doc.stage = stage; changed = true; }
  if (doc.stage === "pr_opened" || doc.stage === "pr_checks") {
    if (doc.stage !== stage) { doc.stage = stage; changed = true; }
  }
  // The poll itself is recorded (the session says "checked 1 minute ago"); it does not change the repo, so no version bump and no event.
  if (!changed) { await tx.query(`update onboarding_prs set updated_at = now() where org_id = $1 and repo_id = $2 and number = $3`, [orgId, repo.id, pr.number]); return { applied: true, changed: false }; }
  await tx.query(`update onboarding_prs set checks = $3, head_sha = $4, updated_at = now() where org_id = $1 and repo_id = $2 and number = $5`, [orgId, repo.id, pr.checks, pr.headSha ?? null, pr.number]);
  await finish(tx, orgId, repo, doc, ["home"]);
  return { applied: true, changed: true };
}

export async function applyMerged(tx: Tx, orgId: string, o: { repoId: string; runId: string | null; now: Date; prNumber: number; by: string; mergeSha: string | null }): Promise<Applied> {
  const c = await current(tx, orgId, o.repoId, o.runId, o.now);
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  if (!doc.pr || doc.pr.number !== o.prNumber) return skipped("That is not this repo's onboarding pull request.");
  doc.pr.state = "merged";
  doc.pr.mergedBy = o.by;
  doc.pr.checks = "green";
  doc.stage = "pr_merged";
  doc.busy = null;
  stamp(doc, o.by, `Approved and merged PR #${o.prNumber}.`, o.now);
  await tx.query(`update onboarding_prs set state = 'merged', merged_by = $3, merged_at = $4, updated_at = now() where org_id = $1 and repo_id = $2 and number = $5`, [orgId, repo.id, o.by, o.now, o.prNumber]);
  await sysEvent(tx, orgId, repo, "onboarding.merged", { actor: o.by, channel: "github", after: { number: o.prNumber, mergeSha: o.mergeSha }, occurredAt: o.now });
  await enqueue(tx, { orgId, ...job("onboarding.verify", { repoId: repo.id, runId: doc.runId ?? null, trigger: "merge" }, { dedupeKey: `onboarding.verify:${repo.id}:merge:${o.prNumber}` }) });
  await note(tx, orgId, repo, doc, o.now, `merged:${o.prNumber}`, "merged", `PR #${o.prNumber} was approved and merged. Gantry is verifying the repository live and will post the result here.`, { number: o.prNumber });
  await finish(tx, orgId, repo, doc, ["home"]);
  return { applied: true };
}

/** GitHub did not take the merge. The head moved (approve again), the rules refuse it (a review is missing, say), or the pull request is no longer open. */
export async function applyMergeRefused(tx: Tx, orgId: string, o: { repoId: string; runId: string | null; now: Date; prNumber: number; code: string; msg: string; headSha?: string }): Promise<Applied> {
  const c = await current(tx, orgId, o.repoId, o.runId, o.now);
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  if (!doc.pr || doc.pr.number !== o.prNumber) return skipped("That is not this repo's onboarding pull request.");
  doc.busy = null;
  if (o.code === "head_moved") {
    if (o.headSha) doc.pr.headSha = o.headSha;
    doc.pr.checks = "pending";
    doc.stage = "pr_opened";
    stamp(doc, "system", `The head of PR #${o.prNumber} moved after it was approved. Waiting for checks on the new commit; approve again once they pass.`, o.now);
  } else {
    stamp(doc, "system", `GitHub did not merge PR #${o.prNumber}: ${o.msg} Approve and merge again once it is allowed.`, o.now);
  }
  await sysEvent(tx, orgId, repo, "onboarding.merge", { outcome: "failed", after: { number: o.prNumber, code: o.code, msg: o.msg }, occurredAt: o.now });
  await note(tx, orgId, repo, doc, o.now, `refused:${o.prNumber}:${o.code}:${o.headSha ?? ""}`, "merge.refused", o.code === "head_moved" ? `The head of PR #${o.prNumber} moved after the merge was approved. Waiting for checks on the new commit.` : `GitHub did not merge PR #${o.prNumber}: ${o.msg}`, { followUp: true, number: o.prNumber });
  await finish(tx, orgId, repo, doc, ["home"]);
  return { applied: true };
}

/* ------------------------------------------------------------------ a job that died ---- */

/**
 * A job of this repo's current step used up its attempts (or its lease) and is dead: nothing will ever clear `busy`, so every command would be refused. This clears it and says
 * why, with the job's error as the blocker. The repo moves to Needs a person, except where that would take a place away: an open onboarding PR keeps its stage (it stays synced
 * and mergeable, as after a failed assessment) and a Ready repo stays Ready. Re-run (assess, open PR, merge, verify) works from there.
 */
export async function applyJobDead(tx: Tx, orgId: string, o: { repoId: string; now: Date; error: string }): Promise<Applied> {
  const c = await current(tx, orgId, o.repoId, null, o.now);
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  if (!doc.busy) return skipped("This repo is not waiting for a job.");
  const step = doc.busy;
  const msg = `The ${step.replace("_", " ")} step stopped: ${o.error.slice(0, 300) || "the job died"}. Run it again.`;
  doc.busy = null;
  doc.blocker = msg;
  const keepPr = doc.pr?.state === "open" && (doc.stage === "pr_opened" || doc.stage === "pr_checks");
  if (doc.stage !== "ready" && !keepPr) doc.stage = "person";
  stamp(doc, SYSTEM, `Needs a person: ${msg}`, o.now);
  if (step === "assessing" && doc.runId) await finishRun(tx, orgId, doc.runId, "needs_person", { blocker: msg, data: { jobDead: true } });
  await sysEvent(tx, orgId, repo, "onboarding.job.dead", { outcome: "failed", after: { step, error: o.error.slice(0, 300), stage: doc.stage }, occurredAt: o.now });
  await note(tx, orgId, repo, doc, o.now, `${doc.runId ?? repo.id}:dead:${step}:${o.now.getTime()}`, "job.dead", msg);
  await finish(tx, orgId, repo, doc, ["home"]);
  return { applied: true };
}

/* ------------------------------------------------------------------ verification and readiness ---- */

export interface VerificationInput { repoId: string; runId: string | null; trigger: "merge" | "manual" | "schedule"; by: string | null; now: Date; results: ReadinessResult[] }

const failedLabels = (r: ReadinessResult[]): string => r.filter((x) => !x.ok && !x.unknown).map((x) => x.detail).join(" ");

/**
 * Records a live verification (spec 11.3 "Verified means"). Before Ready it is the gate to Ready; once Ready it is the re-check: a definite failure on enough
 * consecutive scheduled checks (or on a person's own request) loses readiness, which halts the repo with cause `readiness`. A check that could not be made
 * (GitHub or the broker did not answer) is never a failure and never halts anything.
 */
export async function applyVerification(tx: Tx, orgId: string, o: VerificationInput): Promise<Applied & { outcome?: "ready" | "failed" | "lost" | "held" | "unknown" | "strike" | "excepted" }> {
  const c = await current(tx, orgId, o.repoId, null, o.now, { excepted: true });
  if (isApplied(c)) return c;
  const { repo, doc } = c;
  const excepted = doc.stage === "ready" && !!doc.exception;
  const lost = readinessLost(o.results);
  const unknown = readinessUnknown(o.results);
  const wasReady = doc.stage === "ready";
  const id = `ver-${repo.id}-${o.now.getTime().toString(36)}`;
  // A check this run did not make (a scheduled re-check skips the canary) keeps its last result, marked with when it was made.
  const ran = new Set(o.results.map((r) => r.id));
  const carried = (doc.verification?.checks ?? []).filter((c) => !(ran as Set<string>).has(c.id)).map((c) => ({ ...c, at: c.at ?? doc.verification!.at }));
  const order = (id: string): number => READINESS_CHECKS.findIndex((x) => (x.id as string) === id);
  doc.verification = {
    at: o.now.getTime(), ok: !lost && !unknown, trigger: o.trigger, unknown,
    checks: [...o.results.map((r) => ({ id: r.id, label: r.label, ok: r.ok, ...(r.unknown ? { unknown: true } : {}), detail: r.detail })), ...carried].sort((a, b) => order(a.id) - order(b.id)),
  };
  if (doc.busy === "verifying") doc.busy = null;
  await tx.query(
    `insert into onboarding_verifications (org_id, id, repo_id, run_id, trigger, ok, unavailable, checks, requested_by, checked_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [orgId, id, repo.id, o.runId ?? doc.runId ?? null, o.trigger, !lost && !unknown, unknown && !lost, JSON.stringify(doc.verification.checks), o.by, o.now],
  );
  const prior = Number((await tx.query<{ n: number }>(`select readiness_failures as n from repos where org_id = $1 and id = $2`, [orgId, repo.id])).rows[0]!.n);
  // A definite failure counts as one more strike, a clean pass clears them, and an unanswered check leaves them as they were.
  const failures = excepted ? 0 : lost ? prior + 1 : unknown ? prior : 0;
  await tx.query(`update repos set readiness_checked_at = $3, readiness_state = $4, readiness_failures = $5 where org_id = $1 and id = $2`, [orgId, repo.id, o.now, lost ? "lost" : unknown ? "unknown" : "ok", failures]);

  if (excepted) {
    // Ready by exception: the re-check runs and reports, but a person accepted these gaps, so nothing is lost, halted or unset. Withdrawing the exception is a person's call.
    if (lost) stamp(doc, SYSTEM, `Re-checked a repo ready by exception: ${failedLabels(o.results)} The exception stays until a person withdraws it.`, o.now);
    else if (o.trigger === "manual") stamp(doc, SYSTEM, unknown ? "Re-checked; GitHub could not confirm every check. The exception stays." : `Re-checked: ${o.results.length} live checks passed. The exception stays until a person withdraws it.`, o.now);
    await sysEvent(tx, orgId, repo, "onboarding.verify", { outcome: lost ? "failed" : "ok", after: { ok: !lost && !unknown, trigger: o.trigger, excepted: true, ...(lost ? { failed: o.results.filter((x) => !x.ok && !x.unknown).map((x) => x.id) } : {}) }, occurredAt: o.now, ...(o.by ? { onBehalfOf: o.by } : {}) });
    await finish(tx, orgId, repo, doc);
    return { applied: true, outcome: "excepted" };
  }

  if (!wasReady) {
    if (!lost && !unknown) {
      doc.stage = "ready";
      doc.readyAt = o.now.getTime();
      delete doc.blocker;
      stamp(doc, SYSTEM, `Verified: ${o.results.length} live checks passed.`, o.now);
      stamp(doc, SYSTEM, "Ready. Work orders can be submitted.", new Date(o.now.getTime() + 1));
      if (doc.runId) await finishRun(tx, orgId, doc.runId, "succeeded", { data: { verified: true } });
      const lifted = await liftReadinessHalt(tx, orgId, repo.id, "system", o.now, "Readiness regained");
      await sysEvent(tx, orgId, repo, "onboarding.verify", { after: { ok: true, trigger: o.trigger, checks: o.results.length }, occurredAt: o.now, ...(o.by ? { onBehalfOf: o.by } : {}) });
      await sysEvent(tx, orgId, repo, "onboarding.ready", { after: { trigger: o.trigger }, occurredAt: o.now });
      if (lifted) { await appendEvent(tx, lifted.eventInput); await enqueue(tx, { orgId, ...lifted.job }); }
      await note(tx, orgId, repo, doc, o.now, `ver:${id}`, "verified", `Verified: ${o.results.length} live checks passed. ${repo.name} is Ready: work orders can be submitted.`);
      await finish(tx, orgId, repo, doc, lifted ? ["stops", "home"] : ["home"]);
      return { applied: true, outcome: "ready" };
    }
    if (lost) {
      const msg = `Verification failed. ${failedLabels(o.results)} Fix it in GitHub, then verify again, or mark an exception.`;
      doc.stage = "person";
      doc.blocker = msg;
      stamp(doc, SYSTEM, `Needs a person: ${msg}`, o.now);
      if (doc.runId) await finishRun(tx, orgId, doc.runId, "needs_person", { blocker: msg });
      await sysEvent(tx, orgId, repo, "onboarding.verify", { outcome: "failed", after: { ok: false, trigger: o.trigger, failed: o.results.filter((x) => !x.ok && !x.unknown).map((x) => x.id) }, occurredAt: o.now });
      await note(tx, orgId, repo, doc, o.now, `ver:${id}`, "verify.failed", `Verification failed. ${failedLabels(o.results)}`, { followUp: true });
      await finish(tx, orgId, repo, doc, ["home"]);
      return { applied: true, outcome: "failed" };
    }
    stamp(doc, SYSTEM, `Verification could not finish: ${o.results.filter((x) => x.unknown).map((x) => x.detail).slice(0, 2).join(" ")} It will be tried again.`, o.now);
    await sysEvent(tx, orgId, repo, "onboarding.verify", { outcome: "failed", after: { ok: false, unavailable: true, trigger: o.trigger }, occurredAt: o.now });
    await finish(tx, orgId, repo, doc);
    return { applied: true, outcome: "unknown" };
  }

  // Ready already: this is the re-check.
  if (!lost) {
    if (o.trigger === "manual") stamp(doc, SYSTEM, unknown ? "Re-checked readiness; GitHub could not confirm every check." : `Re-checked readiness: ${o.results.length} live checks passed.`, o.now);
    await sysEvent(tx, orgId, repo, "onboarding.verify", { after: { ok: !unknown, trigger: o.trigger, ...(unknown ? { unavailable: true } : {}) }, occurredAt: o.now, ...(o.by ? { onBehalfOf: o.by } : {}) });
    await finish(tx, orgId, repo, doc);
    return { applied: true, outcome: unknown ? "unknown" : "held" };
  }
  if (o.trigger === "schedule" && failures < READINESS_STRIKES) {
    stamp(doc, SYSTEM, `Readiness check failed (${failures} of ${READINESS_STRIKES}): ${failedLabels(o.results)}`, o.now);
    await sysEvent(tx, orgId, repo, "onboarding.verify", { outcome: "failed", after: { ok: false, trigger: o.trigger, strike: failures, failed: o.results.filter((x) => !x.ok && !x.unknown).map((x) => x.id) }, occurredAt: o.now });
    await finish(tx, orgId, repo, doc);
    return { applied: true, outcome: "strike" };
  }
  const msg = `Readiness lost. ${failedLabels(o.results)} Fix it in GitHub and verify again, or mark an exception.`;
  doc.stage = "person";
  doc.blocker = msg;
  delete doc.readyAt;
  stamp(doc, SYSTEM, `Needs a person: ${msg}`, o.now);
  const halt = await raiseReadinessHalt(tx, orgId, repo, msg, o.now);
  await sysEvent(tx, orgId, repo, "onboarding.readiness.lost", { outcome: "regression", after: { failed: o.results.filter((x) => !x.ok && !x.unknown).map((x) => ({ id: x.id, detail: x.detail })), halted: !!halt, trigger: o.trigger }, occurredAt: o.now });
  if (halt) { await appendEvent(tx, halt.eventInput); await enqueue(tx, { orgId, ...halt.job }); }
  await finish(tx, orgId, repo, doc, ["stops", "floor", "workOrders", "home"]);
  return { applied: true, outcome: "lost" };
}

/* ------------------------------------------------------------------ the readiness halt ---- */

interface HaltEffect { eventInput: EventInput; job: BuiltJob }

/**
 * A system halt of the repo with cause `readiness` (spec 11.3): the same stop row the andon makes, set by `system`, so the Floor, the fence and the edge treat it like any halt.
 * It is not raised on a repo that is already halted (the person's halt stays theirs). Enforcement is the worker's `stop.enforce` job.
 */
export async function raiseReadinessHalt(tx: Tx, orgId: string, repo: Pick<RepoRow, "id" | "project_id" | "name">, reason: string, now: Date): Promise<HaltEffect | null> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`stop:${orgId}:repo:${repo.id}`]);
  if ((await tx.query(`select 1 from stops where org_id = $1 and scope_type = 'repo' and repo_id = $2 and lifted_at is null`, [orgId, repo.id])).rowCount) return null;
  const n = Number((await tx.query<{ n: string }>(`select (count(*) + 1)::text as n from stops where org_id = $1 and starts_with(id, $2)`, [orgId, `repo:${repo.id}:`])).rows[0]!.n);
  const id = `repo:${repo.id}:${n}`;
  const ins = await tx.query<{ fencing: string }>(
    `insert into stops (org_id, id, scope_type, project_id, repo_id, mode, reason, cause, set_by, set_at) values ($1,$2,'repo',$3,$4,'halt',$5,'readiness','system',$6) on conflict do nothing returning fencing::text`,
    [orgId, id, repo.project_id, repo.id, reason.slice(0, 500), now],
  );
  if (!ins.rowCount) return null;
  return {
    eventInput: {
      orgId, type: "halt", category: "kill", actor: "system", channel: "system", subject: { type: "repo", id: repo.id }, projectId: repo.project_id, occurredAt: now,
      after: { scope: "repo", repo: repo.id, mode: "halt", text: reason, stop: id, apiId: apiStopId("repo", repo.id), cause: "readiness", fencing: Number(ins.rows[0]!.fencing) },
    },
    job: job("stop.enforce", { stopId: id, scope: "repo", targetId: repo.id, mode: "halt" }, { dedupeKey: `stop.enforce:${id}` }),
  };
}

/** Lifts the readiness halt of a repo, if one is in force (readiness regained, or a person accepted the gaps). Returns the effect to record, or null. */
export async function liftReadinessHalt(tx: Tx, orgId: string, repoId: string, by: string, now: Date, why: string): Promise<{ event: import("../../core/command.js").EventSpec; eventInput: EventInput; job: BuiltJob } | null> {
  const halt = await readinessHalt(tx, orgId, repoId);
  if (!halt) return null;
  await tx.query(`update stops set lifted_by = $3, lifted_at = $4, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [orgId, halt.id, by, now]);
  const project = (await tx.query<{ project_id: string }>(`select project_id from repos where org_id = $1 and id = $2`, [orgId, repoId])).rows[0]?.project_id ?? null;
  const after = { scope: "repo", repo: repoId, text: why, stop: halt.id, apiId: apiStopId("repo", repoId), cause: "readiness" };
  return {
    event: { type: "resume", category: "kill", subject: { type: "repo", id: repoId }, projectId: project, occurredAt: now, before: { stop: halt.id }, after },
    eventInput: { orgId, type: "resume", category: "kill", actor: by, channel: "system", subject: { type: "repo", id: repoId }, projectId: project, occurredAt: now, before: { stop: halt.id }, after },
    job: job("stop.enforce", { stopId: halt.id, scope: "repo", targetId: repoId, mode: "halt" }, { dedupeKey: `stop.enforce:${halt.id}:lift` }),
  };
}

/* ------------------------------------------------------------------ for the schedule ---- */

export { currentRunId };
