import { RepoContext } from "@gantry/domain";
import { z } from "zod";
import { failFor, jsonRequest, type JsonResponse } from "./http.js";

export interface PublishRequest {
  attemptId: string;
  fencing: number;
  repo: string;
  volume: string;
  branch: string;
  base?: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  /** The agent's forbidden paths; the broker refuses a commit that touches one (guardrail_breach). */
  denyPaths?: string[];
}

export interface PublishResult {
  branch: string;
  headSha: string | null;
  noop: boolean;
  alreadyPublished: boolean;
  commits: Array<{ localSha: string; sha: string }>;
  pullRequest: { number: number; url: string; created: boolean } | null;
}

export type PublishOutcome =
  | { ok: true; result: PublishResult }
  /** The broker refused for a reason that is final for this attempt (fenced, non-linear history, bad branch). */
  | { ok: false; code: string; msg: string; fenced: boolean };

export interface PullState {
  pullRequest: { number: number; state: "open" | "closed" | "merged"; draft: boolean; headSha: string | null; mergeCommitSha?: string | null; mergedAt?: string | null };
  checks: unknown[];
  /** Commit statuses reported on the head (older CI reporting); 0 when none. */
  statusCount?: number;
  mergeable: boolean | null;
  mergeableState: string | null;
}

export type MergeOutcome =
  | { ok: true; merged: boolean; mergeSha: string | null; alreadyMerged: boolean }
  | { ok: false; code: "head_moved" | "not_mergeable" | "not_open" | "fenced" | string; msg: string; headSha?: string };

/** Onboarding (spec 11.3). Expected refusals are values; anything else throws (transient: retried, permanent: not). */
export type InspectOutcome =
  | { ok: true; facts: Record<string, unknown> }
  /** The repository cannot be read: the App is not installed, it has no commits, or the stop state refuses. A person has to act (or wait). */
  | { ok: false; code: string; msg: string };

export interface OnboardingPrRequest {
  repo: string;
  branch: string;
  title: string;
  body: string;
  files: Array<{ path: string; content: string }>;
  commitMessage?: string;
  comment?: string;
}
export interface OnboardingPrResult { branch: string; number: number; url: string; headSha: string; created: boolean; changed: boolean }
export type OnboardingPrOutcome = { ok: true; pr: OnboardingPrResult } | { ok: false; code: string; msg: string };

export interface CanaryResult {
  published: boolean; draftOpened: boolean; prNumber: number | null; closed: boolean; cleaned: boolean;
  checks: Array<{ name: string; status: string; conclusion: string | null; app: string | null }>;
  directPush: "rejected" | "accepted" | "unknown"; directPushDetail: string; error: string | null;
}
export type CanaryOutcome = { ok: true; canary: CanaryResult } | { ok: false; code: string; msg: string };

export interface SeedOutcome {
  /** The convention files at the commit the workspace was seeded at. */
  repoContext: RepoContext | null;
  /** The convention files at the target branch head (the maintainers' version), when the seeded commit is not that head. Null when there is no base or the broker sends none. */
  baseRepoContext: RepoContext | null;
  /** Convention files the work order's branch changed against the target branch (`git diff base...head`), null when unknown. */
  conventionChanges: Array<{ path: string; status: "added" | "changed" | "removed" }> | null;
  base: string | null;
  baseBranch: string | null;
}

const ConventionChanges = z.array(z.object({ path: z.string().max(300), status: z.enum(["added", "changed", "removed"]) })).max(200);

/** gantry-github (spec 6.5): everything that touches GitHub goes through this service. */
export interface BrokerClient {
  inspect(repo: string, o?: { scan?: boolean }): Promise<InspectOutcome>;
  openOnboardingPr(b: OnboardingPrRequest): Promise<OnboardingPrOutcome>;
  mergeOnboardingPr(b: { repo: string; number: number; headSha: string; method: "squash" | "merge" | "rebase" }): Promise<MergeOutcome>;
  canary(b: { repo: string; prefix: string; waitMs?: number }): Promise<CanaryOutcome>;
  /** Seeds the run's workspace; answers the repository context (convention files at the commit) the broker read while it had the checkout. Null when an older broker does not send one. */
  seed(b: { repo: string; commit: string; volume: string; baseBranch?: string }): Promise<SeedOutcome>;
  /** The repository's default branch and its head commit as GitHub has them now (not a stored value). A refusal is a value: the caller keeps what it has and records why. */
  defaultHead(repo: string): Promise<{ ok: true; branch: string; sha: string; committedAt?: string } | { ok: false; code: string; msg: string }>;
  publish(b: PublishRequest): Promise<PublishOutcome>;
  gateCheck(b: { woId: string; repo: string; headSha: string; state: "passing" | "failing" | "pending"; summary?: string }): Promise<{ ok: boolean; skipped?: string }>;
  convertToDraft(b: { woId: string; repo: string; number: number }): Promise<{ ok: boolean; skipped?: string }>;
  /** Writes the Review agent's description (and optional title) to the work order's pull request. A refusal (fenced, closed, not the work order's) is a value. */
  describePr(b: { woId: string; repo: string; number: number; title?: string; body: string }): Promise<{ ok: true; changed: boolean; redacted: number } | { ok: false; code: string; msg: string }>;
  pullState(repo: string, number: number): Promise<PullState>;
  merge(b: { woId: string; repo: string; number: number; headSha: string; method: "squash" | "merge" | "rebase"; commitTitle?: string }): Promise<MergeOutcome>;
  reconcile(b: { repo: string; branchPrefix: string }): Promise<Record<string, unknown>>;
}

export function brokerClient(base: string, token: string, fetchImpl?: typeof fetch): BrokerClient {
  const call = <T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<JsonResponse<T>> =>
    jsonRequest<T>(base, token, method, path, body, { ...(fetchImpl ? { fetchImpl } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const ok = (r: { status: number }): boolean => r.status >= 200 && r.status < 300;
  const codeOf = (r: { status: number; body: unknown }): string => String((r.body as { code?: string }).code ?? `http_${r.status}`);
  const msgOf = (r: { status: number; body: unknown }): string => String((r.body as { msg?: string }).msg ?? `HTTP ${r.status}`);
  /** 409 and 404 answers that say why the repository cannot be worked on right now (fenced, not installed, nothing to add) are values for the handler to record. */
  const refusal = (r: { status: number; body: unknown }): { ok: false; code: string; msg: string } | null =>
    r.status === 404 || r.status === 409 || r.status === 422 ? { ok: false, code: codeOf(r), msg: msgOf(r) } : null;
  return {
    async inspect(repo, o = {}) {
      const r = await call<Record<string, unknown>>("POST", "/v1/onboarding/inspect", { repo, ...(o.scan === false ? { scan: false } : {}) }, 300_000);
      if (ok(r)) return { ok: true, facts: r.body };
      return refusal(r) ?? failFor("github inspect", r);
    },
    async openOnboardingPr(b) {
      const r = await call<OnboardingPrResult & { ok: boolean }>("POST", "/v1/onboarding/pr", b, 300_000);
      if (ok(r)) return { ok: true, pr: { branch: r.body.branch, number: r.body.number, url: r.body.url, headSha: r.body.headSha, created: r.body.created, changed: r.body.changed } };
      return refusal(r) ?? failFor("github onboarding pr", r);
    },
    async mergeOnboardingPr(b) {
      const r = await call<{ merged: boolean; mergeSha: string | null; alreadyMerged: boolean }>("POST", "/v1/onboarding/merge", b, 120_000);
      if (ok(r)) return { ok: true, merged: r.body.merged === true, mergeSha: r.body.mergeSha ?? null, alreadyMerged: r.body.alreadyMerged === true };
      if (r.status === 409 || r.status === 404) return { ok: false, code: codeOf(r), msg: msgOf(r), ...(typeof (r.body as unknown as { headSha?: string }).headSha === "string" ? { headSha: (r.body as unknown as { headSha: string }).headSha } : {}) };
      return failFor("github onboarding merge", r);
    },
    async canary(b) {
      const r = await call<CanaryResult & { ok: boolean }>("POST", "/v1/onboarding/canary", b, 600_000);
      if (ok(r)) return { ok: true, canary: r.body };
      return refusal(r) ?? failFor("github canary", r);
    },
    async seed(b) {
      const r = await call<{ repoContext?: unknown; base?: unknown; baseBranch?: unknown }>("POST", "/v1/workspaces/seed", b, 600_000);
      if (!ok(r)) failFor("github seed", r);
      const rc = RepoContext.safeParse(r.body.repoContext);
      const brc = RepoContext.safeParse((r.body as { baseRepoContext?: unknown }).baseRepoContext);
      const cc = ConventionChanges.safeParse((r.body as { conventionChanges?: unknown }).conventionChanges);
      const base = typeof r.body.base === "string" && /^[0-9a-f]{40}$/.test(r.body.base) ? r.body.base : null;
      return { repoContext: rc.success ? rc.data : null, baseRepoContext: brc.success ? brc.data : null, conventionChanges: cc.success ? cc.data : null, base, baseBranch: base && typeof r.body.baseBranch === "string" ? r.body.baseBranch : null };
    },
    async defaultHead(repo) {
      const r = await call<{ branch?: unknown; sha?: unknown; committedAt?: unknown }>("GET", `/v1/default-head?repo=${encodeURIComponent(repo)}`, undefined, 30_000);
      if (ok(r) && typeof r.body.branch === "string" && typeof r.body.sha === "string" && /^[0-9a-f]{40}$/.test(r.body.sha)) return { ok: true, branch: r.body.branch, sha: r.body.sha, ...(typeof r.body.committedAt === "string" && Number.isFinite(Date.parse(r.body.committedAt)) ? { committedAt: r.body.committedAt } : {}) };
      if (ok(r)) return { ok: false, code: "bad_answer", msg: "The broker answered without a branch head." };
      return refusal(r) ?? { ok: false, code: codeOf(r), msg: msgOf(r) };
    },
    async publish(b) {
      const r = await call<PublishResult & { ok: boolean }>("POST", "/v1/publish", b, 600_000);
      if (ok(r)) return { ok: true, result: r.body };
      // fenced: the attempt was superseded or stopped; the rest are about the workspace itself and will not change on retry.
      if (r.status === 409 || r.status === 422) return { ok: false, code: codeOf(r), msg: msgOf(r), fenced: codeOf(r) === "fenced" };
      return failFor("github publish", r);
    },
    async gateCheck(b) {
      const r = await call("POST", "/v1/checks/gate", b);
      if (ok(r)) return { ok: true };
      if (r.status === 409 && codeOf(r) === "fenced") return { ok: false, skipped: msgOf(r) };
      return failFor("github gate check", r);
    },
    async convertToDraft(b) {
      const r = await call("POST", "/v1/pulls/draft", b);
      if (ok(r)) return { ok: true };
      // Already merged or closed: there is nothing to convert.
      if (r.status === 409 && ["not_open", "fenced"].includes(codeOf(r))) return { ok: false, skipped: msgOf(r) };
      return failFor("github draft", r);
    },
    async describePr(b) {
      const r = await call<{ changed: boolean; redacted: number }>("POST", "/v1/pulls/describe", b, 60_000);
      if (ok(r)) return { ok: true, changed: r.body.changed === true, redacted: Number(r.body.redacted) || 0 };
      return refusal(r) ?? failFor("github describe", r);
    },
    async pullState(repo, number) {
      const r = await call<PullState>("GET", `/v1/pull-state?repo=${encodeURIComponent(repo)}&number=${number}`);
      if (!ok(r)) return failFor("github pull-state", r);
      return r.body;
    },
    async merge(b) {
      const r = await call<{ merged: boolean; mergeSha: string | null; alreadyMerged: boolean }>("POST", "/v1/pulls/merge", b, 120_000);
      if (ok(r)) return { ok: true, merged: r.body.merged === true, mergeSha: r.body.mergeSha ?? null, alreadyMerged: r.body.alreadyMerged === true };
      if (r.status === 409) return { ok: false, code: codeOf(r), msg: msgOf(r), ...(typeof (r.body as unknown as { headSha?: string }).headSha === "string" ? { headSha: (r.body as unknown as { headSha: string }).headSha } : {}) };
      return failFor("github merge", r);
    },
    async reconcile(b) {
      const r = await call("POST", "/v1/reconcile", b, 300_000);
      if (!ok(r)) failFor("github reconcile", r);
      return r.body;
    },
  };
}

