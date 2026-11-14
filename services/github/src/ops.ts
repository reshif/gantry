/**
 * The broker's other operations (spec 6.5, 11): set the Gantry gate check, read pull request state, convert to draft, merge a specific commit,
 * read repository protections, list and reconcile deliveries, and poll. Every write is fenced by the API first and runs with a one-repository,
 * least-permission installation token.
 */
import { z } from "zod";
import type { ApiClient, BrokerRepo, Fence, FencePurpose } from "./api.js";
import type { GithubConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { GithubApp, splitRepo, toApiError } from "./github.js";
import { prFact } from "./publish.js";

export interface OpDeps { cfg: Pick<GithubConfig, "gateCheckName" | "issueLabel">; app: GithubApp; api: ApiClient; appId: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = (route: string, p?: Record<string, unknown>) => Promise<{ data: any; status: number }>;
const rq = (o: { request: unknown }): Req => (o.request as { bind: (x: unknown) => Req }).bind(o);
const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const sha = z.string().regex(/^[0-9a-f]{7,64}$/);

/** Maps a GitHub failure to the broker's HTTP error. */
export function gh(e: unknown): BrokerError {
  if (e instanceof BrokerError) return e;
  const a = toApiError(e);
  const status = a.status === 404 ? 404 : a.status === 401 || a.status === 403 ? 502 : a.status === 429 ? 429 : a.status === 409 || a.status === 422 ? 409 : a.status === 405 ? 409 : 502;
  return new BrokerError(status, "github", a.message, { githubStatus: a.status });
}

async function fenced(d: OpDeps, woId: string, purpose: FencePurpose, repo: string): Promise<Extract<Fence, { allow: true }>> {
  const f = await d.api.fenceWorkOrder(woId, purpose, repo);
  if (!f.allow) throw new BrokerError(f.code === "unavailable" ? 503 : 409, f.code === "unavailable" ? "api_unavailable" : "fenced", f.reason, { fence: f.code });
  return f;
}

// ---------------------------------------------------------------- gate check

export const GateCheckBody = z.object({
  woId: z.string().min(1).max(200), repo: repoName, headSha: sha,
  state: z.enum(["passing", "failing", "pending"]),
  summary: z.string().max(20000).optional(), detailsUrl: z.string().url().max(1000).optional(),
}).strict();
export type GateCheckBody = z.infer<typeof GateCheckBody>;

/**
 * Gantry's one check (spec 11.2): passing only when every Gantry gate for the work order has passed, failing on halt or kill, which blocks human merges too.
 * Setting it to failing or pending is always allowed under a stop (that is how a stop reaches GitHub); passing is refused in a stopped scope.
 */
export async function setGateCheck(d: OpDeps, b: GateCheckBody): Promise<{ ok: true; checkRunId: number; state: string; headSha: string }> {
  await fenced(d, b.woId, b.state === "passing" ? "check_pass" : b.state === "failing" ? "check_fail" : "check_pending", b.repo);
  const { owner, name } = splitRepo(b.repo);
  const text: Record<string, string> = { passing: "All Gantry gates have passed.", failing: "A Gantry gate has not passed, or the work order is stopped.", pending: "Gantry gates are still open." };
  const output = { title: b.state === "passing" ? "Gates passed" : b.state === "failing" ? "Blocked by Gantry" : "Waiting on gates", summary: b.summary ?? text[b.state]! };
  const payload = { name: d.cfg.gateCheckName, head_sha: b.headSha, status: b.state === "pending" ? "in_progress" : "completed", ...(b.state === "pending" ? {} : { conclusion: b.state === "passing" ? "success" : "failure" }), output, ...(b.detailsUrl ? { details_url: b.detailsUrl } : {}) };
  try {
    const id = await d.app.withRepo(b.repo, "gate_check", async (c) => {
      const req = rq(c.octokit);
      const found = (await req("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo: name, ref: b.headSha, check_name: d.cfg.gateCheckName, filter: "latest" })).data.check_runs as { id: number }[];
      const run = found[0]
        ? (await c.write(() => req("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", { owner, repo: name, check_run_id: found[0]!.id, ...payload }))).data
        : (await c.write(() => req("POST /repos/{owner}/{repo}/check-runs", { owner, repo: name, ...payload }))).data;
      return run.id as number;
    });
    // Keep Gantry's copy current; the poll would do it too, so a failure here is not an error.
    await d.api.postFacts({ source: "poll", repo: b.repo, checks: [{ headSha: b.headSha, name: d.cfg.gateCheckName, status: payload.status, conclusion: (payload as { conclusion?: string }).conclusion ?? null, githubId: id, appSlug: null }] });
    return { ok: true, checkRunId: id, state: b.state, headSha: b.headSha };
  } catch (e) { throw gh(e); }
}

// ---------------------------------------------------------------- reading state

export interface PrState {
  pullRequest: Record<string, unknown>;
  checks: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  /** Approving reviews made against the current head commit (spec 11.2: approval of the latest push). */
  approvals: string[];
  status: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
}

async function paged<T>(req: Req, route: string, p: Record<string, unknown>, pick: (data: any) => T[], max = 5): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let page = 1; page <= max; page++) {
    const rows = pick((await req(route, { ...p, per_page: 100, page })).data);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

const checkFact = (c: Record<string, any>, headSha: string): Record<string, unknown> => ({ headSha, name: c.name, status: c.status, conclusion: c.conclusion ?? null, githubId: c.id ?? null, completedAt: c.completed_at ?? null, appSlug: c.app?.slug ?? null }); // eslint-disable-line @typescript-eslint/no-explicit-any
const reviewFact = (r: Record<string, any>, prNumber: number): Record<string, unknown> => ({ prNumber, githubId: r.id ?? null, reviewer: r.user?.login ?? "unknown", state: String(r.state ?? "COMMENTED").toLowerCase(), body: r.body ?? "", submittedAt: r.submitted_at ?? null, commitId: r.commit_id ?? null }); // eslint-disable-line @typescript-eslint/no-explicit-any

export async function readPrState(d: OpDeps, repo: string, number: number): Promise<PrState> {
  const { owner, name } = splitRepo(repo);
  try {
    return await d.app.withRepo(repo, "read_state", async (c) => {
      const req = rq(c.octokit);
      const pr = (await req("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: number })).data;
      const head = pr.head.sha as string;
      const checks = await paged(req, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo: name, ref: head }, (x) => x.check_runs as Record<string, any>[]);
      const reviews = await paged(req, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo: name, pull_number: number }, (x) => x as Record<string, any>[]);
      const combined = (await req("GET /repos/{owner}/{repo}/commits/{ref}/status", { owner, repo: name, ref: head }).catch(() => null))?.data;
      const status = combined?.state ?? null;
      // Commit statuses (the older CI reporting) count as CI: the sync needs to know whether anything at all reported on this head.
      const statusCount = Number(combined?.total_count ?? (Array.isArray(combined?.statuses) ? combined.statuses.length : 0)) || 0;
      const latest = new Map<string, Record<string, any>>();
      for (const r of reviews) if (r.state !== "COMMENTED" && r.user?.login) latest.set(r.user.login, r);
      return {
        pullRequest: prFact(pr), checks: checks.map((x) => checkFact(x, head)), reviews: reviews.map((r) => reviewFact(r, number)),
        approvals: [...latest.values()].filter((r) => r.state === "APPROVED" && r.commit_id === head).map((r) => r.user.login as string),
        status, statusCount, mergeable: pr.mergeable ?? null, mergeableState: pr.mergeable_state ?? null,
      };
    });
  } catch (e) { throw gh(e); }
}

// ---------------------------------------------------------------- draft

export const DraftBody = z.object({ woId: z.string().min(1).max(200), repo: repoName, number: z.number().int().positive() }).strict();

/** Convert to draft (GraphQL). Used when a stop is enforced (spec 4.4 step 4): a draft cannot be merged. */
export async function convertToDraft(d: OpDeps, b: z.infer<typeof DraftBody>): Promise<{ ok: true; draft: true; alreadyDraft: boolean }> {
  await fenced(d, b.woId, "draft", b.repo);
  const { owner, name } = splitRepo(b.repo);
  try {
    return await d.app.withRepo(b.repo, "draft", async (c) => {
      const pr = (await rq(c.octokit)("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: b.number })).data;
      if (pr.draft) return { ok: true as const, draft: true as const, alreadyDraft: true };
      if (pr.state !== "open") throw new BrokerError(409, "not_open", `Pull request #${b.number} is ${pr.merged_at ? "merged" : "closed"}.`);
      await c.write(() => c.octokit.graphql(`mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }`, { id: pr.node_id }));
      return { ok: true as const, draft: true as const, alreadyDraft: false };
    });
  } catch (e) { throw gh(e); }
}

// ---------------------------------------------------------------- merge

export const MergeBody = z.object({
  woId: z.string().min(1).max(200), repo: repoName, number: z.number().int().positive(),
  /** The exact head commit that was approved (spec 11.5). GitHub refuses the merge if the head moved. */
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  method: z.enum(["squash", "merge", "rebase"]).default("squash"),
  commitTitle: z.string().max(250).optional(),
}).strict();

export async function mergePullRequest(d: OpDeps, b: z.infer<typeof MergeBody>): Promise<{ ok: true; merged: boolean; mergeSha: string | null; alreadyMerged: boolean }> {
  await fenced(d, b.woId, "merge", b.repo);
  return mergeCore(d, b);
}

/** The merge itself, after the caller's fence (a work order for gate merges, the repository for onboarding). */
export async function mergeCore(d: OpDeps, b: { repo: string; number: number; headSha: string; method: "squash" | "merge" | "rebase"; commitTitle?: string | undefined }): Promise<{ ok: true; merged: boolean; mergeSha: string | null; alreadyMerged: boolean }> {
  const { owner, name } = splitRepo(b.repo);
  try {
    const out = await d.app.withRepo(b.repo, "merge", async (c) => {
      const req = rq(c.octokit);
      const pr = (await req("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: b.number })).data;
      // F4: re-check against the real system before acting, so a retry after a crash merges at most once.
      if (pr.merged_at) return { merged: true, mergeSha: (pr.merge_commit_sha ?? null) as string | null, alreadyMerged: true, pr };
      if (pr.state !== "open") throw new BrokerError(409, "not_open", `Pull request #${b.number} is closed.`);
      if (pr.head.sha !== b.headSha) throw new BrokerError(409, "head_moved", `The head of #${b.number} is ${String(pr.head.sha).slice(0, 7)}, not the approved ${b.headSha.slice(0, 7)}.`, { headSha: pr.head.sha });
      try {
        const m = (await c.write(() => req("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", { owner, repo: name, pull_number: b.number, sha: b.headSha, merge_method: b.method, ...(b.commitTitle ? { commit_title: b.commitTitle } : {}) }))).data;
        return { merged: m.merged === true, mergeSha: (m.sha ?? null) as string | null, alreadyMerged: false, pr };
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st === 409) throw new BrokerError(409, "head_moved", "The head commit changed; the approved commit was not merged.");
        if (st === 405) throw new BrokerError(409, "not_mergeable", `GitHub refuses the merge: ${toApiError(e).message}`);
        throw e;
      }
    });
    // Only GitHub reporting the pull request as merged closes the gate: send the fact, the API decides.
    if (out.merged) {
      const merged = { ...prFact(out.pr), state: "merged", mergedAt: out.pr.merged_at ?? new Date().toISOString(), mergeCommitSha: out.mergeSha ?? null, headSha: b.headSha };
      await d.api.postFacts({ source: "poll", repo: b.repo, pullRequests: [merged] });
    }
    return { ok: true, merged: out.merged, mergeSha: out.mergeSha, alreadyMerged: out.alreadyMerged };
  } catch (e) { throw gh(e); }
}

// ---------------------------------------------------------------- protections (onboarding, spec 11.2, 11.3)

export interface ProtectionReport {
  repo: string;
  defaultBranch: string;
  serverVersion: string | null;
  installation: { id: number; permissions: Record<string, string>; repositorySelection: string | null; targetType: string | null } | null;
  branchProtection: { requiresPullRequest: boolean; approvals: number; codeOwners: boolean; requiredChecks: string[]; enforceAdmins: boolean } | null;
  rulesets: { id: number; name: string; target: string; enforcement: string; ruleTypes: string[]; requiredChecks: string[]; pinnedChecks: string[]; approvals: number; codeOwners: boolean; bypassActors: { actorType: string; actorId: number | null }[] }[];
  /** Readiness fails if the App is on any bypass list (spec 11.2). */
  appOnBypassList: boolean;
  requiresGantryCheck: boolean;
  /** An active ruleset requires the Gantry check and pins it to this App (`integration_id`), so no other app or status can satisfy it (spec 11.3). */
  gantryCheckPinned: boolean;
}

export async function readProtections(d: OpDeps, repo: string): Promise<ProtectionReport> {
  const { owner, name } = splitRepo(repo);
  try {
    const installationId = await d.app.installationFor(repo);
    const inst = await d.app.jwt.request("GET /app/installations/{installation_id}", { installation_id: installationId }).then((r) => r.data as Record<string, any>, () => null); // eslint-disable-line @typescript-eslint/no-explicit-any
    const serverVersion = await d.app.anonymous.request("GET /meta").then((r) => ((r.data as { installed_version?: string }).installed_version ?? null), () => null);
    return await d.app.withRepo(repo, "protections", async (c) => {
      const req = rq(c.octokit);
      const info = (await req("GET /repos/{owner}/{repo}", { owner, repo: name })).data;
      const defaultBranch = info.default_branch as string;
      const bp = await req("GET /repos/{owner}/{repo}/branches/{branch}/protection", { owner, repo: name, branch: defaultBranch }).then((r) => r.data, (e) => { if ((e as { status?: number }).status === 404 || (e as { status?: number }).status === 403) return null; throw e; });
      const list = (await req("GET /repos/{owner}/{repo}/rulesets", { owner, repo: name, includes_parents: true }).then((r) => r.data as { id: number }[], () => [])) as { id: number }[];
      const rulesets: ProtectionReport["rulesets"] = [];
      for (const rs of list) {
        const full = (await req("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", { owner, repo: name, ruleset_id: rs.id })).data;
        const rules = (full.rules ?? []) as { type: string; parameters?: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
        const pr = rules.find((x) => x.type === "pull_request")?.parameters;
        const checks = rules.find((x) => x.type === "required_status_checks")?.parameters?.required_status_checks as { context: string; integration_id?: number }[] | undefined;
        rulesets.push({
          id: full.id, name: full.name, target: full.target, enforcement: full.enforcement, ruleTypes: rules.map((x) => x.type), requiredChecks: (checks ?? []).map((x) => x.context), pinnedChecks: (checks ?? []).filter((x) => x.integration_id === d.appId).map((x) => x.context),
          approvals: Number(pr?.required_approving_review_count ?? 0), codeOwners: pr?.require_code_owner_review === true,
          bypassActors: ((full.bypass_actors ?? []) as { actor_type: string; actor_id: number | null }[]).map((a) => ({ actorType: a.actor_type, actorId: a.actor_id })),
        });
      }
      const active = rulesets.filter((r) => r.enforcement === "active");
      const appOnBypassList = active.some((r) => r.bypassActors.some((a) => a.actorType === "Integration" && a.actorId === d.appId))
        || ((bp?.required_pull_request_reviews?.bypass_pull_request_allowances?.apps ?? []) as { id?: number; slug?: string }[]).some((a) => a.id === d.appId || a.slug === inst?.app_slug);
      const requiredChecks = new Set<string>([...(bp?.required_status_checks?.contexts ?? []), ...active.flatMap((r) => r.requiredChecks)]);
      return {
        repo, defaultBranch, serverVersion, appOnBypassList, requiresGantryCheck: requiredChecks.has(d.cfg.gateCheckName), gantryCheckPinned: active.some((r) => r.pinnedChecks.includes(d.cfg.gateCheckName)), rulesets,
        installation: inst ? { id: installationId, permissions: (inst.permissions ?? {}) as Record<string, string>, repositorySelection: inst.repository_selection ?? null, targetType: inst.target_type ?? null } : null,
        branchProtection: bp ? { requiresPullRequest: !!bp.required_pull_request_reviews, approvals: Number(bp.required_pull_request_reviews?.required_approving_review_count ?? 0), codeOwners: bp.required_pull_request_reviews?.require_code_owner_reviews === true, requiredChecks: bp.required_status_checks?.contexts ?? [], enforceAdmins: bp.enforce_admins?.enabled === true } : null,
      };
    });
  } catch (e) { throw gh(e); }
}

// ---------------------------------------------------------------- deliveries (webhooks)

export interface DeliverySummary { id: number; guid: string; event: string; action: string | null; deliveredAt: string; statusCode: number; status: string; redelivery: boolean }

export async function listDeliveries(d: OpDeps, limit = 50): Promise<DeliverySummary[]> {
  try {
    const rows = (await d.app.jwt.request("GET /app/hook/deliveries", { per_page: Math.min(100, limit) })).data as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    return rows.map((r) => ({ id: r.id, guid: r.guid, event: r.event, action: r.action ?? null, deliveredAt: r.delivered_at, statusCode: r.status_code, status: r.status, redelivery: r.redelivery === true }));
  } catch (e) { throw gh(e); }
}

/** Failed deliveries (no 2xx answer) are redelivered once per GUID, the receiving side deduplicates by delivery id (spec 11.6). */
export async function reconcileDeliveries(d: OpDeps, limit = 50): Promise<{ checked: number; failed: number; redelivered: number }> {
  const rows = await listDeliveries(d, limit);
  const ok = new Set(rows.filter((r) => r.statusCode >= 200 && r.statusCode < 300).map((r) => r.guid));
  const failed = rows.filter((r) => !(r.statusCode >= 200 && r.statusCode < 300) && !ok.has(r.guid) && !r.redelivery);
  let redelivered = 0;
  for (const f of failed) {
    try { await d.app.jwt.request("POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: f.id }); redelivered++; } catch { /* left for the next pass */ }
  }
  return { checked: rows.length, failed: failed.length, redelivered };
}

// ---------------------------------------------------------------- polling (spec 11.6)

/** The default branch and its tip commit, or null when it cannot be read (the poll is still useful without it). */
async function defaultBranchTip(req: ReturnType<typeof rq>, owner: string, name: string): Promise<{ branch: string; sha: string } | null> {
  try {
    const repo = (await req("GET /repos/{owner}/{repo}", { owner, repo: name })).data as { default_branch?: unknown };
    const branch = typeof repo.default_branch === "string" && repo.default_branch ? repo.default_branch : null;
    if (!branch) return null;
    const ref = (await req("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo: name, ref: `heads/${branch}` })).data as { object?: { sha?: unknown } };
    const sha = ref.object?.sha;
    return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? { branch, sha } : null;
  } catch { return null; }
}

/**
 * One reconciliation pass for a repository: recently updated pull requests on Gantry's branches with their checks and reviews, and issues carrying the
 * trigger label. The same pass runs when webhooks are available, to catch missed deliveries. The API records any difference as a drift event.
 */
export async function reconcileRepo(d: OpDeps, r: Pick<BrokerRepo, "repo" | "branchPrefix">): Promise<{ pullRequests: number; checks: number; reviews: number; issues: number; stored: boolean; drift: number }> {
  const { owner, name } = splitRepo(r.repo);
  try {
    const facts = await d.app.withRepo(r.repo, "read_state", async (c) => {
      const req = rq(c.octokit);
      const prs = (await req("GET /repos/{owner}/{repo}/pulls", { owner, repo: name, state: "all", sort: "updated", direction: "desc", per_page: 50 })).data as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      const mine = prs.filter((p) => typeof p.head?.ref === "string" && p.head.ref.startsWith(r.branchPrefix));
      const checks: Record<string, unknown>[] = [];
      const reviews: Record<string, unknown>[] = [];
      for (const p of mine) {
        if (p.state === "open") {
          const runs = await paged(req, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo: name, ref: p.head.sha }, (x) => x.check_runs as Record<string, any>[], 2); // eslint-disable-line @typescript-eslint/no-explicit-any
          checks.push(...runs.map((x) => checkFact(x, p.head.sha)));
        }
        const rv = await paged(req, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo: name, pull_number: p.number }, (x) => x as Record<string, any>[], 2); // eslint-disable-line @typescript-eslint/no-explicit-any
        reviews.push(...rv.map((x) => reviewFact(x, p.number)));
      }
      const issues = ((await req("GET /repos/{owner}/{repo}/issues", { owner, repo: name, labels: d.cfg.issueLabel, state: "open", per_page: 50 }).catch(() => ({ data: [] }))).data as Record<string, any>[]) // eslint-disable-line @typescript-eslint/no-explicit-any
        .filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: String(i.title ?? ""), labels: (i.labels ?? []).map((l: { name?: string } | string) => (typeof l === "string" ? l : l.name)).filter(Boolean), author: i.user?.login ?? null, url: i.html_url ?? null }));
      const base = await defaultBranchTip(req, owner, name);
      return { source: "poll", repo: r.repo, pullRequests: mine.map((p) => prFact(p)), checks, reviews, issues, ...(base ? { base } : {}) };
    });
    const res = await d.api.postFacts(facts);
    return { pullRequests: facts.pullRequests.length, checks: facts.checks.length, reviews: facts.reviews.length, issues: facts.issues.length, stored: res.kind === "ok", drift: res.kind === "ok" ? res.body.counts?.drift ?? 0 : 0 };
  } catch (e) { throw gh(e); }
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  lastRun: { at: string; repos: number; errors: number } | null = null;
  constructor(private readonly d: OpDeps, private readonly intervalMs: number, private readonly log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void }) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One pass over every repository the API lists. Overlapping passes are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let errors = 0, repos = 0;
    try {
      const list = await this.d.api.listRepos();
      if (list.kind !== "ok") { this.log.warn({ kind: list.kind }, "poll: could not list repositories"); return; }
      for (const r of list.body.repos) {
        repos++;
        try { await reconcileRepo(this.d, r); } catch (e) { errors++; this.log.warn({ repo: r.repo, err: (e as Error).message }, "poll: repository failed"); }
      }
      await reconcileDeliveries(this.d).catch(() => undefined);
    } finally {
      this.lastRun = { at: new Date().toISOString(), repos, errors };
      this.running = false;
    }
  }
}
