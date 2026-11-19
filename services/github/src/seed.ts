/**
 * Seeding a workspace (spec 4.3 step 2): shallow-fetch the repository at the recorded commit into broker scratch space, with hooks off and no config
 * taken from the repository, then stream the tree (with its `.git`) into the run's `ws-<id>` volume owned by the runner's uid/gid.
 * The installation token reaches `git` only through the environment of that one child process (an HTTP header); it is never written to disk or to argv.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { buildRepoContext, CONVENTION_FILES, isConventionPath, type RawConventionFile, type RepoContext } from "@gantry/domain";
import type { GithubConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { git, gitText, GitError } from "./git.js";
import { GithubApp, splitRepo, toApiError } from "./github.js";
import { scanText } from "./onboarding.js";
import { VOLUME_NAME, type WorkspaceStore } from "./workspace.js";

export const SeedBody = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  volume: z.string().regex(VOLUME_NAME),
  /**
   * The branch the work order's pull request targets. When given, the checkout also holds that branch's head (`refs/gantry/base`) and enough history for the
   * merge base, so `git diff <base>...<head>` works offline in the runner. The runner has no network git and no token: this is the only place the base arrives.
   */
  baseBranch: z.string().min(1).max(250).regex(/^[A-Za-z0-9._/-]+$/).refine((b) => !b.includes("..") && !b.startsWith("/") && !b.endsWith("/") && !b.endsWith(".lock"), "invalid branch").optional(),
}).strict();
export type SeedBody = z.infer<typeof SeedBody>;

/** `https://api.github.com` -> `https://github.com`; `https://ghe.example.com/api/v3` -> `https://ghe.example.com`. */
export function cloneBase(apiBase: string): string {
  const u = new URL(apiBase);
  if (u.hostname === "api.github.com") return "https://github.com";
  return `${u.origin}${u.pathname.replace(/\/api\/v3\/?$/, "").replace(/\/+$/, "")}`;
}

export interface SeedDeps {
  cfg: Pick<GithubConfig, "scratchDir" | "gitBin">;
  app: GithubApp;
  store: WorkspaceStore;
  /** Where repositories are cloned from. Defaults to the GitHub host that matches the App's API base URL. */
  cloneUrl?: (full: string) => string;
  /** Extra git `-c` settings (tests allow `file://`). */
  gitConfig?: string[];
  apiBase: string;
}

export const RUNNER_UID = 10001;

/**
 * The repository's convention files at the seeded commit (AGENTS.md and the like), as a manifest the agent's prompt is built from. Only regular files
 * inside the checkout are read (a symlink is never followed), nothing is executed, and the secret scan and size caps are applied before anything leaves the broker.
 */
export async function readRepoContext(work: string, commit: string): Promise<RepoContext> {
  const found: RawConventionFile[] = [];
  for (const f of CONVENTION_FILES) {
    const full = join(work, f.path);
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      found.push({ path: f.path, content: await readFile(full) });
    } catch { /* absent */ }
  }
  return buildRepoContext(commit, found, { scan: (path, text) => scanText(path, text, { longLines: true }), sha256: (b) => createHash("sha256").update(b).digest("hex") });
}

/**
 * The convention files as they are at a commit in the checkout's object store (`rev`), not in the working tree: the maintainers' version at the target branch head
 * (S-141). Only regular blobs are read (a symlink or submodule entry is skipped), through the same caps and secret scan as the working tree read.
 */
export async function readRepoContextAt(work: string, rev: string, commit: string, gitBin: string): Promise<RepoContext> {
  const found: RawConventionFile[] = [];
  for (const f of CONVENTION_FILES) {
    try {
      const entry = (await gitText(["ls-tree", "-z", rev, "--", f.path], { gitBin, cwd: work })).split("\0")[0] ?? "";
      const m = /^(100644|100755) blob ([0-9a-f]{40})\t/.exec(entry);
      if (!m) continue;
      const size = Number((await gitText(["cat-file", "-s", m[2]!], { gitBin, cwd: work })).trim());
      if (!Number.isFinite(size) || size > 4 * 1024 * 1024) continue;
      found.push({ path: f.path, content: await git(["cat-file", "blob", m[2]!], { gitBin, cwd: work }) });
    } catch { /* absent at that commit */ }
  }
  return buildRepoContext(commit, found, { scan: (path, text) => scanText(path, text, { longLines: true }), sha256: (b) => createHash("sha256").update(b).digest("hex") });
}

/** The convention files (and anything under .claude/, CODEOWNERS, the pull request template) the work branch changed against the target branch: `git diff --name-status base...head`. */
export async function conventionChangesBetween(work: string, base: string, head: string, gitBin: string): Promise<Array<{ path: string; status: "added" | "changed" | "removed" }>> {
  const out = await gitText(["diff", "--name-status", "--no-renames", "-z", `${base}...${head}`], { gitBin, cwd: work });
  const parts = out.split("\0").filter((x) => x !== "");
  const res: Array<{ path: string; status: "added" | "changed" | "removed" }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]!;
    const path = parts[i + 1]!;
    if (!isConventionPath(path)) continue;
    res.push({ path, status: code.startsWith("A") ? "added" : code.startsWith("D") ? "removed" : "changed" });
  }
  return res.slice(0, 200);
}

/** How much history a seed with a base carries: a pull request's own commits plus the point it left the target branch. Deepened once when the merge base is further back. */
const BASE_DEPTH = 100;
const DEEPEN_BY = 1000;

export async function seedWorkspace(d: SeedDeps, b: SeedBody): Promise<{ ok: true; repo: string; commit: string; volume: string; repoContext: RepoContext; baseRepoContext: RepoContext | null; conventionChanges: Array<{ path: string; status: "added" | "changed" | "removed" }> | null; base: string | null; baseBranch: string | null }> {
  splitRepo(b.repo);
  const scratch = await mkdtemp(join(d.cfg.scratchDir, "gantry-seed-"));
  const work = join(scratch, "work");
  try {
    const url = (d.cloneUrl ?? ((full) => `${cloneBase(d.apiBase)}/${full}.git`))(b.repo);
    const run = (args: string[], env?: Record<string, string>) => git(args, { gitBin: d.cfg.gitBin, cwd: work, ...(env ? { env } : {}), config: d.gitConfig ?? [] });
    await git(["init", "--quiet", "--template=", work], { gitBin: d.cfg.gitBin, cwd: scratch });
    await run(["remote", "add", "origin", url]);
    // The runner keeps its package caches in /workspace/.gantry-cache (runner/wrapper cacheEnv). Excluding it here keeps `git add -A` from ever staging it.
    await mkdir(join(work, ".git", "info"), { recursive: true });
    await writeFile(join(work, ".git", "info", "exclude"), "/.gantry-cache/\n");
    await d.app.withRepo(b.repo, "seed", async (c) => {
      const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${c.token}`).toString("base64")}`;
      const authEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: auth };
      try {
        await run(["fetch", "--quiet", "--depth", String(b.baseBranch ? BASE_DEPTH : 1), "--no-tags", "--no-recurse-submodules", "origin", b.commit], authEnv);
      } catch (e) {
        if (e instanceof GitError) throw new BrokerError(502, "fetch_failed", `Could not fetch ${b.commit.slice(0, 7)} from ${b.repo}: ${e.stderr.trim().split("\n").pop() ?? e.message}`);
        throw e;
      }
    }).catch((e: unknown) => { throw e instanceof BrokerError ? e : e instanceof GitError ? e : (() => { const a = toApiError(e); return new BrokerError(a.status === 404 ? 404 : 502, "github", a.message); })(); });
    await run(["checkout", "--quiet", "--detach", b.commit]);
    // The base is best effort: a target branch that is gone or unreadable leaves the checkout as it was (no base), and the agents are told there is none.
    let base: string | null = null;
    if (b.baseBranch) {
      const branch = b.baseBranch;
      await d.app.withRepo(b.repo, "seed", async (c) => {
        const authEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${c.token}`).toString("base64")}` };
        const fetchBase = (extra: string[]) => run(["fetch", "--quiet", ...extra, "--no-tags", "--no-recurse-submodules", "origin", `+refs/heads/${branch}:refs/gantry/base`], authEnv);
        await fetchBase(["--depth", String(BASE_DEPTH)]);
        const joined = () => run(["merge-base", "refs/gantry/base", b.commit]).then(() => true, () => false);
        if (!(await joined())) {
          await run(["fetch", "--quiet", "--deepen", String(DEEPEN_BY), "--no-tags", "--no-recurse-submodules", "origin", b.commit], authEnv).catch(() => undefined);
          await fetchBase(["--deepen", String(DEEPEN_BY)]).catch(() => undefined);
        }
        if (await joined()) base = (await gitText(["rev-parse", "refs/gantry/base"], { gitBin: d.cfg.gitBin, cwd: work })).trim();
      }).catch(() => undefined);
      if (!base) await run(["update-ref", "-d", "refs/gantry/base"]).catch(() => undefined);
    }
    const head = (await gitText(["rev-parse", "HEAD"], { gitBin: d.cfg.gitBin, cwd: work })).trim();
    if (head !== b.commit) throw new BrokerError(502, "fetch_failed", `Fetched ${head}, expected ${b.commit}.`);
    const repoContext = await readRepoContext(work, head);
    // The maintainers' version of the conventions is the target branch head's, not the work branch's (S-141): read at the base commit, and what the branch changed is listed apart.
    let baseRepoContext: RepoContext | null = null;
    let conventionChanges: Array<{ path: string; status: "added" | "changed" | "removed" }> | null = null;
    if (base) {
      baseRepoContext = base === head ? repoContext : await readRepoContextAt(work, base, base, d.cfg.gitBin).catch(() => null);
      conventionChanges = base === head ? [] : await conventionChangesBetween(work, base, head, d.cfg.gitBin).catch(() => null);
    }
    await d.store.seed(b.volume, work, { uid: RUNNER_UID, gid: RUNNER_UID });
    return { ok: true, repo: b.repo, commit: head, volume: b.volume, repoContext, baseRepoContext, conventionChanges, base, baseBranch: base ? (b.baseBranch ?? null) : null };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
