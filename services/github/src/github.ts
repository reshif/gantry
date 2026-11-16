/**
 * GitHub App authentication (spec 5.3, 6.5, 11.1). The private key lives only in this process. Every operation mints its own installation token,
 * scoped to ONE repository and the least permissions that operation needs, keeps it in memory for the length of the call, and revokes it afterwards
 * where the server allows. Tokens are never logged, stored or returned.
 */
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { GithubConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { WriteLimiter } from "./ratelimit.js";

export type Perm = "read" | "write";
export type Permissions = Partial<Record<"metadata" | "contents" | "pull_requests" | "issues" | "checks" | "actions" | "statuses" | "administration" | "workflows", Perm>>;

/**
 * The permission set per operation. The union is exactly the App's repository permissions in spec 11.1 (Metadata read; Contents write; Pull requests write;
 * Issues write; Checks write; Actions read; Commit statuses read; Administration read). Issues are only ever requested for reading here;
 * the App grants write for the trigger replies that other components may add later.
 */
export const OPERATIONS = {
  seed: { contents: "read", metadata: "read" },
  publish: { contents: "write", pull_requests: "write", metadata: "read" },
  pull_request: { pull_requests: "write", contents: "read", metadata: "read" },
  gate_check: { checks: "write", pull_requests: "read", metadata: "read" },
  draft: { pull_requests: "write", metadata: "read" },
  merge: { contents: "write", pull_requests: "write", metadata: "read" },
  read_state: { pull_requests: "read", checks: "read", statuses: "read", actions: "read", issues: "read", contents: "read", metadata: "read" },
  protections: { administration: "read", contents: "read", pull_requests: "read", metadata: "read" },
  // Onboarding (spec 11.3). Workflows write is requested only for an onboarding pull request that adds a workflow file (spec 11.1).
  onboard_read: { contents: "read", metadata: "read" },
  onboard_pr: { contents: "write", pull_requests: "write", metadata: "read" },
  onboard_pr_workflows: { contents: "write", pull_requests: "write", workflows: "write", metadata: "read" },
  canary: { contents: "write", pull_requests: "write", checks: "read", statuses: "read", metadata: "read" },
  list_repos: { metadata: "read" },
} as const satisfies Record<string, Permissions>;
export type Operation = keyof typeof OPERATIONS;
/** Operations that change GitHub and so pass through the write limiter. */
export const WRITE_OPERATIONS: readonly Operation[] = ["publish", "pull_request", "gate_check", "draft", "merge", "onboard_pr", "onboard_pr_workflows", "canary"];

export const splitRepo = (full: string): { owner: string; name: string } => {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(full);
  if (!m) throw new Error(`not a repository name: ${full}`);
  return { owner: m[1]!, name: m[2]! };
};

export class GithubApiError extends Error {
  constructor(readonly status: number, message: string, readonly data?: unknown) { super(message); }
}

export interface RepoClient {
  octokit: Octokit;
  owner: string;
  name: string;
  full: string;
  installationId: number;
  /** Runs a write under the installation's write limiter. */
  write<T>(fn: () => Promise<T>): Promise<T>;
  /** The installation token, for `git` over HTTPS only (seed). Never log it. */
  token: string;
}

export class GithubApp {
  readonly app: App;
  private readonly installations = new Map<string, number>();
  readonly limiter: WriteLimiter;
  private readonly Base: typeof Octokit;

  constructor(private readonly cfg: NonNullable<GithubConfig["app"]>, limiter: WriteLimiter, private readonly f?: typeof fetch) {
    this.limiter = limiter;
    this.Base = Octokit.defaults({ baseUrl: cfg.baseUrl, userAgent: "gantry-github", ...(f ? { request: { fetch: f } } : {}) }) as unknown as typeof Octokit;
    this.app = new App({ appId: cfg.appId, privateKey: cfg.privateKey, Octokit: this.Base as never });
  }

  /** The App-authenticated (JWT) client: installation lookup, hook deliveries. No repository access. */
  get jwt(): Octokit {
    return this.app.octokit as unknown as Octokit;
  }

  /** Unauthenticated client for the few public endpoints (server version via /meta). */
  get anonymous(): Octokit {
    return new this.Base({});
  }

  async installationFor(full: string): Promise<number> {
    if (this.cfg.installationId) return this.cfg.installationId;
    const hit = this.installations.get(full);
    if (hit) return hit;
    const { owner, name } = splitRepo(full);
    const r = await this.jwt.request("GET /repos/{owner}/{repo}/installation", { owner, repo: name });
    this.installations.set(full, r.data.id);
    return r.data.id;
  }

  /** Mints a token for one repository with the operation's permissions, runs `fn`, then revokes the token. */
  async withRepo<T>(full: string, op: Operation, fn: (c: RepoClient) => Promise<T>): Promise<T> {
    const { owner, name } = splitRepo(full);
    const installationId = await this.installationFor(full);
    const minted = await this.jwt.request("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: installationId, repositories: [name], permissions: OPERATIONS[op] as Record<string, string>,
    }).catch((e: unknown) => {
      const a = toApiError(e);
      throw new BrokerError(502, "token", `GitHub would not issue a ${op} token for ${full} (${a.status}): ${a.message}`);
    });
    const token = minted.data.token;
    const octokit = new this.Base({ auth: token });
    try {
      return await fn({ octokit, owner, name, full, installationId, token, write: (w) => this.limiter.write(String(installationId), w) });
    } finally {
      // Revoked on completion where GitHub allows it; failure to revoke is not an error (the token expires in an hour).
      await octokit.request("DELETE /installation/token").catch(() => undefined);
    }
  }
  /** Like `withRepo` but for the whole installation (listing the repositories the App can see). Metadata only; the token is revoked afterwards. */
  async withInstallation<T>(installationId: number, op: Operation, fn: (c: { octokit: Octokit; installationId: number }) => Promise<T>): Promise<T> {
    const minted = await this.jwt.request("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: installationId, permissions: OPERATIONS[op] as Record<string, string>,
    }).catch((e: unknown) => {
      const a = toApiError(e);
      throw new BrokerError(502, "token", `GitHub would not issue a ${op} token for installation ${installationId} (${a.status}): ${a.message}`);
    });
    const octokit = new this.Base({ auth: minted.data.token });
    try {
      return await fn({ octokit, installationId });
    } finally {
      await octokit.request("DELETE /installation/token").catch(() => undefined);
    }
  }
}

/** Translates an Octokit error into a GithubApiError with a safe message (no headers, no tokens). */
export function toApiError(e: unknown): GithubApiError {
  const x = e as { status?: number; message?: string; response?: { data?: unknown } };
  if (typeof x?.status === "number") return new GithubApiError(x.status, String(x.message ?? "GitHub request failed").slice(0, 500), x.response?.data);
  return new GithubApiError(502, String((e as Error)?.message ?? e).slice(0, 500));
}
