import type { GithubConfig } from "./config.js";

export interface FenceAllowed { allow: true; woId: string; attemptId: string | null; projectId: string; repoId: string | null; repo: string | null; branch: string; reason: string }
export interface FenceDenied { allow: false; code: string; reason: string; woId: string | null }
export type Fence = FenceAllowed | FenceDenied;

export type ApiResult<T> = { kind: "ok"; status: number; body: T } | { kind: "refused"; status: number; body: Record<string, unknown> } | { kind: "unavailable"; msg: string };

export interface BrokerRepo { id: string; repo: string; installationId: number | null; projectId: string; defaultBranch: string; branchPrefix: string }

/** Onboarding writes: opening or updating the pull request (`write`), merging it (`merge`) and the readiness canary. A kill refuses all three; a halt refuses only the merge, as in the decision point (spec 9.7). */
export type OnboardingPurpose = "write" | "merge" | "canary";

export type FencePurpose = "publish" | "pr" | "check_pass" | "check_pending" | "check_fail" | "merge" | "draft";

/**
 * The broker's only peer on the control side: the API's /internal/v1 on the github service token (spec 8.11).
 * Anything that is not a clear answer (network error, timeout, 5xx, unparseable body) is `unavailable`, and a write fails closed on it.
 */
export class ApiClient {
  constructor(private readonly cfg: Pick<GithubConfig, "apiUrl" | "githubToken">, private readonly f: typeof fetch = fetch, private readonly timeoutMs = 10_000) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
    try {
      const res = await this.f(`${this.cfg.apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.cfg.githubToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { return { kind: "unavailable", msg: `unparseable response (${res.status})` }; }
      if (res.status >= 500) return { kind: "unavailable", msg: `API error ${res.status}` };
      if (typeof json !== "object" || json === null) return { kind: "unavailable", msg: "unexpected response" };
      return res.ok ? { kind: "ok", status: res.status, body: json as T } : { kind: "refused", status: res.status, body: json as Record<string, unknown> };
    } catch (e) {
      return { kind: "unavailable", msg: (e as Error).message };
    }
  }

  private toFence(r: ApiResult<Record<string, unknown>>): Fence {
    if (r.kind === "ok" && r.body.allow === true) return r.body as unknown as FenceAllowed;
    if (r.kind === "ok") return { allow: false, code: String(r.body.code ?? "denied"), reason: String(r.body.reason ?? "refused"), woId: (r.body.woId as string | null) ?? null };
    if (r.kind === "refused") return { allow: false, code: "refused", reason: String(r.body.msg ?? `API refused (${r.status})`), woId: null };
    return { allow: false, code: "unavailable", reason: `Could not confirm the attempt with the API: ${r.msg}`, woId: null };
  }

  async fenceAttempt(attemptId: string, fencing: number, repo?: string): Promise<Fence> {
    return this.toFence(await this.call("POST", `/internal/v1/attempts/${encodeURIComponent(attemptId)}/fence-check`, { fencing, purpose: "publish", ...(repo ? { repo } : {}) }));
  }

  async fenceWorkOrder(woId: string, purpose: FencePurpose, repo?: string): Promise<Fence> {
    return this.toFence(await this.call("POST", `/internal/v1/work-orders/${encodeURIComponent(woId)}/fence-check`, { purpose, ...(repo ? { repo } : {}) }));
  }

  /** Fence for repository-level onboarding writes, which belong to no work order. */
  async fenceOnboarding(repo: string, purpose: OnboardingPurpose): Promise<{ allow: true } | { allow: false; code: string; reason: string }> {
    const r = await this.call<Record<string, unknown>>("POST", "/internal/v1/onboarding/fence", { repo, purpose });
    if (r.kind === "ok" && r.body.allow === true) return { allow: true };
    if (r.kind === "ok") return { allow: false, code: String(r.body.code ?? "denied"), reason: String(r.body.reason ?? "refused") };
    if (r.kind === "refused") return { allow: false, code: "refused", reason: String(r.body.msg ?? `API refused (${r.status})`) };
    return { allow: false, code: "unavailable", reason: `Could not confirm the repository with the API: ${r.msg}` };
  }

  /** Facts for storage and reconciliation (spec 11.6). */
  postFacts(facts: Record<string, unknown>): Promise<ApiResult<{ ok: true; counts: Record<string, number>; merged: number[] }>> {
    return this.call("POST", "/internal/v1/github/events", facts);
  }

  listRepos(): Promise<ApiResult<{ ok: true; repos: BrokerRepo[] }>> {
    return this.call("GET", "/internal/v1/github/repos");
  }
}
