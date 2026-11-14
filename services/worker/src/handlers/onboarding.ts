/**
 * Repository onboarding jobs (spec 11.3). Each reads GitHub through the broker (never directly), decides with the pure logic in @gantry/domain, and records the outcome through the
 * API's `apply*` functions in one transaction. What Gantry observes is deterministic (the rule-based path): every finding is a fact about the repo, and no model is needed for it.
 * When the Onboarding Agent is usable (set up, promoted, a model a connected vendor serves) a real agent run is added on top: the worker starts it as a hidden carrier attempt through
 * the ordinary runtime, `onboarding.agent_collect` validates what it answers and merges only what the contract allows (notes, risk, commands, AGENTS.md content), and anything else
 * (no model, invalid output, timeout, a stop, a budget) falls back to the rule-based result with the reason recorded. A job whose run is no longer the repo's current one does nothing.
 */
import {
  AGENT_STEP_DEADLINE_MS, COLLECT_EVERY_MS, applyAgentStarted, applyAssessment, applyMergeRefused, applyMerged, applyPrFailed, applyPrObservation, applyPrOpened, applyVerification, docOf, endCarrierAttempt, guidelinesFor,
  job, onboardingAgentGate, parseJob, readRepoRow, startAgentStep, type AgentPin, type AgentStep, type Doc, type RepoRow,
} from "@gantry/api/core";
import { enqueue, withTx, type Job } from "@gantry/db";
import {
  ONBOARD_AGENT, PR_TITLE, RESULT_FORMAT, RepoFacts, assess, assessorOf, authorshipOf, judgeCanary, judgeGuidelines, judgeOwners, judgeProtections, judgeRunner, mergeAssessment, planPr, prBody, resolveDraft, lacksWorkflowPermission, WORKFLOW_PERMISSION_FIX, workflowPermissionMessage,
  validateAssessment, type AgentResult, type SensitiveFlag, type AssessContext, type AssessedFinding, type OnboardAssessor, type PlanContext, type PlannedFile, type ReadinessResult,
} from "@gantry/domain";
import type { CanaryResult } from "../clients/broker.js";
import type { Deps } from "../deps.js";
import { DEFAULT_TOOLCHAINS } from "../toolchains.js";
import { errMsg, PermanentError, TransientError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";
import { coveringStops, loadAttempt, runIdFor } from "./common.js";
import { teardownRun } from "./teardown.js";

/** The adapter an assessment runs with when no agent does (spec 10.1): the rule-based path. A real agent run is recorded as `agent` (see `assessor` on the onboarding document). */
export const ASSESSOR = "rule-based";
interface Loaded {
  repo: RepoRow;
  doc: Doc;
  full: string;
  org: string;
  assessCtx: AssessContext;
  planCtx: PlanContext;
}

/** The repo with everything an assessment or a pull request plan needs. Null when the repo is gone or has no GitHub name. */
async function load(deps: Deps, orgId: string, repoId: string): Promise<Loaded | null> {
  const repo = await readRepoRow(deps.pool, orgId, repoId);
  if (!repo) return null;
  const full = repo.github_full_name ?? (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.name) ? repo.name : null);
  if (!full) return null;
  const g = await guidelinesFor(deps.pool, orgId, repo.project_id);
  const data = repo.data as { mcp?: unknown };
  const mcp = Array.isArray(data.mcp) ? data.mcp.filter((x): x is string => typeof x === "string") : [];
  const requiredChecks = repo.required_checks ?? [];
  const org = full.split("/")[0]!;
  const team = repo.team_id ?? "";
  return {
    repo, doc: docOf(repo), full, org,
    assessCtx: { guidelines: g.org.items, mcp, requiredChecks },
    planCtx: {
      project: repo.project_id, repoId: repo.id, org, team, defaultBranch: repo.default_branch ?? "main", branchPrefix: repo.branch_prefix ?? "gantry/", merge: repo.merge_strategy ?? "squash",
      requiredChecks, protectedPaths: repo.protected_paths ?? [], mcp,
      org_guidelines: { items: g.org.items, may: g.org.may, mayNot: g.org.mayNot, version: g.org.version },
      project_guidelines: { items: g.project?.items ?? [], notes: g.project?.notes ?? "", version: g.project?.version ?? 0 },
    },
  };
}

type Inspected = { ok: true; facts: RepoFacts } | { ok: false; code: string; msg: string };

async function inspect(deps: Deps, full: string, scan: boolean): Promise<Inspected> {
  const r = await deps.broker.inspect(full, { scan });
  if (!r.ok) return r;
  const parsed = RepoFacts.safeParse(r.facts);
  if (!parsed.success) throw new PermanentError(`The broker's facts for ${full} are malformed: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, "bad_facts");
  return { ok: true, facts: parsed.data };
}

/** Codes that mean a person has to act before the agent can go on (as opposed to a fault that may pass). */
const NEEDS_PERSON = new Set(["not_installed", "empty_repo", "archived"]);

/** Runs a step that may fail: a transient failure is retried until the last attempt, where it is recorded instead of thrown. */
async function guarded<T>(ctx: HandlerCtx, step: () => Promise<T>, onFail: (msg: string) => Promise<unknown>): Promise<T | { failed: string }> {
  try {
    return await step();
  } catch (e) {
    if (e instanceof TransientError && !ctx.last) throw e;
    const msg = errMsg(e);
    await onFail(msg);
    return { failed: msg };
  }
}

/* ------------------------------------------------------------------ the agent: gate, start, collect ---- */

async function agentGate(deps: Deps, orgId: string, l: Loaded): Promise<{ usable: true; pin: AgentPin } | { usable: false; reason: string }> {
  try {
    return await onboardingAgentGate(deps.pool, orgId, l.repo);
  } catch (e) {
    return { usable: false, reason: `The Onboarding Agent could not be checked: ${errMsg(e)}` };
  }
}

/** The diff cap of the Onboarding Agent's guardrails (lines it may add), 1500 when none is set. */
async function agentMaxDiff(deps: Deps, orgId: string): Promise<number> {
  const n = Number((await deps.pool.query<{ n: string | null }>(`select data->'guardrails'->>'maxDiff' as n from agents where org_id = $1 and id = $2`, [orgId, ONBOARD_AGENT])).rows[0]?.n);
  return Number.isInteger(n) && n > 0 ? n : 1500;
}

type BuiltJobs = Awaited<ReturnType<typeof startAgentStep>>["jobs"];
const enqueueBuilt = async (tx: Parameters<typeof enqueue>[0], orgId: string, jobs: BuiltJobs): Promise<void> => {
  for (const j of jobs) await enqueue(tx, { orgId, kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}), ...(j.runAt ? { runAt: j.runAt } : {}), ...(j.priority !== undefined ? { priority: j.priority } : {}) });
};

const gapView = (f: AssessedFinding) => ({ id: f.id, check: f.check, ok: f.ok, severity: f.sev, required: f.required, file: f.file, manual: f.manual === true, observed: f.detail, fix: f.fix });

/** Starts one agent step as a hidden carrier attempt (it runs through the ordinary dispatch), and records on the timeline that it was started. */
async function startStep(deps: Deps, l: Loaded, orgId: string, o: { runId: string; step: AgentStep; key: string; commit: string; pin: AgentPin; input: Record<string, unknown>; carry: Record<string, unknown> }): Promise<string> {
  const now = deps.now();
  return withTx(deps.pool, async (tx) => {
    const st = await startAgentStep(tx, orgId, { repo: l.repo, runId: o.runId, step: o.step, key: o.key, commit: o.commit, input: o.input, carry: { ...o.carry, pin: o.pin }, now });
    await enqueueBuilt(tx, orgId, st.jobs);
    await applyAgentStarted(tx, orgId, { repoId: l.repo.id, runId: o.runId, now, step: o.step, attemptId: st.attemptId, agent: { version: o.pin.version, model: o.pin.model, instructionsHash: o.pin.instructionsHash } });
    return st.attemptId;
  });
}

/* ------------------------------------------------------------------ assess ---- */

interface AssessBase { findings: AssessedFinding[]; language: string | null; defaultBranch: string; headSha: string }

const recordAssessment = (deps: Deps, orgId: string, l: Loaded, runId: string, result: Parameters<typeof applyAssessment>[2]["result"], assessor: OnboardAssessor) =>
  withTx(deps.pool, (tx) => applyAssessment(tx, orgId, { repoId: l.repo.id, runId, now: deps.now(), adapter: assessor.mode, assessor, result }));

export async function onboardingAssess(j: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("onboarding.assess", j.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { deps } = ctx;
  const l = await load(deps, j.orgId, p.value.repoId);
  if (!l) return { skipped: "The repo is gone or has no GitHub name." };
  if (l.doc.runId !== p.value.runId || l.doc.busy !== "assessing") return { skipped: "This run is no longer current." };
  const runId = p.value.runId;
  const ruleBased = (result: Parameters<typeof applyAssessment>[2]["result"], reason?: string) => recordAssessment(deps, j.orgId, l, runId, result, { mode: "rule-based", ...(reason ? { reason } : {}) });
  const r = await guarded(ctx, async () => {
    const got = await inspect(deps, l.full, true);
    if (!got.ok) return ruleBased(NEEDS_PERSON.has(got.code) || got.code === "fenced" ? { kind: "blocked", code: got.code, msg: got.msg } : { kind: "failed", msg: got.msg });
    if (got.facts.archived) return ruleBased({ kind: "blocked", code: "archived", msg: `${l.full} is archived on GitHub. Unarchive it first.` });
    // What Gantry observes: deterministic, the source of truth. The agent, when there is one, works on top of it.
    const findings = assess(got.facts, l.assessCtx);
    const base: AssessBase = { findings, language: got.facts.language, defaultBranch: got.facts.defaultBranch, headSha: got.facts.headSha };
    const ok = { kind: "ok" as const, ...base };
    const gate = await agentGate(deps, j.orgId, l);
    if (!gate.usable) return ruleBased(ok, gate.reason);
    const attemptId = await startStep(deps, l, j.orgId, {
      runId, step: "assess", key: "1", commit: base.headSha, pin: gate.pin, carry: { base },
      input: {
        title: `Assess ${l.full}`, class: "chore", task: "assess", repo: l.full, defaultBranch: base.defaultBranch, headSha: base.headSha, language: base.language,
        goal: "Review what Gantry observed in this repository (your workspace holds it, read-only). Do not change any finding's result: explain, judge the risk and report commands.",
        findings: findings.map(gapView), resultFormat: RESULT_FORMAT,
      },
    });
    return { agent: "started", attempt: attemptId };
  }, (msg) => ruleBased({ kind: "failed", msg }));
  return r;
}

/* ------------------------------------------------------------------ open or update the pull request ---- */

type OpenParams = { repoId: string; runId: string; by: string | null; request: string | null };

/** Opens (or updates) the pull request with the given files. `draft` is the agent's validated draft, when there is one; its AGENTS.md content replaces the rule-based file's. */
async function finishPr(deps: Deps, l: Loaded, orgId: string, p: OpenParams, o: { facts: RepoFacts; findings: AssessedFinding[]; plan: PlannedFile[]; drafter: OnboardAssessor; draft?: AgentResult; authored?: PlannedFile[] | null; sensitive?: SensitiveFlag[] }): Promise<unknown> {
  const by = authorshipOf(o.drafter);
  const files = o.authored ?? (o.draft?.agentsMd ? planPr(o.facts, o.findings, l.planCtx, { by, agentsMd: o.draft.agentsMd }) : o.plan);
  // The App cannot push a workflow file without the `workflows` permission: say so with the exact steps instead of letting GitHub reject the push.
  if (o.authored && files.some((f) => f.path.startsWith(".github/workflows/")) && lacksWorkflowPermission(o.facts)) return failPr(deps, l, orgId, p, "workflow_permission", `${workflowPermissionMessage} ${WORKFLOW_PERMISSION_FIX}`);
  // A follow-up pull request after the first one was merged gets its own branch: the merged branch's tip is behind the default branch.
  const branch = l.doc.pr?.state === "open" && l.doc.pr.branch ? l.doc.pr.branch : `${l.planCtx.branchPrefix}onboarding${l.doc.pr?.state === "merged" ? `-after-${l.doc.pr.number}` : ""}`;
  const request = p.request;
  const out = await deps.broker.openOnboardingPr({
    repo: l.full, branch, title: PR_TITLE(l.full), body: prBody(files, o.findings, by, { guidelineSuggestions: o.drafter.guidelineSuggestions ?? [], forPeople: o.drafter.forPeople ?? [], ...(o.sensitive?.length ? { sensitive: o.sensitive } : {}) }),
    files: files.map((f) => ({ path: f.path, content: f.content })),
    ...(request ? { comment: `Change requested${p.by ? ` by ${p.by}` : ""}: ${request}\n\nGantry regenerates the files from the repository and the guidelines as they are now${o.drafter.mode === "agent" ? ", keeping the Onboarding Agent's earlier AGENTS.md draft" : " (rule-based)"}; it does not interpret free text. A person should apply this request by hand on the branch.` } : {}),
  });
  if (!out.ok) return failPr(deps, l, orgId, p, out.code, out.msg);
  const applied = await withTx(deps.pool, async (tx) => {
    // The agent's validated draft is kept with the run, so a later change request regenerates the pull request with it instead of silently replacing it.
    if (o.drafter.mode === "agent" && o.draft) await tx.query(`update onboarding_runs set data = data || $3::jsonb, updated_at = now() where org_id = $1 and id = $2`, [orgId, p.runId, JSON.stringify({ agentDraft: { result: { files: o.draft.files, agentsMd: o.draft.agentsMd, guidelineSuggestions: o.draft.guidelineSuggestions, forPeople: o.draft.forPeople, plannedFiles: o.draft.plannedFiles }, drafter: o.drafter } })]);
    return applyPrOpened(tx, orgId, { repoId: l.repo.id, runId: p.runId, now: deps.now(), pr: { ...out.pr, title: PR_TITLE(l.full) }, files, request, by: p.by, drafter: o.drafter });
  });
  return { ...applied, number: out.pr.number, changed: out.pr.changed, drafter: o.drafter.mode };
}

const failPr = (deps: Deps, l: Loaded, orgId: string, p: OpenParams, code: string, msg: string) =>
  withTx(deps.pool, (tx) => applyPrFailed(tx, orgId, { repoId: l.repo.id, runId: p.runId, now: deps.now(), code, msg }));

export async function onboardingOpenPr(j: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("onboarding.open_pr", j.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { deps } = ctx;
  const l = await load(deps, j.orgId, p.value.repoId);
  if (!l) return { skipped: "The repo is gone or has no GitHub name." };
  if (l.doc.runId !== p.value.runId || !["opening_pr", "updating_pr"].includes(l.doc.busy ?? "")) return { skipped: "This request is no longer current." };
  const fail = (code: string, msg: string) => failPr(deps, l, j.orgId, p.value, code, msg);
  return guarded(ctx, async () => {
    // The pull request is planned from the repository as it is now, not from the findings of an hour ago.
    const got = await inspect(deps, l.full, false);
    if (!got.ok) return fail(got.code, got.msg);
    const findings = assess(got.facts, l.assessCtx);
    const plan = planPr(got.facts, findings, l.planCtx);
    const common = { facts: got.facts, findings, plan };
    const limits = { protectedPaths: l.planCtx.protectedPaths, maxDiff: await agentMaxDiff(deps, j.orgId) };
    const row = (await deps.pool.query<{ s: { confirmedSensitive?: boolean } | null; d: { result?: unknown; drafter?: OnboardAssessor } | null }>(`select data->'sessionApproved' as s, data->'agentDraft' as d from onboarding_runs where org_id = $1 and id = $2`, [j.orgId, p.value.runId])).rows[0];
    // An agent draft (a plan a person approved in the onboarding session, or the one kept for a change request) is validated again against the repository as it is now: the same rails,
    // and the sensitive parts must have been confirmed by the person who approved.
    const useDraft = async (draft: { result?: unknown; drafter?: OnboardAssessor } | null | undefined, fallbackReason: string): Promise<unknown> => {
      if (draft?.result && draft.drafter?.mode === "agent") {
        const v = resolveDraft(draft.result, { facts: got.facts, findings, ctx: l.planCtx, plan, maxDiff: limits.maxDiff, by: authorshipOf(draft.drafter), confirmed: row?.s?.confirmedSensitive === true });
        if (v.ok) return finishPr(deps, l, j.orgId, p.value, { ...common, drafter: draft.drafter, draft: v.value.value, authored: v.value.files, sensitive: v.value.sensitive });
        // What a person approved is never silently replaced by something else: say why it cannot be opened now.
        if (!p.value.request && row?.s && draft.result && (draft.result as { files?: unknown[] }).files?.length) return fail("draft_invalid", `The approved proposal can no longer be opened: ${v.reason} Ask the agent for a new proposal.`);
        return finishPr(deps, l, j.orgId, p.value, { ...common, drafter: { mode: "rule-based", reason: v.reason } });
      }
      return finishPr(deps, l, j.orgId, p.value, { ...common, drafter: { mode: "rule-based", reason: fallbackReason } });
    };
    if (!p.value.request && row?.s) {
      // A plan a person approved in the onboarding session is used as approved: no second agent run is started.
      if (!plan.length && !(row.d?.result && row.d.drafter?.mode === "agent")) return fail("nothing_to_add", "the repo already has everything a pull request can add. Verify it instead.");
      return useDraft(row.d, "Approved in the onboarding session as proposed.");
    }
    if (!plan.length && !p.value.request) return fail("nothing_to_add", "the repo already has everything a pull request can add. Verify it instead.");
    if (p.value.request) return useDraft(row?.d, "No agent draft exists for this run.");
    const gate = await agentGate(deps, j.orgId, l);
    if (!gate.usable) return finishPr(deps, l, j.orgId, p.value, { ...common, drafter: { mode: "rule-based", reason: gate.reason } });
    const attemptId = await startStep(deps, l, j.orgId, {
      runId: p.value.runId, step: "open_pr", key: j.id, commit: got.facts.headSha, pin: gate.pin, carry: { by: p.value.by, request: null },
      input: {
        title: `Author the onboarding pull request for ${l.full}`, class: "chore", task: "draft_pr", repo: l.full, defaultBranch: l.planCtx.defaultBranch, headSha: got.facts.headSha,
        goal: "Author the onboarding pull request for this repository (your workspace holds it, read-only): the complete set of files it needs to be ready, each with its full text, in `files`. The plan below is only what Gantry's fixed rules suggest; you may add, drop or change files (a new repository needs a project scaffold, a smoke test and CI). Rails: no secrets, no binaries, no lockfiles, no edits to existing application code, no branch-rule files. This run has no person to confirm sensitive parts, so a draft with workflow files or dependency manifests is not used here: the onboarding session is where those are proposed.",
        suggestedPlan: plan.map((f) => ({ path: f.path, mode: f.mode, closes: f.finding })), protectedPaths: l.planCtx.protectedPaths, maxLines: limits.maxDiff,
        findings: findings.filter((f) => !f.ok).map(gapView), resultFormat: RESULT_FORMAT,
      },
    });
    return { agent: "started", attempt: attemptId };
  }, (msg) => fail("github", msg));
}

/* ------------------------------------------------------------------ collect an agent step ---- */

const minutes = (ms: number): number => Math.round(ms / 60_000);

/** What the run cost and which version of what ran, from the pinned tuple and the edge's metering (not from what the agent says). */
async function runRecord(deps: Deps, orgId: string, attemptId: string, tupleId: string | null): Promise<Omit<OnboardAssessor, "mode">> {
  const runId = runIdFor(attemptId);
  const t = tupleId ? (await deps.pool.query<{ agent_id: string; agent_version: number; skill_versions: Record<string, number>; instruction_hash: string; model_id: string }>(`select agent_id, agent_version, skill_versions, instruction_hash, model_id from agent_version_tuples where org_id = $1 and id = $2`, [orgId, tupleId])).rows[0] : undefined;
  const u = (await deps.pool.query<{ tokens: string; micros: string }>(`select coalesce(sum(input_tokens + output_tokens),0)::text as tokens, coalesce(sum(cost_micros),0)::text as micros from run_usage where org_id = $1 and run_id = $2`, [orgId, runId])).rows[0];
  return {
    runId, ...(t ? { agent: t.agent_id, version: t.agent_version, model: t.model_id, instructionsHash: t.instruction_hash, skills: t.skill_versions } : {}),
    ...(u ? { costUsd: Number(u.micros) / 1e6, tokens: Number(u.tokens) } : {}),
  };
}

/**
 * onboarding.agent_collect: looks at an agent step. While the run is going it comes back in a few seconds. When the run has delivered, failed, been stopped (a halt or kill at any scope),
 * run past its wall clock or been replaced, it records the outcome: a valid result is merged onto the deterministic one; anything else falls back to the deterministic result with the reason.
 */
export async function onboardingAgentCollect(j: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("onboarding.agent_collect", j.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { deps } = ctx;
  const { repoId, runId: onbRun, step, attemptId, tick } = p.value;
  const a = await loadAttempt(deps.pool, j.orgId, attemptId);
  if (!a) return { skipped: "unknown attempt" };
  const run = runIdFor(attemptId);
  const l = await load(deps, j.orgId, repoId);
  const wantBusy = step === "assess" ? ["assessing"] : ["opening_pr", "updating_pr"];
  const current = !!l && l.doc.runId === onbRun && wantBusy.includes(l.doc.busy ?? "");
  const live = a.state === "queued" || a.state === "running";
  const end = async (why: { code: string; msg: string; cancelled?: boolean }): Promise<void> => {
    await withTx(deps.pool, async (tx) => { await endCarrierAttempt(tx, j.orgId, attemptId, why, deps.now()); });
    await teardownRun(deps, j.orgId, run, "stopped", { by: why.msg }).catch((e) => deps.log.warn({ run, err: errMsg(e) }, "teardown of an onboarding agent step"));
  };
  if (!current || !l) {
    if (live) await end({ code: "superseded", msg: "The repo moved on; this agent step was cancelled.", cancelled: true });
    return { skipped: "This step is no longer current." };
  }
  const sr = (await deps.pool.query<{ outcome: string; summary: string; body: { output?: unknown; error?: { code: string; msg: string } | null } }>(`select outcome, summary, body from station_results where org_id = $1 and id = $2`, [j.orgId, `sr-${run}`])).rows[0];
  let output: unknown = null;
  let failure: string | null = null;
  if (sr) {
    if (sr.outcome === "succeeded" && sr.body.output && typeof sr.body.output === "object") output = sr.body.output;
    else failure = `The agent's run ${sr.outcome === "succeeded" ? "ended with no result" : sr.outcome}${sr.body.error ? `: ${sr.body.error.msg}` : sr.summary ? `: ${sr.summary}` : ""}`.slice(0, 400);
  } else if (!live) {
    failure = `The agent's run ended (${a.attemptData.endedWhy ? String(a.attemptData.endedWhy) : a.state}) without a result.`.slice(0, 400);
  } else {
    const stops = await coveringStops(deps.pool, j.orgId, a);
    const startedAt = Date.parse(String((a.attemptData.onboarding as { startedAt?: string } | undefined)?.startedAt ?? ""));
    const deadline = deps.cfg.onboardingAgentDeadlineMs ?? AGENT_STEP_DEADLINE_MS;
    if (stops.length) failure = `${stops[0]!.mode === "kill" ? "A kill" : "A halt"} at ${stops[0]!.scopeType} scope stopped the agent's run.`;
    else if (Number.isFinite(startedAt) && deps.now().getTime() - startedAt > deadline) failure = `The agent did not finish within ${minutes(deadline)} minutes and was stopped.`;
    if (failure) await end({ code: stops.length ? "stopped" : "timeout", msg: failure, cancelled: true });
    else {
      await enqueue(deps.pool, { orgId: j.orgId, kind: j.kind, queue: j.queue, payload: { ...p.value, tick: tick + 1 }, dedupeKey: `onboarding.agent_collect:${attemptId}:${tick + 1}`, runAt: new Date(deps.now().getTime() + (deps.cfg.onboardingCollectEveryMs ?? COLLECT_EVERY_MS)) });
      return { waiting: true, tick: tick + 1 };
    }
  }
  const rec = await runRecord(deps, j.orgId, attemptId, a.tupleId);
  const fellBack = (reason: string): OnboardAssessor => ({ mode: "rule-based", reason, ...(rec.runId ? { runId: rec.runId } : {}), ...(rec.costUsd !== undefined ? { costUsd: rec.costUsd } : {}), ...(rec.tokens !== undefined ? { tokens: rec.tokens } : {}) });

  if (step === "assess") {
    const base = (a.woData.onboarding as { base?: AssessBase } | undefined)?.base;
    if (!base) return { skipped: "The carrier has no recorded assessment." };
    let findings = base.findings;
    let assessor: OnboardAssessor;
    if (failure) assessor = fellBack(failure);
    else {
      const v = validateAssessment(output, base.findings);
      if (!v.ok) assessor = fellBack(v.reason);
      else {
        findings = mergeAssessment(base.findings, v.value);
        assessor = assessorOf(v.value, rec);
      }
    }
    return recordAssessment(deps, j.orgId, l, onbRun, { kind: "ok", findings, language: base.language, defaultBranch: base.defaultBranch, headSha: base.headSha }, assessor);
  }

  // open_pr: re-read the repository (the plan is made from it as it is now), validate the draft against that plan, and open the pull request.
  const by = (a.woData.onboarding as { by?: string | null } | undefined)?.by ?? null;
  const params: OpenParams = { repoId, runId: onbRun, by, request: null };
  return guarded(ctx, async () => {
    const got = await inspect(deps, l.full, false);
    if (!got.ok) return failPr(deps, l, j.orgId, params, got.code, got.msg);
    const findings = assess(got.facts, l.assessCtx);
    const plan = planPr(got.facts, findings, l.planCtx);
    const common = { facts: got.facts, findings, plan };
    if (failure) return plan.length ? finishPr(deps, l, j.orgId, params, { ...common, drafter: fellBack(failure) }) : failPr(deps, l, j.orgId, params, "nothing_to_add", "the repo already has everything a pull request can add. Verify it instead.");
    const v = resolveDraft(output, { facts: got.facts, findings, ctx: l.planCtx, plan, maxDiff: await agentMaxDiff(deps, j.orgId), by: authorshipOf({ mode: "agent", ...(rec.version !== undefined ? { version: rec.version } : {}), ...(rec.model ? { model: rec.model } : {}) } as OnboardAssessor), confirmed: false });
    if (!v.ok) return plan.length ? finishPr(deps, l, j.orgId, params, { ...common, drafter: fellBack(v.reason) }) : failPr(deps, l, j.orgId, params, "nothing_to_add", `${v.reason}`);
    return finishPr(deps, l, j.orgId, params, { ...common, drafter: assessorOf(v.value.value, rec), draft: v.value.value, authored: v.value.files, sensitive: v.value.sensitive });
  }, (msg) => failPr(deps, l, j.orgId, params, "github", msg));
}

/* ------------------------------------------------------------------ merge ---- */

export async function onboardingMerge(j: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("onboarding.merge", j.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { deps } = ctx;
  const l = await load(deps, j.orgId, p.value.repoId);
  if (!l) return { skipped: "The repo is gone or has no GitHub name." };
  if (l.doc.runId !== p.value.runId || l.doc.busy !== "merging") return { skipped: "This request is no longer current." };
  const refused = (code: string, msg: string, headSha?: string) =>
    withTx(deps.pool, (tx) => applyMergeRefused(tx, j.orgId, { repoId: l.repo.id, runId: p.value.runId, now: deps.now(), prNumber: p.value.prNumber, code, msg, ...(headSha ? { headSha } : {}) }));
  return guarded(ctx, async () => {
    // F4: the broker reads the pull request before it acts, so a retry after a crash merges at most once.
    const m = await deps.broker.mergeOnboardingPr({ repo: l.full, number: p.value.prNumber, headSha: p.value.headSha, method: l.repo.merge_strategy === "merge" || l.repo.merge_strategy === "rebase" ? l.repo.merge_strategy : "squash" });
    if (!m.ok) return refused(m.code, m.msg, m.headSha);
    if (!m.merged) return refused("not_mergeable", "GitHub did not report the pull request as merged.");
    return withTx(deps.pool, (tx) => applyMerged(tx, j.orgId, { repoId: l.repo.id, runId: p.value.runId, now: deps.now(), prNumber: p.value.prNumber, by: p.value.by, mergeSha: m.mergeSha }));
  }, (msg) => refused("github", msg));
}

/* ------------------------------------------------------------------ verify ---- */

const unknownAll = (why: string): ReadinessResult[] => [...judgeProtections(RepoFacts.parse({ repo: "x/y", defaultBranch: "main", headSha: "0".repeat(40), language: null, files: [], secrets: { scanned: 0, complete: false, hits: [] }, protection: null }), []), ...judgeCanary(null, why)].map((r) => ({ ...r, detail: why }));

/**
 * The live checks of "Verified means" (spec 11.3). A scheduled re-check is read-only except once a day (`canaryEveryMs`), when it runs the canary too: opening and
 * closing a pull request every few hours would be noise for the people watching the repo. The canary is also skipped while the branch rules are not in place: there is
 * no point trying a direct push to a branch nothing protects.
 */
export async function onboardingVerify(j: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("onboarding.verify", j.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { deps } = ctx;
  const l = await load(deps, j.orgId, p.value.repoId);
  if (!l) return { skipped: "The repo is gone or has no GitHub name." };
  if (l.doc.exception) return { skipped: "Ready by exception." };
  if (p.value.runId && l.doc.runId && l.doc.runId !== p.value.runId) return { skipped: "A newer assessment replaced this run." };
  if (p.value.trigger === "schedule" && l.doc.stage !== "ready") return { skipped: "Not Ready; nothing to re-check." };
  if (p.value.trigger === "schedule" && l.doc.busy) return { skipped: "Something else is running on this repo." };
  const record = (results: ReadinessResult[], canaryRan: boolean) =>
    withTx(deps.pool, async (tx) => {
      if (canaryRan) await tx.query(`update repo_config set data = data || jsonb_build_object('canaryAt', $3::text), updated_at = now() where org_id = $1 and repo_id = $2`, [j.orgId, l.repo.id, deps.now().toISOString()]);
      return applyVerification(tx, j.orgId, { repoId: l.repo.id, runId: p.value.runId, trigger: p.value.trigger, by: p.value.by, now: deps.now(), results });
    });
  return guarded(ctx, async () => {
    const got = await inspect(deps, l.full, p.value.trigger !== "schedule");
    if (!got.ok) {
      // The App not being installed is a definite answer; anything else (fenced, empty) is not a verdict on readiness.
      const results = got.code === "not_installed"
        ? [{ id: "installation" as const, label: "App installed on the repo with the expected permissions, at organisation level", ok: false, detail: got.msg }, ...unknownAll("Not checked: the repository could not be read.").filter((r) => r.id !== "installation")]
        : unknownAll(got.msg);
      return record(results, false);
    }
    const facts = got.facts;
    const checks = [...judgeProtections(facts, l.planCtx.requiredChecks), judgeOwners(facts)];
    const rulesOk = checks.filter((c) => c.id === "ruleset" || c.id === "bypass").every((c) => c.ok);
    const lastCanary = (await deps.pool.query<{ at: string | null }>(`select data->>'canaryAt' as at from repo_config where org_id = $1 and repo_id = $2`, [j.orgId, l.repo.id])).rows[0]?.at;
    const due = !lastCanary || deps.now().getTime() - new Date(lastCanary).getTime() >= (deps.cfg.canaryEveryMs ?? 24 * 3600_000);
    const wantCanary = p.value.trigger !== "schedule" || due;
    let canaryRan = false;
    if (wantCanary) {
      if (!rulesOk) checks.push(...judgeCanary(null, "Not tried: the branch rules are not in place, so a direct push would prove nothing."));
      else {
        const c = await deps.broker.canary({ repo: l.full, prefix: l.planCtx.branchPrefix, ...(deps.cfg.canaryWaitMs !== undefined ? { waitMs: deps.cfg.canaryWaitMs } : {}) });
        if (c.ok) { canaryRan = true; checks.push(...judgeCanary(c.canary as CanaryResult)); }
        else checks.push(...judgeCanary(null, c.msg));
      }
    }
    checks.push(judgeRunner(facts, deps.cfg.runnerToolchains ?? DEFAULT_TOOLCHAINS));
    checks.push(judgeGuidelines(assess(facts, l.assessCtx)));
    return record(checks, canaryRan);
  }, (msg) => record(unknownAll(msg), false));
}

/* ------------------------------------------------------------------ sync ---- */

/**
 * Keeps a repo in step with GitHub: the checks and merge state of an open onboarding pull request, a verification that has not happened yet after the merge, and
 * (for a Ready repo) the scheduled re-check. The scheduler enqueues one per repo that needs it.
 */
export async function onboardingSync(j: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("onboarding.sync", j.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { deps } = ctx;
  const l = await load(deps, j.orgId, p.value.repoId);
  if (!l) return { skipped: "The repo is gone or has no GitHub name." };
  const d = l.doc;
  const now = deps.now();
  if (d.pr && d.pr.state === "open" && ["pr_opened", "pr_checks", "assessed"].includes(d.stage) && d.busy !== "opening_pr" && d.busy !== "updating_pr") {
    const s = await deps.broker.pullState(l.full, d.pr.number);
    const pr = s.pullRequest;
    const obs = {
      state: pr.state, headSha: pr.headSha, statuses: s.statusCount ?? 0,
      checks: (s.checks as Array<{ name?: string; status?: string; conclusion?: string | null; appSlug?: string | null }>).map((c) => ({ name: String(c.name ?? ""), status: String(c.status ?? ""), conclusion: c.conclusion ?? null, app: c.appSlug ?? null })),
    };
    return withTx(deps.pool, (tx) => applyPrObservation(tx, j.orgId, { repoId: l.repo.id, now, gateCheckName: deps.cfg.gateCheckName ?? "Gantry gates", noCiGraceMs: deps.cfg.noCiGraceMs ?? 10 * 60_000, obs }));
  }
  const bucket = (ms: number): number => Math.floor(now.getTime() / ms);
  if (d.stage === "pr_merged" && !d.busy) {
    // The verification after a merge did not finish (GitHub or the broker did not answer): try again.
    await withTx(deps.pool, (tx) => enqueue(tx, { orgId: j.orgId, ...job("onboarding.verify", { repoId: l.repo.id, runId: d.runId ?? null, trigger: "merge" }, { dedupeKey: `onboarding.verify:${l.repo.id}:retry:${bucket(5 * 60_000)}` }) }));
    return { requeued: "verify" };
  }
  if (d.stage === "ready" && !d.exception && !d.busy) {
    await withTx(deps.pool, (tx) => enqueue(tx, { orgId: j.orgId, ...job("onboarding.verify", { repoId: l.repo.id, runId: null, trigger: "schedule" }, { dedupeKey: `onboarding.verify:${l.repo.id}:schedule:${bucket(deps.cfg.readinessEveryMs ?? 6 * 3600_000)}` }) }));
    return { requeued: "recheck" };
  }
  return { idle: true };
}
