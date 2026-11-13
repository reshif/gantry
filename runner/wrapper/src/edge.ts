import { z } from "zod";
import { err, ok, type Result } from "./result.js";
import { RunSpec } from "./spec.js";
import type { RunEnv } from "./env.js";

export type EdgeError =
  /** The edge refused the run token (stopped, superseded, unknown). The runner must stop. */
  | { kind: "refused"; status: number; msg: string }
  | { kind: "unavailable"; msg: string }
  | { kind: "invalid"; msg: string };

export interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export type RunStatus = "succeeded" | "failed" | "interrupted";

export interface RunResult {
  status: RunStatus;
  /** Structured station output. Fields are agent-reported (spec 10.3); the edge/API adds system-observed values. */
  output?: unknown;
  usage: UsageEntry[];
  error?: { code: string; msg: string };
  adapter: string;
  capabilities: Capabilities;
}

/** Spec 10.1 capability descriptor. */
export interface Capabilities {
  cancel: boolean;
  resume: boolean;
  mcp: boolean;
  usageDetail: boolean;
}

export interface Heartbeat {
  seq: number;
  phase: "starting" | "working" | "finishing";
  turn?: number;
}

export interface Checkpoint {
  turn: number;
  /** Transcript increments or station artefacts; the edge stores them by reference in object storage. */
  kind: "transcript" | "artefact";
  name: string;
  contentType: string;
  /** UTF-8 text. */
  content: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface EdgeClientOptions {
  fetchImpl?: typeof fetch;
  /** Retries for transient failures (network, 5xx). Refusals (401/403/409/410) are never retried. */
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
}

/** Everything the runner says to the edge, on the per-run token. The edge is the runner's only peer. */
export class EdgeClient {
  private readonly f: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;

  constructor(
    private readonly env: Pick<RunEnv, "edgeUrl" | "runToken" | "runId">,
    opts: EdgeClientOptions = {},
  ) {
    this.f = opts.fetchImpl ?? fetch;
    this.retries = opts.retries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<Result<unknown, EdgeError>> {
    let last: EdgeError = { kind: "unavailable", msg: "no attempt" };
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs * 2 ** (attempt - 1));
      if (signal?.aborted) return err({ kind: "unavailable", msg: "aborted" });
      try {
        const init: RequestInit = {
          method,
          headers: {
            authorization: `Bearer ${this.env.runToken}`,
            "x-gantry-run-id": this.env.runId,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await this.f(`${this.env.edgeUrl}${path}`, init);
        if ([401, 403, 409, 410].includes(res.status)) {
          return err({ kind: "refused", status: res.status, msg: `edge refused ${method} ${path}: ${res.status}` });
        }
        if (res.status >= 500 || res.status === 429) {
          last = { kind: "unavailable", msg: `edge ${method} ${path}: ${res.status}` };
          continue;
        }
        if (!res.ok) return err({ kind: "invalid", msg: `edge ${method} ${path}: ${res.status}` });
        const text = await res.text();
        if (text === "") return ok(undefined);
        try {
          return ok(JSON.parse(text) as unknown);
        } catch {
          return err({ kind: "invalid", msg: `edge ${method} ${path}: response is not JSON` });
        }
      } catch (e) {
        last = { kind: "unavailable", msg: `edge ${method} ${path}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    return err(last);
  }

  async getSpec(signal?: AbortSignal): Promise<Result<RunSpec, EdgeError>> {
    const r = await this.call("GET", "/run/v1/spec", undefined, signal);
    if (!r.ok) return r;
    const p = RunSpec.safeParse(r.value);
    if (!p.success) return err({ kind: "invalid", msg: `run spec invalid: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    return ok(p.data);
  }

  async heartbeat(hb: Heartbeat, signal?: AbortSignal): Promise<Result<void, EdgeError>> {
    const r = await this.call("POST", "/run/v1/heartbeat", { runId: this.env.runId, at: new Date().toISOString(), ...hb }, signal);
    return r.ok ? ok(undefined) : r;
  }

  async checkpoint(cp: Checkpoint, signal?: AbortSignal): Promise<Result<void, EdgeError>> {
    const r = await this.call("POST", "/run/v1/checkpoint", { runId: this.env.runId, at: new Date().toISOString(), ...cp }, signal);
    return r.ok ? ok(undefined) : r;
  }

  async result(res: RunResult): Promise<Result<void, EdgeError>> {
    const r = await this.call("POST", "/run/v1/result", { runId: this.env.runId, at: new Date().toISOString(), ...res });
    return r.ok ? ok(undefined) : r;
  }
}

export const UsageEntrySchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  costUsd: z.number().optional(),
});
