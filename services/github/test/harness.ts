import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../src/api.js";
import type { GithubConfig } from "../src/config.js";
import { GithubApp } from "../src/github.js";
import { WriteLimiter } from "../src/ratelimit.js";
import { buildServer } from "../src/server.js";
import { extractTar, tarDirectory } from "../src/tar.js";
import type { WorkspaceStore } from "../src/workspace.js";
import { FakeApi } from "./fake-api.js";
import { FakeGithub } from "./fake-github.js";

export const REPO = "acme/payments-api";
export const gitSync = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Runner", "-c", "user.email=runner@example.com", "-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

/** A workspace store backed by plain directories, going through the broker's own tar writer and reader exactly as the Docker one does. */
export class DirStore implements WorkspaceStore {
  constructor(readonly root: string) {}
  dir(volume: string): string { return join(this.root, volume); }
  async seed(volume: string, srcDir: string, o: { uid: number; gid: number }): Promise<void> {
    await mkdir(this.dir(volume), { recursive: true });
    await extractTar(tarDirectory(srcDir, o), this.dir(volume), { maxBytes: 1 << 30 });
  }
  async copyGitData(volume: string, dest: string, o: { maxBytes: number }): Promise<{ files: number; bytes: number }> {
    let files = 0, bytes = 0;
    for (const part of ["objects", "refs", "HEAD", "packed-refs", "shallow"]) {
      const src = join(this.dir(volume), ".git");
      const tmp = await mkdtemp(join(tmpdir(), "gh-part-"));
      try {
        await cp(join(src, part), join(tmp, part), { recursive: true }).catch(() => undefined);
        const r = await extractTar(tarDirectory(tmp, { uid: 0, gid: 0 }), dest, { maxBytes: o.maxBytes - bytes, map: (name) => ((name === part || name.startsWith(`${part}/`)) && !name.startsWith("objects/info") ? name : null) });
        files += r.files; bytes += r.bytes;
      } finally { await rm(tmp, { recursive: true, force: true }); }
    }
    return { files, bytes };
  }
}

export interface Env {
  gh: FakeGithub;
  api: FakeApi;
  store: DirStore;
  root: string;
  cfg: GithubConfig;
  app: GithubApp;
  server: Awaited<ReturnType<typeof buildServer>>["server"];
  poller: Awaited<ReturnType<typeof buildServer>>["poller"];
  remote: string;
  auth: Record<string, string>;
  close(): Promise<void>;
  call(method: "GET" | "POST", url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
}

export async function startEnv(o: { writesPerMinute?: number; burst?: number } = {}): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "gh-test-"));
  const gh = new FakeGithub(); await gh.start();
  const api = new FakeApi(); await api.start();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const scratch = join(root, "scratch"); await mkdir(scratch);
  const cfg: GithubConfig = {
    port: 0, host: "127.0.0.1", apiUrl: api.url, githubToken: api.token, app: { appId: 4242, privateKey, baseUrl: gh.url },
    writesPerMinute: o.writesPerMinute ?? 100000, writeBurst: o.burst ?? 100000, pollIntervalMs: 0, helperImage: "unused", dockerSocket: "/unused", scratchDir: scratch,
    gateCheckName: "Gantry gates", maxWorkspaceBytes: 1 << 30, maxPatchBytes: 64 * 1024, maxCommitsPerPublish: 50, issueLabel: "gantry", gitBin: "git",
  };
  const app = new GithubApp(cfg.app!, new WriteLimiter(cfg.writesPerMinute, cfg.writeBurst));
  const store = new DirStore(join(root, "volumes"));
  // The "remote" the seed clones from: a local repository served over file:// (hooks and config of the source are irrelevant to the broker).
  const remote = join(root, "remote.git");
  const { server, poller } = await buildServer({ cfg, app, api: new ApiClient(cfg), store, logger: false, cloneUrl: () => `file://${remote}`, gitConfig: ["protocol.file.allow=always"] });
  const auth = { authorization: `Bearer ${api.token}` };
  return {
    gh, api, store, root, cfg, app, server, poller, remote, auth,
    async call(method, url, payload, headers = auth) {
      const r = await server.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
    },
    async close() { await server.close(); await gh.stop(); await api.stop(); await rm(root, { recursive: true, force: true }); },
  };
}

/** Builds a source repository with `files`, returns its HEAD and registers the same commit in the fake GitHub so the broker can build on it. */
export async function makeRemote(env: Env, files: Record<string, string>): Promise<string> {
  const work = join(env.root, "src-work");
  await mkdir(work, { recursive: true });
  gitSync(work, "init", "-q", "-b", "main");
  for (const [p, c] of Object.entries(files)) { await mkdir(join(work, p, ".."), { recursive: true }); await writeFile(join(work, p), c); }
  gitSync(work, "add", "-A"); gitSync(work, "commit", "-q", "-m", "seed");
  const head = gitSync(work, "rev-parse", "HEAD");
  gitSync(work, "clone", "-q", "--bare", work, env.remote);
  gitSync(env.remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  const tree = env.gh.registerCommit(head, files);
  if (tree !== gitSync(work, "rev-parse", "HEAD^{tree}")) throw new Error("the fake's tree hashing differs from git's");
  env.gh.setRef("refs/heads/main", head);
  return head;
}
