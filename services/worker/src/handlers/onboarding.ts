/**
 * Repository onboarding jobs (spec 11.3). Each reads GitHub through the broker (never directly), decides with the pure logic in @gantry/domain, and records the outcome through the
 * API's `apply*` functions in one transaction. The assessment is made by the onboarding agent's deterministic adapter (`stub`, spec 10.1): it reads the repository's own files
 * and settings, so every finding is a fact about the repo; no model is consulted and none is needed for it. A job whose run is no longer the repo's current one does nothing.
 */
import {
  applyAssessment, applyMergeRefused, applyMerged, applyPrFailed, applyPrObservation, applyPrOpened, applyVerification, docOf, guidelinesFor, job, parseJob, readRepoRow, type Doc, type RepoRow,
} from "@gantry/api/core";
import { enqueue, withTx, type Job } from "@gantry/db";
import {
  PR_TITLE, RepoFacts, assess, judgeCanary, judgeGuidelines, judgeOwners, judgeProtections, judgeRunner, planPr, prBody, type AssessContext, type PlanContext, type ReadinessResult,
} from "@gantry/domain";
import type { CanaryResult } from "../clients/broker.js";
import type { Deps } from "../deps.js";
import { DEFAULT_TOOLCHAINS } from "../toolchains.js";
import { errMsg, PermanentError, TransientError } from "../errors.js";
import type { HandlerCtx } from "../runner.js";

/** The adapter the assessment runs with (spec 10.1). */
export const ASSESSOR = "stub";
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

/* ------------------------------------------------------------------ assess ---- */

export async function onboardingAssess(j: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("onboarding.assess", j.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { deps } = ctx;
  const l = await load(deps, j.orgId, p.value.repoId);
  if (!l) return { skipped: "The repo is gone or has no GitHub name." };
  if (l.doc.runId !== p.value.runId || l.doc.busy !== "assessing") return { skipped: "This run is no longer current." };
  const record = (result: Parameters<typeof applyAssessment>[2]["result"]) =>
    withTx(deps.pool, (tx) => applyAssessment(tx, j.orgId, { repoId: l.repo.id, runId: p.value.runId, now: deps.now(), adapter: ASSESSOR, result }));
  const r = await guarded(ctx, async () => {
    const got = await inspect(deps, l.full, true);
    if (!got.ok) return record(NEEDS_PERSON.has(got.code) || got.code === "fenced" ? { kind: "blocked", code: got.code, msg: got.msg } : { kind: "failed", msg: got.msg });
    if (got.facts.archived) return record({ kind: "blocked", code: "archived", msg: `${l.full} is archived on GitHub. Unarchive it first.` });
    const findings = assess(got.facts, l.assessCtx);
    return record({ kind: "ok", findings, language: got.facts.language, defaultBranch: got.facts.defaultBranch, headSha: got.facts.headSha });
  }, (msg) => record({ kind: "failed", msg }));
  return r;
}

/* ------------------------------------------------------------------ open or update the pull request ---- */

export async function onboardingOpenPr(j: Job, ctx: HandlerCtx): Promise<unknown> {
  const p = parseJob("onboarding.open_pr", j.payload);
  if (!p.ok) throw new PermanentError(p.error, "bad_payload");
  const { deps } = ctx;
  const l = await load(deps, j.orgId, p.value.repoId);
  if (!l) return { skipped: "The repo is gone or has no GitHub name." };
  if (l.doc.runId !== p.value.runId || !["opening_pr", "updating_pr"].includes(l.doc.busy ?? "")) return { skipped: "This request is no longer current." };
  const fail = (code: string, msg: string) => withTx(deps.pool, (tx) => applyPrFailed(tx, j.orgId, { repoId: l.repo.id, runId: p.value.runId, now: deps.now(), code, msg }));
  return guarded(ctx, async () => {
    // The pull request is planned from the repository as it is now, not from the findings of an hour ago.
    const got = await inspect(deps, l.full, false);
    if (!got.ok) return fail(got.code, got.msg);
    const findings = assess(got.facts, l.assessCtx);
    const files = planPr(got.facts, findings, l.planCtx);
    if (!files.length && !p.value.request) return fail("nothing_to_add", "the repo already has everything a pull request can add. Verify it instead.");
    const branch = `${l.planCtx.branchPrefix}onboarding`;
    const request = p.value.request;
    const out = await deps.broker.openOnboardingPr({
      repo: l.full, branch, title: PR_TITLE(l.full), body: prBody(files, findings, ASSESSOR),
      files: files.map((f) => ({ path: f.path, content: f.content })),
      ...(request ? { comment: `Change requested${p.value.by ? ` by ${p.value.by}` : ""}: ${request}\n\nThe onboarding agent's adapter (${ASSESSOR}) regenerates the files from the repository and the guidelines as they are now; it does not interpret free text. A person should apply this request by hand on the branch.` } : {}),
    });
    if (!out.ok) return fail(out.code, out.msg);
    const applied = await withTx(deps.pool, (tx) => applyPrOpened(tx, j.orgId, { repoId: l.repo.id, runId: p.value.runId, now: deps.now(), pr: { ...out.pr, title: PR_TITLE(l.full) }, files, request, by: p.value.by }));
    return { ...applied, number: out.pr.number, changed: out.pr.changed };
  }, (msg) => fail("github", msg));
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
  if (d.pr && d.pr.state === "open" && ["pr_opened", "pr_checks"].includes(d.stage) && d.busy !== "opening_pr" && d.busy !== "updating_pr") {
    const s = await deps.broker.pullState(l.full, d.pr.number);
    const pr = s.pullRequest;
    const obs = {
      state: pr.state, headSha: pr.headSha,
      checks: (s.checks as Array<{ name?: string; status?: string; conclusion?: string | null; appSlug?: string | null }>).map((c) => ({ name: String(c.name ?? ""), status: String(c.status ?? ""), conclusion: c.conclusion ?? null, app: c.appSlug ?? null })),
    };
    return withTx(deps.pool, (tx) => applyPrObservation(tx, j.orgId, { repoId: l.repo.id, now, gateCheckName: deps.cfg.gateCheckName ?? "Gantry gates", obs }));
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
