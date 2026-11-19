import type { EdgeConfig } from "./config.js";

export type ApiResult = { kind: "ok"; status: number; body: Record<string, unknown> } | { kind: "refused"; status: number; body: Record<string, unknown> } | { kind: "unavailable"; msg: string };

/**
 * The edge's only peer on the control side: the API's /internal/v1 on the edge service token.
 * Anything that is not a clear answer (network error, timeout, 5xx, unparseable body) is `unavailable`, and callers fail closed on it.
 */
export class ApiClient {
  constructor(
    private readonly cfg: Pick<EdgeConfig, "apiUrl" | "edgeToken" | "apiTimeoutMs">,
    private readonly f: typeof fetch = fetch,
  ) {}

  async call(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
    try {
      const res = await this.f(`${this.cfg.apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.cfg.edgeToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.cfg.apiTimeoutMs),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        return { kind: "unavailable", msg: `API ${method} ${path}: ${res.status} with a non-JSON body` };
      }
      const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
      if (res.status >= 500 || res.status === 429 || res.status === 401) return { kind: "unavailable", msg: `API ${method} ${path}: ${res.status}` };
      if (res.status >= 200 && res.status < 300) return { kind: "ok", status: res.status, body: obj };
      return { kind: "refused", status: res.status, body: obj };
    } catch (e) {
      return { kind: "unavailable", msg: `API ${method} ${path}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

export interface Route {
  vendor: string;
  baseUrl: string;
  modelId: string;
  /** The id the vendor's API expects for this model. The request's model is rewritten to it when it differs. */
  upstreamModel?: string;
  /** The vendor needs no key (an on-prem endpoint without a token). */
  keyless?: boolean;
  /** The primary route is itself a different model than the run pinned (the project opted in to cross-model fallback). */
  crossModel?: boolean;
  /** Tried in order when the vendor fails before any byte reached the run (spec 10.4 Fallback). */
  alternates?: Alternate[];
  /** LAN ranges a Factory Admin opened for on-prem vendor endpoints (S-68). Absent: public addresses only. */
  lan?: string[];
}
export interface Alternate {
  vendor: string;
  baseUrl: string;
  modelId: string;
  upstreamModel: string;
  keyless?: boolean;
  /** A different model than the one the run pinned. */
  crossModel: boolean;
}

export type Authorization = { allow: true; route: Route } | { allow: false; code: string; reason: string } | { allow: "unavailable"; reason: string };

export async function authorizeCall(api: ApiClient, runId: string, token: string, model: string | undefined): Promise<Authorization> {
  const r = await api.call("POST", `/internal/v1/runs/${encodeURIComponent(runId)}/authorize`, { token, ...(model ? { model } : {}) });
  if (r.kind === "unavailable") return { allow: "unavailable", reason: r.msg };
  if (r.kind === "refused") return { allow: false, code: r.status === 409 ? "stopped" : "token", reason: String(r.body.msg ?? "Refused.") };
  if (r.body.allow === true) {
    const route = r.body.route as Route | undefined;
    if (route && typeof route.vendor === "string" && typeof route.baseUrl === "string" && typeof route.modelId === "string") return { allow: true, route };
    return { allow: "unavailable", reason: "API allowed the call without a route" };
  }
  if (r.body.allow === false) return { allow: false, code: String(r.body.code ?? "denied"), reason: String(r.body.reason ?? r.body.msg ?? "Denied.") };
  return { allow: "unavailable", reason: "API answer carried no decision" };
}
