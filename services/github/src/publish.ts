/**
 * Publishing a workspace's commits (spec 4.3 step 7, 6.5, 11.4). The workspace is untrusted data:
 *  1. the API confirms the attempt is current (fencing number, stop state) before anything is written, and again just before the branch moves;
 *  2. the workspace volume is mounted read-only in a helper and only git object data is copied out into a scratch bare repository the broker made;
 *  3. new commits are read as data with plumbing (`rev-list`, `diff-tree`, `cat-file`); nothing from the workspace is ever executed;
 *  4. they are re-created on GitHub through the git data API (blobs, trees, commits, ref), so GitHub marks them verified. History must be linear;
 *  5. the pull request is opened or updated, and each commit's id, per-file stats and patch go to the Gantry API so the record does not depend on
 *     GitHub keeping unreachable commits after a squash merge.
 * A retry after a partial failure is safe: if the branch already holds the same trees, the existing commits are reused and only the record is re-sent.
 */
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pathMatches } from "@gantry/domain";
import type { ApiClient } from "./api.js";
import type { GithubConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { git, GitError } from "./git.js";
import { GithubApp, splitRepo, toApiError } from "./github.js";
import { VOLUME_NAME, type WorkspaceStore } from "./workspace.js";

export const PublishBody = z.object({
  attemptId: z.string().min(1).max(200),
  fencing: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(Number),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  volume: z.string().regex(VOLUME_NAME),
  /** `gantry/<woId>` (the repo's branch prefix plus the work order id); checked against the API's answer. */
  branch: z.string().min(1).max(250).regex(/^[A-Za-z0-9._/-]+$/).refine((b) => !b.includes("..") && !b.startsWith("/") && !b.endsWith("/") && !b.endsWith(".lock"), "invalid branch"),
  /** The commit the workspace was seeded at. Default: the single shallow boundary commit recorded by the seed. */
  base: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  /** Branch the pull request targets. Default: the repository's default branch. */
  baseBranch: z.string().min(1).max(250).optional(),
  title: z.string().min(1).max(250).optional(),
  body: z.string().max(60000).optional(),
  draft: z.boolean().optional(),
  /** Paths the agent must never modify (its guardrails). A commit that touches one is refused before anything is written to GitHub. */
  denyPaths: z.array(z.string().min(1).max(300)).max(200).optional(),
}).strict();
export type PublishBody = z.infer<typeof PublishBody>;

export interface PublishDeps {
  cfg: Pick<GithubConfig, "scratchDir" | "gitBin" | "maxWorkspaceBytes" | "maxPatchBytes" | "maxCommitsPerPublish">;
  app: GithubApp;
  api: ApiClient;
  store: WorkspaceStore;
}

interface FileChange { path: string; status: "A" | "M" | "D"; oldMode: string; newMode: string; newSha: string }
interface LocalCommit { sha: string; parent: string; tree: string; message: string; author: string | null; committedAt: string | null; changes: FileChange[]; files: { path: string; status: string; additions: number; deletions: number }[]; patch: string; patchTruncated: boolean }

export interface PublishResult {
  ok: true;
  branch: string;
  headSha: string | null;
  noop: boolean;
  alreadyPublished: boolean;
  commits: { localSha: string; sha: string }[];
  pullRequest: { number: number; url: string; created: boolean } | null;
}

const STATUS_WORD = { A: "added", M: "modified", D: "removed" } as const;

function parseRaw(buf: Buffer): FileChange[] {
  // `:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0` repeated.
  const parts = buf.toString("utf8").split("\0");
  const out: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i]!);
    if (!m) continue;
    const st = m[5] === "A" ? "A" : m[5] === "D" ? "D" : "M";
    out.push({ path: parts[i + 1]!, status: st, oldMode: m[1]!, newMode: m[2]!, newSha: m[4]! });
  }
  return out;
}

function parseNumstat(buf: Buffer): Map<string, { additions: number; deletions: number }> {
  const out = new Map<string, { additions: number; deletions: number }>();
  for (const rec of buf.toString("utf8").split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rec);
    if (m) out.set(m[3]!, { additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return out;
}

/** Packs the objects of `base..head` and indexes them in an empty repository with fsck on, so a malformed object is refused instead of read. */
async function fsckNewObjects(d: PublishDeps, scratch: string, G: (args: string[], o?: { input?: Buffer | string; maxOutput?: number }) => Promise<Buffer>, base: string, head: string): Promise<void> {
  try {
    const list = await G(["rev-list", "--objects", "--no-object-names", `${base}..${head}`], { maxOutput: 64 * 1024 * 1024 });
    const pack = await G(["pack-objects", "--stdout", "-q"], { input: list, maxOutput: d.cfg.maxWorkspaceBytes });
    const chk = join(scratch, "fsck.git");
    await git(["init", "--bare", "--quiet", "--template=", chk], { gitBin: d.cfg.gitBin });
    await git([`--git-dir=${chk}`, "index-pack", "--stdin", "--fsck-objects"], { gitBin: d.cfg.gitBin, input: pack });
  } catch (e) {
    if (e instanceof GitError) throw new BrokerError(422, "fsck_failed", `The workspace holds malformed git objects (${(e.stderr || e.message).split("\n")[0]!.slice(0, 200)}); nothing was published.`);
    throw e;
  }
}

const withTrailer = (message: string, woId: string): string => (/^Gantry-Work-Order:/m.test(message) ? message : `${message.replace(/\s+$/, "")}\n\nGantry-Work-Order: ${woId}\n`);

export async function publishWorkspace(d: PublishDeps, b: PublishBody): Promise<PublishResult> {
  const { owner, name } = splitRepo(b.repo);
  // 1. Fence: the attempt must be current, the scope not stopped, the repo and branch the work order's own.
  const fence = await d.api.fenceAttempt(b.attemptId, b.fencing, b.repo);
  if (!fence.allow) throw new BrokerError(fence.code === "unavailable" ? 503 : 409, fence.code === "unavailable" ? "api_unavailable" : "fenced", fence.reason, { fence: fence.code });
  if (fence.branch !== b.branch) throw new BrokerError(422, "bad_branch", `The branch for ${fence.woId} is ${fence.branch}, not ${b.branch}.`);
  const woId = fence.woId;

  const scratch = await mkdtemp(join(d.cfg.scratchDir, "gantry-publish-"));
  try {
    // 2. Copy git object data out of the read-only workspace.
    const gd = join(scratch, "gd.git");
    await git(["init", "--bare", "--quiet", "--template=", gd], { gitBin: d.cfg.gitBin });
    await mkdir(join(gd, "objects"), { recursive: true });
    await d.store.copyGitData(b.volume, gd, { maxBytes: d.cfg.maxWorkspaceBytes });
    const G = (args: string[], o: { input?: Buffer | string; maxOutput?: number } = {}) => git([`--git-dir=${gd}`, ...args], { gitBin: d.cfg.gitBin, ...o });
    const GT = async (args: string[]) => (await G(args)).toString("utf8").trim();

    // 3. Read the new commits as data.
    let head: string;
    try { head = await GT(["rev-parse", "--verify", "HEAD^{commit}"]); } catch { throw new BrokerError(422, "no_head", "The workspace has no commit at HEAD."); }
    let base = b.base;
    if (!base) {
      const shallow = await readFile(join(gd, "shallow"), "utf8").catch(() => "");
      const shas = shallow.split("\n").map((s) => s.trim()).filter(Boolean);
      if (shas.length !== 1 || !/^[0-9a-f]{40}$/.test(shas[0]!)) throw new BrokerError(422, "no_base", "The base commit is not recorded in the workspace; pass `base`.");
      base = shas[0]!;
    }
    try { await G(["cat-file", "-e", `${base}^{commit}`]); } catch { throw new BrokerError(422, "bad_base", `The base commit ${base.slice(0, 7)} is not in the workspace.`); }
    if (head === base) return { ok: true, branch: b.branch, headSha: null, noop: true, alreadyPublished: false, commits: [], pullRequest: null };
    try { await G(["merge-base", "--is-ancestor", base, head]); } catch { throw new BrokerError(422, "not_descended", "The workspace HEAD does not descend from the base commit."); }

    // The workspace is untrusted: check the new objects (malformed commits, trees with odd entries, bad dates) before anything reads them.
    await fsckNewObjects(d, scratch, G, base, head);

    const lines = (await GT(["rev-list", "--reverse", "--topo-order", "--parents", `${base}..${head}`])).split("\n").filter(Boolean);
    if (lines.length > d.cfg.maxCommitsPerPublish) throw new BrokerError(422, "too_many_commits", `${lines.length} new commits; the limit is ${d.cfg.maxCommitsPerPublish}.`);
    const commits: LocalCommit[] = [];
    let prev = base;
    for (const line of lines) {
      const [sha, ...parents] = line.split(" ") as [string, ...string[]];
      if (parents.length !== 1 || parents[0] !== prev) throw new BrokerError(422, "non_linear", `Commit ${sha.slice(0, 7)} is a merge or does not follow the previous commit; publish needs linear history.`);
      const raw = (await G(["cat-file", "commit", sha])).toString("utf8");
      const sep = raw.indexOf("\n\n");
      const hdr = raw.slice(0, sep < 0 ? raw.length : sep);
      const message = sep < 0 ? "" : raw.slice(sep + 2);
      const author = /^author (.*?) <[^>]*> (\d+)/m.exec(hdr);
      const diffArgs = ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--no-ext-diff", "--no-textconv"];
      const changes = parseRaw(await G([...diffArgs, "--raw", prev, sha]));
      const stats = parseNumstat(await G([...diffArgs, "--numstat", prev, sha]));
      let patch = "", patchTruncated = false;
      try { patch = (await G(["diff-tree", "-p", "-r", "--no-renames", "--no-commit-id", "--no-ext-diff", "--no-textconv", "--no-color", prev, sha], { maxOutput: d.cfg.maxPatchBytes })).toString("utf8"); }
      catch (e) { if (e instanceof GitError && /exceeded/.test(e.message)) { patchTruncated = true; patch = `[patch omitted: larger than ${d.cfg.maxPatchBytes} bytes]\n`; } else throw e; }
      commits.push({
        sha, parent: prev, tree: await GT(["rev-parse", `${sha}^{tree}`]), message, author: author ? author[1]! : null, committedAt: author ? new Date(Number(author[2]) * 1000).toISOString() : null,
        changes, files: changes.map((c) => ({ path: c.path, status: STATUS_WORD[c.status], ...(stats.get(c.path) ?? { additions: 0, deletions: 0 }) })), patch, patchTruncated,
      });
      prev = sha;
    }

    // Guardrails in code, not prose: a change to a path the agent was forbidden to touch is never published, whatever the agent was told or talked into.
    if (b.denyPaths?.length) {
      for (const lc of commits) {
        const bad = lc.changes.find((ch) => b.denyPaths!.some((pat) => pathMatches(ch.path, pat)));
        if (bad) throw new BrokerError(422, "guardrail_breach", `${bad.path} is on the agent's forbidden paths (commit ${lc.sha.slice(0, 7)}); nothing was published.`, { path: bad.path });
      }
    }

    // Symlinks and submodules are not published: a symlink could point anywhere once checked out, and a submodule pins code the broker never reviewed.
    for (const lc of commits) {
      const bad = lc.changes.find((ch) => ch.status !== "D" && (ch.newMode === "120000" || ch.newMode === "160000"));
      if (bad) throw new BrokerError(422, "unsupported_entry", `${bad.path} is a ${bad.newMode === "120000" ? "symbolic link" : "submodule"} (commit ${lc.sha.slice(0, 7)}); symlinks and submodules are not published.`, { path: bad.path });
    }

    // 4 and 5. Publish through the API of GitHub with an installation token scoped to this one repository.
    return await d.app.withRepo(b.repo, "publish", async (c) => {
      const gh = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { throw gh_err(e); } };
      const req = c.octokit.request.bind(c.octokit) as (route: string, p?: Record<string, unknown>) => Promise<{ data: Record<string, any>; status: number }>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const tipRef = await gh(async () => { try { return (await req("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo: name, ref: `heads/${b.branch}` })).data; } catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; } });
      const tip: string | null = tipRef ? (tipRef.object.sha as string) : null;

      let created: { localSha: string; sha: string; tree: string }[] = [];
      let already = false;
      if (tip && tip !== base) {
        // The branch moved. It is fine only when it already holds exactly these trees (a retry of a publish that stopped after the ref moved).
        created = await gh(() => remoteChainMatches(req, owner, name, tip, commits));
        if (!created.length) throw new BrokerError(409, "branch_moved", `Branch ${b.branch} is at ${tip.slice(0, 7)}, not at the base ${base!.slice(0, 7)}; seed the workspace from the branch tip.`);
        already = true;
      }
      if (!already) {
        const blobs = new Map<string, string>();
        const baseCommit = (await gh(() => req("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo: name, commit_sha: base! }))).data;
        let parent = base!;
        let parentTree = baseCommit.tree.sha as string;
        for (const lc of commits) {
          const entries: { path: string; mode: string; type: "blob" | "commit"; sha: string | null }[] = [];
          for (const ch of lc.changes) {
            if (ch.status === "D") { entries.push({ path: ch.path, mode: "100644", type: "blob", sha: null }); continue; }
            let id = blobs.get(ch.newSha);
            if (!id) {
              const content = await G(["cat-file", "blob", ch.newSha], { maxOutput: 50 * 1024 * 1024 }).catch(() => { throw new BrokerError(422, "blob_too_large", `${ch.path} is larger than 50 MB or unreadable.`); });
              id = (await gh(() => c.write(() => req("POST /repos/{owner}/{repo}/git/blobs", { owner, repo: name, content: content.toString("base64"), encoding: "base64" })))).data.sha as string;
              blobs.set(ch.newSha, id);
            }
            entries.push({ path: ch.path, mode: ch.newMode, type: "blob", sha: id });
          }
          const tree = (await gh(() => c.write(() => req("POST /repos/{owner}/{repo}/git/trees", { owner, repo: name, base_tree: parentTree, tree: entries })))).data.sha as string;
          const made = (await gh(() => c.write(() => req("POST /repos/{owner}/{repo}/git/commits", { owner, repo: name, message: withTrailer(lc.message, woId), tree, parents: [parent] })))).data;
          created.push({ localSha: lc.sha, sha: made.sha as string, tree });
          parent = made.sha as string; parentTree = tree;
        }
        // The attempt may have been superseded or stopped while the objects were being created: check again before the branch moves.
        const again = await d.api.fenceAttempt(b.attemptId, b.fencing, b.repo);
        if (!again.allow) throw new BrokerError(again.code === "unavailable" ? 503 : 409, again.code === "unavailable" ? "api_unavailable" : "fenced", again.reason, { fence: again.code });
        const newTip = created.at(-1)!.sha;
        if (tip) await gh(() => c.write(() => req("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo: name, ref: `heads/${b.branch}`, sha: newTip, force: false })));
        else await gh(() => c.write(() => req("POST /repos/{owner}/{repo}/git/refs", { owner, repo: name, ref: `refs/heads/${b.branch}`, sha: newTip })));
      }
      const headSha = created.at(-1)!.sha;

      // Pull request: open or update.
      const baseBranch = b.baseBranch ?? ((await gh(() => req("GET /repos/{owner}/{repo}", { owner, repo: name }))).data.default_branch as string);
      const open = (await gh(() => req("GET /repos/{owner}/{repo}/pulls", { owner, repo: name, head: `${owner}:${b.branch}`, state: "open" }))).data as unknown as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      const title = b.title ?? `${woId}: ${commits[0]!.message.split("\n")[0]!.slice(0, 200)}`;
      let pr: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      let createdPr = false;
      if (open[0]) {
        pr = open[0];
        if ((b.title && b.title !== pr.title) || (b.body !== undefined && b.body !== pr.body)) {
          pr = (await gh(() => c.write(() => req("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo: name, pull_number: pr.number, ...(b.title ? { title: b.title } : {}), ...(b.body !== undefined ? { body: b.body } : {}) })))).data;
        }
      } else {
        pr = (await gh(() => c.write(() => req("POST /repos/{owner}/{repo}/pulls", { owner, repo: name, title, head: b.branch, base: baseBranch, body: b.body ?? `Gantry work order ${woId}.`, draft: b.draft ?? false })))).data;
        createdPr = true;
      }

      // The record: ids, per-file stats and patches go to Gantry.
      const idOf = new Map(created.map((x) => [x.localSha, x.sha]));
      const facts = {
        source: "publish", repo: b.repo,
        pullRequests: [prFact(pr)],
        publish: {
          attemptId: b.attemptId, woId, branch: b.branch, prNumber: pr.number as number,
          commits: commits.map((lc) => ({ sha: idOf.get(lc.sha)!, localSha: lc.sha, parents: [lc.parent === base ? base! : idOf.get(lc.parent)!], message: withTrailer(lc.message, woId), author: lc.author, committedAt: lc.committedAt, files: lc.files, patch: lc.patch, patchTruncated: lc.patchTruncated })),
        },
      };
      const stored = await d.api.postFacts(facts);
      if (stored.kind !== "ok") throw new BrokerError(502, "record_not_stored", `Published to GitHub but the Gantry record was not stored (${stored.kind === "unavailable" ? stored.msg : `API ${stored.status}`}); retry the publish, it is idempotent.`, { branch: b.branch, headSha });
      return { ok: true as const, branch: b.branch, headSha, noop: false, alreadyPublished: already, commits: created.map((x) => ({ localSha: x.localSha, sha: x.sha })), pullRequest: { number: pr.number as number, url: String(pr.html_url ?? ""), created: createdPr } };
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

const gh_err = (e: unknown): Error => (e instanceof BrokerError ? e : (() => { const a = toApiError(e); return new BrokerError(a.status === 403 || a.status === 429 ? 429 : a.status === 404 ? 404 : a.status === 422 || a.status === 409 ? 409 : 502, "github", a.message); })());

/** Walks `commits.length` GitHub commits back from `tip` and returns the pairs when each one's tree equals the local commit's tree; otherwise an empty list. */
async function remoteChainMatches(req: (route: string, p?: Record<string, unknown>) => Promise<{ data: Record<string, any> }>, owner: string, repo: string, tip: string, local: LocalCommit[]): Promise<{ localSha: string; sha: string; tree: string }[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: { localSha: string; sha: string; tree: string }[] = [];
  let sha = tip;
  for (let i = local.length - 1; i >= 0; i--) {
    const c = (await req("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: sha })).data;
    if (c.tree.sha !== local[i]!.tree) return [];
    out.unshift({ localSha: local[i]!.sha, sha, tree: c.tree.sha as string });
    sha = c.parents?.[0]?.sha as string;
    if (i > 0 && !sha) return [];
  }
  return out;
}

export function prFact(pr: Record<string, any>): Record<string, unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    number: pr.number, githubId: pr.id ?? null, title: String(pr.title ?? ""), state: pr.merged_at || pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open", draft: pr.draft === true,
    headSha: pr.head?.sha ?? null, baseBranch: pr.base?.ref ?? null, headBranch: pr.head?.ref ?? null, url: pr.html_url ?? null, mergedAt: pr.merged_at ?? null,
    mergeCommitSha: pr.merged_at ? pr.merge_commit_sha ?? null : null, labels: Array.isArray(pr.labels) ? pr.labels.map((l: { name?: string }) => l.name).filter(Boolean) : [], author: pr.user?.login ?? null,
  };
}
