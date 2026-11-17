/**
 * Seeding a workspace (spec 4.3 step 2): shallow-fetch the repository at the recorded commit into broker scratch space, with hooks off and no config
 * taken from the repository, then stream the tree (with its `.git`) into the run's `ws-<id>` volume owned by the runner's uid/gid.
 * The installation token reaches `git` only through the environment of that one child process (an HTTP header); it is never written to disk or to argv.
 */
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { buildRepoContext, CONVENTION_FILES, type RawConventionFile, type RepoContext } from "@gantry/domain";
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

export async function seedWorkspace(d: SeedDeps, b: SeedBody): Promise<{ ok: true; repo: string; commit: string; volume: string; repoContext: RepoContext }> {
  splitRepo(b.repo);
  const scratch = await mkdtemp(join(d.cfg.scratchDir, "gantry-seed-"));
  const work = join(scratch, "work");
  try {
    const url = (d.cloneUrl ?? ((full) => `${cloneBase(d.apiBase)}/${full}.git`))(b.repo);
    const run = (args: string[], env?: Record<string, string>) => git(args, { gitBin: d.cfg.gitBin, cwd: work, ...(env ? { env } : {}), config: d.gitConfig ?? [] });
    await git(["init", "--quiet", "--template=", work], { gitBin: d.cfg.gitBin, cwd: scratch });
    await run(["remote", "add", "origin", url]);
    await d.app.withRepo(b.repo, "seed", async (c) => {
      const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${c.token}`).toString("base64")}`;
      try {
        await run(["fetch", "--quiet", "--depth", "1", "--no-tags", "--no-recurse-submodules", "origin", b.commit], { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: auth });
      } catch (e) {
        if (e instanceof GitError) throw new BrokerError(502, "fetch_failed", `Could not fetch ${b.commit.slice(0, 7)} from ${b.repo}: ${e.stderr.trim().split("\n").pop() ?? e.message}`);
        throw e;
      }
    }).catch((e: unknown) => { throw e instanceof BrokerError ? e : e instanceof GitError ? e : (() => { const a = toApiError(e); return new BrokerError(a.status === 404 ? 404 : 502, "github", a.message); })(); });
    await run(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const head = (await gitText(["rev-parse", "HEAD"], { gitBin: d.cfg.gitBin, cwd: work })).trim();
    if (head !== b.commit) throw new BrokerError(502, "fetch_failed", `Fetched ${head}, expected ${b.commit}.`);
    const repoContext = await readRepoContext(work, head);
    await d.store.seed(b.volume, work, { uid: RUNNER_UID, gid: RUNNER_UID });
    return { ok: true, repo: b.repo, commit: head, volume: b.volume, repoContext };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
