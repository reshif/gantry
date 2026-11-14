import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export class SecretError extends Error {}

export async function readSecretFile(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = env.GANTRY_SECRETS_DIR && env.GANTRY_SECRETS_DIR.length > 0 ? env.GANTRY_SECRETS_DIR : "/run/secrets";
  let raw: string;
  try {
    raw = await readFile(join(dir, name), "utf8");
  } catch (e) {
    throw new SecretError(`secret ${name} is ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"}`);
  }
  const v = raw.replace(/\r?\n$/, "");
  if (!v) throw new SecretError(`secret ${name} is empty`);
  return v;
}

/** /run/secrets/github_app.json. `baseUrl` is GitHub's cloud API or a GitHub Enterprise Server's (`https://ghe.example.com/api/v3`). */
export const AppSettings = z.object({
  appId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform((v) => Number(v)),
  baseUrl: z.string().url().default("https://api.github.com"),
  installationId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform((v) => Number(v)).optional(),
});
export type AppSettings = z.infer<typeof AppSettings>;

export interface GithubConfig {
  port: number;
  host: string;
  apiUrl: string;
  /** Service token the worker and API present to this broker, and this broker presents to the API. */
  githubToken: string;
  app: { appId: number; privateKey: string; baseUrl: string; installationId?: number };
  /** Writes per installation per minute (spec 11.6: below GitHub's content-creation limits). */
  writesPerMinute: number;
  writeBurst: number;
  pollIntervalMs: number;
  /** Poll only when the API has repos; 0 disables the loop (tests, or when webhooks arrive). */
  helperImage: string;
  dockerSocket: string;
  /** Scratch space for clones and object copies. */
  scratchDir: string;
  /** Name of the Gantry gate check (spec 11.2). */
  gateCheckName: string;
  maxWorkspaceBytes: number;
  maxPatchBytes: number;
  maxCommitsPerPublish: number;
  issueLabel: string;
  gitBin: string;
}

const Env = z.object({
  GITHUB_PORT: z.coerce.number().int().default(9200),
  GANTRY_API_URL: z.string().url().default("http://gantry-api:8000"),
  GITHUB_WRITES_PER_MINUTE: z.coerce.number().int().positive().default(40),
  GITHUB_WRITE_BURST: z.coerce.number().int().positive().default(10),
  GITHUB_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30_000),
  GITHUB_HELPER_IMAGE: z.string().default("gantry-github:dev"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  GITHUB_SCRATCH_DIR: z.string().default("/tmp"),
  GITHUB_GATE_CHECK_NAME: z.string().default("Gantry gates"),
  GITHUB_ISSUE_LABEL: z.string().default("gantry"),
  GITHUB_GIT_BIN: z.string().default("git"),
});

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<GithubConfig> {
  const e = Env.parse(env);
  const [githubToken, pem, json] = await Promise.all([readSecretFile("github_token", env), readSecretFile("github_app.pem", env), readSecretFile("github_app.json", env)]);
  const s = AppSettings.parse(JSON.parse(json));
  return {
    port: e.GITHUB_PORT, host: "0.0.0.0", apiUrl: e.GANTRY_API_URL.replace(/\/+$/, ""), githubToken,
    app: { appId: s.appId, privateKey: pem, baseUrl: s.baseUrl.replace(/\/+$/, ""), ...(s.installationId ? { installationId: s.installationId } : {}) },
    writesPerMinute: e.GITHUB_WRITES_PER_MINUTE, writeBurst: e.GITHUB_WRITE_BURST, pollIntervalMs: e.GITHUB_POLL_INTERVAL_MS,
    helperImage: e.GITHUB_HELPER_IMAGE, dockerSocket: e.DOCKER_SOCKET, scratchDir: e.GITHUB_SCRATCH_DIR, gateCheckName: e.GITHUB_GATE_CHECK_NAME,
    maxWorkspaceBytes: 1024 * 1024 * 1024, maxPatchBytes: 2 * 1024 * 1024, maxCommitsPerPublish: 200, issueLabel: e.GITHUB_ISSUE_LABEL, gitBin: e.GITHUB_GIT_BIN,
  };
}
