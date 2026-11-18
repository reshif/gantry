/**
 * Broker operations for repository onboarding and readiness (spec 11.1 to 11.3). Reads facts the assessment is built from, opens and updates the onboarding
 * pull request, merges it at the exact approved commit, and runs the live checks that need GitHub: the canary branch with a draft pull request, the CI check
 * on it, and the rejected direct push to the default branch. Every write is fenced by the API first and runs with a one-repository, least-permission token.
 * The broker reads untrusted repository content as data only: nothing from the repository is executed, and secret matches are reported by path, line and
 * rule, never by value.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { wantsContent } from "@gantry/domain";
import type { ApiClient, OnboardingPurpose } from "./api.js";
import { BrokerError } from "./errors.js";
import { gh, readProtections, mergeCore, type OpDeps } from "./ops.js";
import { prFact } from "./publish.js";
import { splitRepo } from "./github.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = (route: string, p?: Record<string, unknown>) => Promise<{ data: any; status: number }>;
const rq = (o: { request: unknown }): Req => (o.request as { bind: (x: unknown) => Req }).bind(o);
const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const branchName = z.string().min(1).max(250).regex(/^[A-Za-z0-9._/-]+$/).refine((b) => !b.includes("..") && !b.startsWith("/") && !b.endsWith("/") && !b.endsWith(".lock"), "invalid branch");

async function fence(d: OpDeps, repo: string, purpose: OnboardingPurpose): Promise<void> {
  const f = await d.api.fenceOnboarding(repo, purpose);
  if (!f.allow) throw new BrokerError(f.code === "unavailable" ? 503 : 409, f.code === "unavailable" ? "api_unavailable" : "fenced", f.reason, { fence: f.code });
}

const gitBlobSha = (content: Buffer): string => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest("hex");

/* ------------------------------------------------------------------ inspect ---- */

const SECRET_RULES: { rule: string; re: RegExp }[] = [
  { rule: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: "github-fine-grained-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { rule: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "stripe-live-key", re: /\b[sr]k_live_[0-9a-zA-Z]{24,}\b/ },
  { rule: "anthropic-api-key", re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
];
const ASSIGNED = /(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9/+=_-]{24,})["']/i;
const entropy = (s: string): number => {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const v of n.values()) h -= (v / s.length) * Math.log2(v / s.length);
  return h;
};
const SKIP_SCAN = /(^|\/)(node_modules|vendor|dist|build|\.git)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock|uv\.lock)$|\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|jar|class|woff2?|ttf|eot|mp4|mov|bin|exe|so|dylib|svg|min\.js|map)$/i;

/** Finds credential-shaped text in one file. Returns path, line and rule only. */
export function scanText(path: string, text: string, o: { longLines?: boolean } = {}): { path: string; line: number; rule: string }[] {
  const out: { path: string; line: number; rule: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < 20; i++) {
    const whole = lines[i]!;
    if (whole.length > 2000 && !o.longLines) continue;
    // `longLines` is for text that goes to a model or is stored: a one-line file must not hide a credential. Chunks overlap so a match on the seam is still whole in one.
    const parts: string[] = [];
    if (whole.length <= 2000) parts.push(whole);
    else for (let at = 0; at < whole.length; at += 1500) parts.push(whole.slice(at, at + 2000));
    for (const l of parts) {
      const hit = SECRET_RULES.find((r) => r.re.test(l));
      if (hit) { out.push({ path, line: i + 1, rule: hit.rule }); break; }
      const m = ASSIGNED.exec(l);
      if (m && entropy(m[1]!) >= 3.6 && !/example|placeholder|changeme|your[_-]/i.test(l)) { out.push({ path, line: i + 1, rule: "assigned-secret" }); break; }
    }
  }
  return out;
}

/** `scan: false` is the light read the scheduled re-check uses: the tree and key files, no secrets scan. */
export const InspectBody = z.object({ repo: repoName, scan: z.boolean().default(true) }).strict();

export interface InspectLimits { maxScanFiles: number; maxScanBytes: number; maxFileBytes: number; maxContentFiles: number }
export const DEFAULT_LIMITS: InspectLimits = { maxScanFiles: 600, maxScanBytes: 24 * 1024 * 1024, maxFileBytes: 256 * 1024, maxContentFiles: 80 };

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k]!);
    }
  }));
  return out;
}

/**
 * Reads what the assessment needs from the default branch: the file tree, the content of the files the assessment reads, a secrets scan, the language
 * and the protections report. The App must be installed on the repo, else this is a 404 `not_installed`.
 */
export async function inspectRepo(d: OpDeps, repo: string, o: { scan?: boolean; limits?: InspectLimits } = {}): Promise<Record<string, unknown>> {
  const { owner, name } = splitRepo(repo);
  const limits = o.limits ?? DEFAULT_LIMITS;
  const scan = o.scan !== false;
  try {
    await d.app.installationFor(repo);
  } catch (e) {
    const s = (e as { status?: number }).status;
    if (s === 404) throw new BrokerError(404, "not_installed", `The Gantry GitHub App is not installed on ${repo}. An organisation owner must add the repository to the App's installation.`);
    throw gh(e);
  }
  try {
    const base = await d.app.withRepo(repo, "onboard_read", async (c) => {
      const req = rq(c.octokit);
      const info = (await req("GET /repos/{owner}/{repo}", { owner, repo: name })).data;
      const defaultBranch = info.default_branch as string;
      const ref = (await req("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo: name, ref: `heads/${defaultBranch}` }).catch((e: { status?: number }) => { if (e.status === 404 || e.status === 409) return null; throw e; }))?.data;
      if (!ref) throw new BrokerError(409, "empty_repo", `${repo} has no commits on ${defaultBranch}. Push an initial commit first.`);
      const headSha = ref.object.sha as string;
      const commit = (await req("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo: name, commit_sha: headSha })).data;
      const tree = (await req("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner, repo: name, tree_sha: commit.tree.sha, recursive: "1" })).data;
      const blobs = (tree.tree as { path: string; type: string; sha: string; size?: number }[]).filter((t) => t.type === "blob");
      const languages = (await req("GET /repos/{owner}/{repo}/languages", { owner, repo: name }).catch(() => ({ data: {} }))).data as Record<string, number>;
      const primary = (info.language as string | null) ?? Object.entries(languages).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      const readBlob = async (b: { sha: string; size?: number }): Promise<string | null> => {
        if ((b.size ?? 0) > limits.maxFileBytes) return null;
        const r = (await req("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { owner, repo: name, file_sha: b.sha })).data;
        const buf = Buffer.from(r.content as string, (r.encoding as BufferEncoding) ?? "base64");
        if (buf.includes(0)) return null;
        return buf.toString("utf8");
      };
      const wanted = blobs.filter((b) => wantsContent(b.path)).slice(0, limits.maxContentFiles);
      const contents: Record<string, string> = {};
      const cache = new Map<string, string | null>();
      await pool(wanted, 6, async (b) => { const t = await readBlob(b); cache.set(b.sha, t); if (t !== null) contents[b.path] = t; });

      const scannable = scan ? blobs.filter((b) => !SKIP_SCAN.test(b.path) && (b.size ?? 0) <= limits.maxFileBytes) : [];
      const batch: typeof scannable = [];
      let bytes = 0;
      for (const b of scannable) {
        if (batch.length >= limits.maxScanFiles || bytes + (b.size ?? 0) > limits.maxScanBytes) break;
        batch.push(b); bytes += b.size ?? 0;
      }
      const hits: { path: string; line: number; rule: string }[] = [];
      await pool(batch, 6, async (b) => {
        const t = cache.has(b.sha) ? cache.get(b.sha)! : await readBlob(b);
        if (t) hits.push(...scanText(b.path, t));
      });
      hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
      return {
        repo, defaultBranch, headSha, archived: info.archived === true, language: primary, languages, files: blobs.map((b) => b.path), truncated: tree.truncated === true, contents,
        secrets: { scanned: batch.length, complete: scan && tree.truncated !== true && batch.length === scannable.length, hits: hits.slice(0, 50), skipped: !scan },
      };
    });
    const protection = await readProtections(d, repo).catch(() => null);
    return { ok: true, ...base, protection };
  } catch (e) { throw gh(e); }
}

/* ------------------------------------------------------------------ read one file ---- */

/** One read-only file read at a commit the session is already bound to. The repository comes from the session, never from the model. */
export const FileBody = z.object({ repo: repoName, sha: z.string().regex(/^[0-9a-f]{40}$/), path: z.string().min(1).max(300) }).strict();

/** Reads one blob at `sha` through the same installation token and `onboard_read` purpose the inspect uses. Binary or oversized files come back flagged, without content. */
export async function readRepoFile(d: OpDeps, b: z.infer<typeof FileBody>, limits: InspectLimits = DEFAULT_LIMITS): Promise<Record<string, unknown>> {
  const { owner, name } = splitRepo(b.repo);
  try {
    return await d.app.withRepo(b.repo, "onboard_read", async (c) => {
      const req = rq(c.octokit);
      const commit = (await req("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo: name, commit_sha: b.sha })).data;
      const tree = (await req("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner, repo: name, tree_sha: commit.tree.sha, recursive: "1" })).data;
      const hit = (tree.tree as { path: string; type: string; sha: string; size?: number }[]).find((t) => t.type === "blob" && t.path === b.path);
      if (!hit) throw new BrokerError(404, "no_such_file", `${b.path} is not a file in ${b.repo} at ${b.sha.slice(0, 7)}.`);
      if ((hit.size ?? 0) > limits.maxFileBytes) return { ok: true, path: b.path, size: hit.size ?? 0, tooLarge: true, binary: false, content: null };
      const r = (await req("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { owner, repo: name, file_sha: hit.sha })).data;
      const buf = Buffer.from(r.content as string, (r.encoding as BufferEncoding) ?? "base64");
      if (buf.includes(0)) return { ok: true, path: b.path, size: buf.length, tooLarge: false, binary: true, content: null };
      return { ok: true, path: b.path, size: buf.length, tooLarge: false, binary: false, content: buf.toString("utf8") };
    });
  } catch (e) {
    if (e instanceof BrokerError) throw e;
    throw gh(e);
  }
}

/* ------------------------------------------------------------------ the onboarding pull request ---- */

export const PrBody = z.object({
  repo: repoName,
  branch: branchName,
  baseBranch: z.string().min(1).max(250).optional(),
  title: z.string().min(1).max(250),
  body: z.string().max(60000),
  /** Files to write: the whole new content of each. Nothing outside these paths is touched. */
  files: z.array(z.object({ path: z.string().min(1).max(500).regex(/^[A-Za-z0-9._@/-]+$/).refine((p) => !p.split("/").some((s) => s === ".." || s === "." || s === "" || s === ".git"), "invalid path"), content: z.string().max(512 * 1024) })).min(1).max(40),
  commitMessage: z.string().min(1).max(500).optional(),
  /** A comment to leave on the pull request (a person's change request, recorded for the agent). */
  comment: z.string().max(10000).optional(),
}).strict();
export type PrBody = z.infer<typeof PrBody>;

export interface PrOutcome { ok: true; branch: string; number: number; url: string; headSha: string; created: boolean; changed: boolean; files: { path: string; changed: boolean }[] }

/**
 * Opens the onboarding pull request, or updates it: the files are committed on `branch` (created from the default branch's tip, or continued from its own tip), through
 * the git data API so the commit is made by the App and GitHub marks it verified. Paths that already hold the same content are skipped, so a retry adds nothing.
 * Adding a workflow file needs the App's `workflows` permission, which is requested only for such a pull request.
 */
export async function openOnboardingPr(d: OpDeps, b: PrBody): Promise<PrOutcome> {
  await fence(d, b.repo, "write");
  const { owner, name } = splitRepo(b.repo);
  const op = b.files.some((f) => f.path.startsWith(".github/workflows/")) ? "onboard_pr_workflows" : "onboard_pr";
  try {
    return await d.app.withRepo(b.repo, op, async (c) => {
      const req = rq(c.octokit);
      const defaultBranch = b.baseBranch ?? ((await req("GET /repos/{owner}/{repo}", { owner, repo: name })).data.default_branch as string);
      const tipOf = async (branch: string): Promise<string | null> => (await req("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo: name, ref: `heads/${branch}` }).catch((e: { status?: number }) => { if (e.status === 404) return null; throw e; }))?.data.object.sha ?? null;
      const baseTip = await tipOf(defaultBranch);
      if (!baseTip) throw new BrokerError(409, "empty_repo", `${b.repo} has no commits on ${defaultBranch}.`);
      const branchTip = await tipOf(b.branch);
      const parent = branchTip ?? baseTip;
      const parentCommit = (await req("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo: name, commit_sha: parent })).data;
      const tree = (await req("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner, repo: name, tree_sha: parentCommit.tree.sha, recursive: "1" })).data;
      const existing = new Map((tree.tree as { path: string; sha: string; type: string }[]).filter((t) => t.type === "blob").map((t) => [t.path, t.sha]));
      const changes = b.files.map((f) => ({ ...f, changed: existing.get(f.path) !== gitBlobSha(Buffer.from(f.content, "utf8")) }));
      let headSha = parent;
      const anyChange = changes.some((x) => x.changed);
      if (anyChange) {
        const entries: { path: string; mode: string; type: "blob"; sha: string }[] = [];
        for (const f of changes.filter((x) => x.changed)) {
          const sha = (await c.write(() => req("POST /repos/{owner}/{repo}/git/blobs", { owner, repo: name, content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" }))).data.sha as string;
          entries.push({ path: f.path, mode: "100644", type: "blob", sha });
        }
        const newTree = (await c.write(() => req("POST /repos/{owner}/{repo}/git/trees", { owner, repo: name, base_tree: parentCommit.tree.sha, tree: entries }))).data.sha as string;
        const made = (await c.write(() => req("POST /repos/{owner}/{repo}/git/commits", { owner, repo: name, message: b.commitMessage ?? b.title, tree: newTree, parents: [parent] }))).data;
        headSha = made.sha as string;
        // Stops and halts are judged again just before the branch moves.
        await fence(d, b.repo, "write");
        if (branchTip) await c.write(() => req("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo: name, ref: `heads/${b.branch}`, sha: headSha, force: false }));
        else await c.write(() => req("POST /repos/{owner}/{repo}/git/refs", { owner, repo: name, ref: `refs/heads/${b.branch}`, sha: headSha }));
      } else if (!branchTip) {
        throw new BrokerError(409, "nothing_to_add", "Every file already holds this content on the default branch; there is nothing for a pull request to add.");
      }
      const open = (await req("GET /repos/{owner}/{repo}/pulls", { owner, repo: name, head: `${owner}:${b.branch}`, state: "open" })).data as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      let pr: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      let created = false;
      if (open[0]) {
        pr = open[0];
        if (pr.title !== b.title || (pr.body ?? "") !== b.body) pr = (await c.write(() => req("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: pr.number, title: b.title, body: b.body }))).data;
      } else {
        pr = (await c.write(() => req("POST /repos/{owner}/{repo}/pulls", { owner, repo: name, title: b.title, head: b.branch, base: defaultBranch, body: b.body }))).data;
        created = true;
      }
      if (b.comment) await c.write(() => req("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo: name, issue_number: pr.number, body: b.comment }));
      return { ok: true as const, branch: b.branch, number: pr.number as number, url: String(pr.html_url ?? ""), headSha, created, changed: anyChange, files: changes.map((x) => ({ path: x.path, changed: x.changed })) };
    });
  } catch (e) {
    const err = gh(e);
    // A workflow file needs the App's `workflows` permission, granted in the App's settings and accepted on the installation. Say that, with the steps, instead of GitHub's own wording.
    if (op === "onboard_pr_workflows" && err.code === "github" && /permission|not accessible|workflow/i.test(err.message)) {
      throw new BrokerError(409, "workflow_permission", "The Gantry GitHub App is not allowed to write workflow files (.github/workflows). In GitHub: the App's settings > Permissions & events > Repository permissions > Workflows: Read and write, save, then accept the new permission on the installation (Settings > Applications > Installed GitHub Apps > Configure). Then ask for the pull request again.", { githubMessage: err.message.slice(0, 300) });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ merge ---- */

export const OnboardMergeBody = z.object({
  repo: repoName, number: z.number().int().positive(), headSha: z.string().regex(/^[0-9a-f]{40}$/),
  method: z.enum(["squash", "merge", "rebase"]).default("squash"), commitTitle: z.string().max(250).optional(),
}).strict();

/** Merges the onboarding pull request at the exact approved head (spec 11.5). GitHub's own rules decide whether it is allowed. */
export async function mergeOnboardingPr(d: OpDeps, b: z.infer<typeof OnboardMergeBody>): Promise<{ ok: true; merged: boolean; mergeSha: string | null; alreadyMerged: boolean }> {
  await fence(d, b.repo, "merge");
  return mergeCore(d, b);
}

/* ------------------------------------------------------------------ canary ---- */

export const CanaryBody = z.object({
  repo: repoName,
  /** Branch prefix for the canary (the repo's agent prefix, so the poller recognises it). */
  prefix: z.string().min(1).max(100).regex(/^[A-Za-z0-9._/-]+$/).default("gantry/"),
  /** How long to wait for CI to report a check on the canary, and how often to look. */
  waitMs: z.number().int().min(0).max(600_000).default(120_000),
  pollMs: z.number().int().min(10).max(30_000).default(5_000),
}).strict();

export interface CanaryResult {
  ok: true;
  defaultBranch: string;
  branch: string;
  /** Each step is true, false or null (could not be tried). */
  published: boolean;
  draftOpened: boolean;
  prNumber: number | null;
  closed: boolean;
  cleaned: boolean;
  checks: { name: string; status: string; conclusion: string | null; app: string | null }[];
  directPush: "rejected" | "accepted" | "unknown";
  directPushDetail: string;
  error: string | null;
}

const REJECTION = /protect|rule|required|pull request|status check|review|restrict|not allowed|forbidden|must be made through/i;

/**
 * The live part of "Verified means" (spec 11.3): publish a canary branch, open a draft pull request and close it, see whether CI reports a check on the canary,
 * then try a direct push of an empty commit to the default branch, which the repo's rules must reject. The canary is always closed and deleted afterwards.
 * If the push were accepted it changes nothing: the commit has the tip's own tree.
 */
export async function runCanary(d: OpDeps, b: z.infer<typeof CanaryBody>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<CanaryResult> {
  await fence(d, b.repo, "canary");
  const { owner, name } = splitRepo(b.repo);
  try {
    return await d.app.withRepo(b.repo, "canary", async (c) => {
      const req = rq(c.octokit);
      const defaultBranch = (await req("GET /repos/{owner}/{repo}", { owner, repo: name })).data.default_branch as string;
      const tip = (await req("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo: name, ref: `heads/${defaultBranch}` })).data.object.sha as string;
      const tipCommit = (await req("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo: name, commit_sha: tip })).data;
      const branch = `${b.prefix}canary-${Date.now().toString(36)}`;
      const out: CanaryResult = { ok: true, defaultBranch, branch, published: false, draftOpened: false, prNumber: null, closed: false, cleaned: false, checks: [], directPush: "unknown", directPushDetail: "", error: null };
      let pr: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        const blob = (await c.write(() => req("POST /repos/{owner}/{repo}/git/blobs", { owner, repo: name, content: Buffer.from(`Gantry readiness canary ${new Date().toISOString()}\n`).toString("base64"), encoding: "base64" }))).data.sha as string;
        const tree = (await c.write(() => req("POST /repos/{owner}/{repo}/git/trees", { owner, repo: name, base_tree: tipCommit.tree.sha, tree: [{ path: ".gantry/canary", mode: "100644", type: "blob", sha: blob }] }))).data.sha as string;
        const commit = (await c.write(() => req("POST /repos/{owner}/{repo}/git/commits", { owner, repo: name, message: "Gantry readiness canary (closed unmerged)", tree, parents: [tip] }))).data.sha as string;
        await c.write(() => req("POST /repos/{owner}/{repo}/git/refs", { owner, repo: name, ref: `refs/heads/${branch}`, sha: commit }));
        out.published = true;
        pr = (await c.write(() => req("POST /repos/{owner}/{repo}/pulls", { owner, repo: name, title: "Gantry readiness canary", head: branch, base: defaultBranch, body: "Opened and closed by Gantry to prove it can publish a branch and open a draft pull request. Do not merge.", draft: true }))).data;
        out.draftOpened = pr!.draft === true || pr!.number > 0;
        out.prNumber = pr!.number as number;
        // CI must report a check on the canary: wait for one (the Gantry gate check is ours and does not count).
        const deadline = Date.now() + b.waitMs;
        for (;;) {
          const runs = (await req("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo: name, ref: commit, per_page: 100 }).catch(() => ({ data: { check_runs: [] } }))).data.check_runs as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
          out.checks = runs.filter((r) => r.name !== d.cfg.gateCheckName).map((r) => ({ name: String(r.name), status: String(r.status), conclusion: (r.conclusion as string | null) ?? null, app: (r.app?.slug as string | undefined) ?? null }));
          if (out.checks.length || Date.now() >= deadline) break;
          await sleep(b.pollMs);
        }
      } catch (e) {
        out.error = e instanceof BrokerError ? e.message : String((e as Error).message ?? e).slice(0, 300);
      } finally {
        if (pr) out.closed = await c.write(() => req("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: pr!.number, state: "closed" })).then(() => true, () => false);
        if (out.published) out.cleaned = await c.write(() => req("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo: name, ref: `heads/${branch}` })).then(() => true, () => false);
      }
      // A direct push to the default branch by Gantry must be rejected by the repo's rules.
      try {
        const empty = (await c.write(() => req("POST /repos/{owner}/{repo}/git/commits", { owner, repo: name, message: "Gantry direct-push probe (no change)", tree: tipCommit.tree.sha, parents: [tip] }))).data.sha as string;
        await c.write(() => req("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo: name, ref: `heads/${defaultBranch}`, sha: empty, force: false }));
        out.directPush = "accepted";
        out.directPushDetail = `GitHub accepted a direct push to ${defaultBranch}. The App can push to the default branch.`;
      } catch (e) {
        const a = e as { status?: number; message?: string };
        const msg = String(a.message ?? "").slice(0, 300);
        if ((a.status === 403 || a.status === 422 || a.status === 409) && REJECTION.test(msg)) { out.directPush = "rejected"; out.directPushDetail = `GitHub rejected the push (${a.status}): ${msg}`; }
        else { out.directPush = "unknown"; out.directPushDetail = `The push failed for a reason that does not say the rules rejected it (${a.status ?? "no status"}): ${msg}`; }
      }
      return out;
    });
  } catch (e) { throw gh(e); }
}

/* ------------------------------------------------------------------ the repos the App can see ---- */

export interface AvailableRepo { repo: string; language: string | null; private: boolean; archived: boolean; defaultBranch: string; installationId: number }

/** The repositories every installation of the App can see (the connect wizard's list). Read with a metadata-only installation token. */
export async function listAvailable(d: OpDeps, limit = 300): Promise<AvailableRepo[]> {
  try {
    const installs = (await d.app.jwt.request("GET /app/installations", { per_page: 100 })).data as { id: number }[];
    const out: AvailableRepo[] = [];
    for (const i of installs) {
      const rows = await d.app.withInstallation(i.id, "list_repos", async (c) => {
        const acc: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (let page = 1; page <= 3 && acc.length < limit; page++) {
          const r = (await rq(c.octokit)("GET /installation/repositories", { per_page: 100, page })).data.repositories as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
          acc.push(...r);
          if (r.length < 100) break;
        }
        return acc;
      });
      for (const r of rows) out.push({ repo: String(r.full_name), language: (r.language as string | null) ?? null, private: r.private === true, archived: r.archived === true, defaultBranch: String(r.default_branch ?? "main"), installationId: i.id });
    }
    return out.slice(0, limit);
  } catch (e) { throw gh(e); }
}

/** PR state for the sync job: reuses readPrState's shape through the existing /v1/pull-state route; exported for tests. */
export { prFact };
export type { ApiClient };
