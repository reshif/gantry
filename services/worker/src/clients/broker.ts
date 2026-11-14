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
  mergeable: boolean | null;
  mergeableState: string | null;
}

export type MergeOutcome =
  | { ok: true; merged: boolean; mergeSha: string | null; alreadyMerged: boolean }
  | { ok: false; code: "head_moved" | "not_mergeable" | "not_open" | "fenced" | string; msg: string; headSha?: string };

/** gantry-github (spec 6.5): everything that touches GitHub goes through this service. */
export interface BrokerClient {
  seed(b: { repo: string; commit: string; volume: string }): Promise<void>;
  publish(b: PublishRequest): Promise<PublishOutcome>;
  gateCheck(b: { woId: string; repo: string; headSha: string; state: "passing" | "failing" | "pending"; summary?: string }): Promise<{ ok: boolean; skipped?: string }>;
  convertToDraft(b: { woId: string; repo: string; number: number }): Promise<{ ok: boolean; skipped?: string }>;
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
  return {
    async seed(b) {
      const r = await call("POST", "/v1/workspaces/seed", b, 600_000);
      if (!ok(r)) failFor("github seed", r);
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

