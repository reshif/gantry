import { errMsg, TransientError } from "../errors.js";
import { failFor, jsonRequest } from "./http.js";

export interface LauncherRun {
  runId: string;
  variant?: string;
  workspaceRef?: string;
  container: unknown | null;
  network: unknown | null;
  volume: unknown | null;
}

export interface StartRun {
  runId: string;
  workspaceRef: string;
  variant: string;
  runToken: string;
  seedComplete?: boolean;
}

export type StartOutcome = { state: "prepared" | "started" | "running" } | { state: "capacity"; msg: string };

export interface StopOutcome {
  found: boolean;
  errors: string[];
}

/** gantry-launcher (spec 6.3): start-run, stop-run, list-runs over HTTP with the launcher token. */
export interface LauncherClient {
  start(r: StartRun): Promise<StartOutcome>;
  stop(runId: string, o: { keepWorkspace: boolean }): Promise<StopOutcome>;
  list(): Promise<LauncherRun[]>;
}

export function launcherClient(base: string, token: string, fetchImpl?: typeof fetch): LauncherClient {
  const call = (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => jsonRequest(base, token, method, path, body, fetchImpl ? { fetchImpl } : {});
  return {
    async start(r) {
      const res = await call("POST", "/v1/runs", r);
      if (res.status === 200 || res.status === 201) return { state: (res.body as { state: "prepared" | "started" | "running" }).state };
      // Capacity and subnet exhaustion are not failures of the run: the dispatch waits for room (the caller defers it).
      if (res.status === 429) return { state: "capacity", msg: String((res.body as { msg?: string }).msg ?? "launcher at capacity") };
      return failFor("launcher start-run", res);
    },
    async stop(runId, o) {
      const res = await call("DELETE", `/v1/runs/${encodeURIComponent(runId)}?keepWorkspace=${o.keepWorkspace ? "true" : "false"}`);
      if (res.status === 200) {
        const b = res.body as { found?: boolean; errors?: string[] };
        return { found: b.found !== false, errors: b.errors ?? [] };
      }
      if (res.status === 500) throw new TransientError(`launcher stop-run incomplete for ${runId}: ${(res.body as { msg?: string }).msg ?? ""}`, "teardown_incomplete");
      return failFor("launcher stop-run", res);
    },
    async list() {
      const res = await call("GET", "/v1/runs");
      if (res.status !== 200) return failFor("launcher list-runs", res);
      return ((res.body as { runs?: LauncherRun[] }).runs ?? []).map((r) => ({ ...r }));
    },
  };
}

export const describe = errMsg;
