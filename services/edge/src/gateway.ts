import { randomUUID } from "node:crypto";
import { upstreamFetch, type UpstreamInit } from "./upstream-guard.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiClient, authorizeCall, type Alternate, type Route } from "./api.js";
import type { EdgeConfig } from "./config.js";
import { VendorLimiter } from "./limiter.js";
import { scanJson, scanText, type Finding } from "./secrets-scan.js";
import { NoObjectStore, TraceIncrements, type ObjectStore } from "./trace.js";
import { SseUsage, usageFromJson, type Usage } from "./usage.js";
import { VendorKeys } from "./vendor-keys.js";
import { registerMcpRoutes, type McpMetrics } from "./mcp/routes.js";
import { registerServiceRoutes, type ServiceMetrics } from "./service-gateway.js";
import { registerResearchRoutes, type ResearchDeps } from "./research.js";
import { stepsOf } from "./steps.js";

export interface GatewayDeps {
  cfg: EdgeConfig;
  api?: ApiClient;
  store?: ObjectStore;
  keys?: VendorKeys;
  limiter?: VendorLimiter;
  fetchImpl?: typeof fetch;
  /** Tests: the research fetcher's outbound fetch (production uses undici with a public-only dispatcher). */
  researchFetch?: ResearchDeps["fetchImpl"];
  logger?: boolean | { level: string };
}

export interface GatewayMetrics {
  calls: number;
  refused: number;
  traceStored: number;
  /** Model calls whose trace could not be stored (degraded: the call went ahead, usage carries no trace reference). */
  traceDropped: number;
  usageReportFailures: number;
  /** Calls served by another vendor after the routed one failed. */
  fallbacks: number;
}

const RUN_TOKEN_RE = /^grt\.([A-Za-z0-9_-]{1,400})\.[A-Za-z0-9_-]{20,128}$/;

/** The run id named in a run token (a routing hint only; the API checks the token's stored hash). */
export function runIdOfToken(token: string): string | null {
  const m = RUN_TOKEN_RE.exec(token);
  if (!m) return null;
  const id = Buffer.from(m[1]!, "base64url").toString("utf8");
  return id.length > 0 ? id : null;
}

const PASS_RESPONSE_HEADERS = ["content-type", "retry-after", "request-id", "x-request-id", "x-should-retry", "retry-after-ms"];

/** Anthropic error envelope, so the SDK in the runner reports the refusal reason instead of a parse error. */
function modelError(reply: FastifyReply, status: number, type: string, message: string, extra: Record<string, string> = {}): FastifyReply {
  for (const [k, v] of Object.entries(extra)) reply.header(k, v);
  return reply.code(status).header("content-type", "application/json").send({ type: "error", error: { type, message } });
}

const statusForDenial = (code: string): { status: number; type: string } => {
  switch (code) {
    case "route":
      return { status: 400, type: "invalid_request_error" };
    default:
      return { status: 403, type: "permission_error" };
  }
};

function upstreamUrl(base: string, path: string): string {
  const p = base.endsWith("/v1") && path.startsWith("/v1/") ? path.slice(3) : path;
  return `${base}${p}`;
}

const bearerOf = (req: FastifyRequest): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
  if (m) return m[1]!;
  const k = req.headers["x-api-key"];
  return typeof k === "string" && k ? k : null;
};

export interface Gateway {
  app: FastifyInstance;
  metrics: GatewayMetrics;
  keys: VendorKeys;
  limiter: VendorLimiter;
  mcp: McpMetrics;
  /** Model calls that belong to no run (the console), spec 12.6. */
  service: ServiceMetrics;
  /** Governed web research: pages fetched and refused. */
  research: { fetched: number; refused: number };
  api: ApiClient;
  store: ObjectStore;
  /** Resolves when every model call's post-response work (trace, usage report) has finished. Used on shutdown and in tests. */
  drain(): Promise<void>;
}

/** The :8443 listener: model gateway (spec 5.3, 10.4) and the runner's control calls (spec 4.2, 4.3). */
export function buildGateway(deps: GatewayDeps): Gateway {
  const { cfg } = deps;
  const f = (deps.fetchImpl ?? upstreamFetch(cfg.blockPrivateAddresses)) as (url: string | URL, init?: UpstreamInit) => Promise<Response>;
  const api = deps.api ?? new ApiClient(cfg);
  const store = deps.store ?? new NoObjectStore();
  const keys = deps.keys ?? new VendorKeys(cfg.vendorKeys, api);
  const limiter = deps.limiter ?? new VendorLimiter(cfg.vendorConcurrency, cfg.queueWaitMs);
  const traces = new TraceIncrements();
  const metrics: GatewayMetrics = { calls: 0, refused: 0, traceStored: 0, traceDropped: 0, usageReportFailures: 0, fallbacks: 0 };
  const app = Fastify({
    logger: deps.logger ?? { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers['x-api-key']", "req.headers['proxy-authorization']"] },
    bodyLimit: cfg.maxBodyBytes,
    trustProxy: false,
  });
  // Bodies stay raw: the model request is forwarded byte for byte, run calls are parsed by their handlers.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: cfg.maxBodyBytes }, (_req, body, done) => done(null, body));
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });

  app.get("/healthz", { logLevel: "warn" }, async () => ({ ok: true }));

  // ------------------------------------------------------------------ model gateway
  const messages = async (req: FastifyRequest, reply: FastifyReply, countOnly: boolean): Promise<FastifyReply | void> => {
    const token = bearerOf(req);
    const runId = token ? runIdOfToken(token) : null;
    if (!token || !runId) {
      metrics.refused++;
      return modelError(reply, 401, "authentication_error", "A run token is required.");
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let body: Record<string, unknown>;
    try {
      const j: unknown = JSON.parse(raw.toString("utf8"));
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
      body = j as Record<string, unknown>;
    } catch {
      return modelError(reply, 400, "invalid_request_error", "The request body must be a JSON object.");
    }
    const model = typeof body.model === "string" ? body.model : undefined;

    // Fail closed: no answer from the API means no model call.
    const auth = await authorizeCall(api, runId, token, model);
    if (auth.allow === "unavailable") {
      metrics.refused++;
      req.log.error({ runId, reason: auth.reason }, "authorize unavailable: refusing model call");
      return modelError(reply, 503, "api_error", "Gantry could not verify this run right now; the call was refused.", { "retry-after": "5" });
    }
    if (!auth.allow) {
      metrics.refused++;
      const d = statusForDenial(auth.code);
      req.log.warn({ runId, code: auth.code }, "model call refused");
      return modelError(reply, d.status, d.type, auth.reason, { "x-gantry-denial": auth.code });
    }
    const primary: Route = auth.route;
    let route: Route = primary;
    // Spec 10.4 Fallback: alternates are the same model on another allowed vendor (and, only when the project opted in, a different model).
    // They are tried at a turn boundary: only when the vendor failed before a single byte reached the run.
    const alternates: Alternate[] = primary.alternates ?? [];
    // A model the vendor knows under another id (the same model on Bedrock, say) is called with that id.
    const bodyFor = (rt: { upstreamModel?: string }): Uint8Array<ArrayBuffer> => (rt.upstreamModel && body.model !== rt.upstreamModel ? new Uint8Array(Buffer.from(JSON.stringify({ ...body, model: rt.upstreamModel }))) : new Uint8Array(raw));
    const callTo = (rt: Route | Alternate, key: string | null, signal: AbortSignal): { url: string; init: UpstreamInit } => {
      const url = upstreamUrl(rt.baseUrl, countOnly ? "/v1/messages/count_tokens" : "/v1/messages");
      const headers: Record<string, string> = { "content-type": "application/json", "accept-encoding": "identity", "anthropic-version": String(req.headers["anthropic-version"] ?? "2023-06-01") };
      if (key) {
        headers["x-api-key"] = key;
        if (!/(^|\.)api\.anthropic\.com$/.test(new URL(url).hostname)) headers.authorization = `Bearer ${key}`;
      }
      if (typeof req.headers["anthropic-beta"] === "string") headers["anthropic-beta"] = req.headers["anthropic-beta"];
      if (typeof req.headers.accept === "string") headers.accept = req.headers.accept;
      return { url, init: { method: "POST", headers, body: bodyFor(rt), signal, lan: primary.lan } };
    };

    const key = await keys.get(route.vendor);
    if (!key && !primary.keyless) {
      metrics.refused++;
      return modelError(reply, 503, "api_error", `No API key is configured for vendor ${route.vendor}.`);
    }
    let slot = await limiter.acquire(route.vendor);
    if (!slot.ok) {
      metrics.refused++;
      return modelError(reply, 429, "rate_limit_error", `Vendor ${route.vendor} is ${slot.reason === "cooldown" ? "rate limiting" : "busy"}; retry later.`, { "retry-after": String(slot.retryAfterSeconds) });
    }

    metrics.calls++;
    const started = Date.now();
    const ac = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableFinished) ac.abort();
    };
    reply.raw.on("close", onClose);
    const timer = setTimeout(() => ac.abort(), cfg.vendorTimeoutMs);
    let status = 0;
    let outcome: "ok" | "error" = "ok";
    const sse = new SseUsage();
    let jsonUsage: Usage | undefined;
    let jsonBody: unknown;
    const chunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let vendorRequestId: string | undefined;
    let fallback: "same_model" | "cross_model" | undefined = primary.crossModel ? "cross_model" : undefined;
    const retryable = (st: number): boolean => st === 429 || st === 500 || st === 502 || st === 503 || st === 504 || st === 529;
    reply.hijack();
    try {
      const pause = (vendor: string, res: Response): void => {
        if (res.status === 429 || res.status === 529 || res.status === 503) {
          const ra = Number(res.headers.get("retry-after"));
          limiter.pause(vendor, Number.isFinite(ra) && ra > 0 ? ra : res.status === 429 ? 5 : 2);
        }
      };
      let res: Response | undefined;
      let failure: unknown;
      try {
        const c = callTo(route, key, ac.signal);
        res = await f(c.url, c.init);
        pause(route.vendor, res);
      } catch (e) {
        failure = e;
      }
      for (const alt of alternates) {
        if (ac.signal.aborted || (res && !retryable(res.status))) break;
        const altKey = await keys.get(alt.vendor);
        if (!altKey && !alt.keyless) continue;
        const altSlot = await limiter.acquire(alt.vendor);
        if (!altSlot.ok) continue;
        try {
          const c = callTo(alt, altKey, ac.signal);
          const altRes = await f(c.url, c.init);
          pause(alt.vendor, altRes);
          // The first vendor's answer is dropped unread: nothing of it reached the run.
          if (res) await res.body?.cancel().catch(() => undefined);
          slot.release();
          slot = altSlot;
          res = altRes;
          failure = undefined;
          route = { vendor: alt.vendor, baseUrl: alt.baseUrl, modelId: alt.modelId, upstreamModel: alt.upstreamModel };
          fallback = alt.crossModel || fallback === "cross_model" ? "cross_model" : "same_model";
          req.log.warn({ runId, from: primary.vendor, to: alt.vendor, model: alt.modelId, crossModel: alt.crossModel }, "vendor failed: fell back");
          metrics.fallbacks++;
        } catch (e) {
          altSlot.release();
          failure ??= e;
        }
      }
      if (!res) throw failure ?? new Error("no response");
      status = res.status;
      vendorRequestId = res.headers.get("request-id") ?? res.headers.get("x-request-id") ?? undefined;
      const out: Record<string, string> = {};
      for (const h of PASS_RESPONSE_HEADERS) {
        const v = res.headers.get(h);
        if (v) out[h] = v;
      }
      res.headers.forEach((v, k) => {
        if (k.startsWith("anthropic-ratelimit-")) out[k] = v;
      });
      out["cache-control"] = "no-store";
      reply.raw.writeHead(res.status, out);
      const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
      const dec = new TextDecoder();
      if (res.body) {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (!reply.raw.write(chunk)) await new Promise<void>((r) => reply.raw.once("drain", r));
          if (isSse) sse.push(dec.decode(chunk, { stream: true }));
          if (captured < cfg.maxTraceBytes) {
            chunks.push(Buffer.from(chunk));
            captured += chunk.length;
          } else truncated = true;
        }
      }
      sse.end();
      reply.raw.end();
      if (!isSse) {
        try {
          jsonBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          jsonUsage = usageFromJson(jsonBody);
        } catch {
          /* non-JSON vendor error page: passed through, no usage */
        }
      }
      if (res.status >= 400) outcome = "error";
    } catch (e) {
      outcome = "error";
      req.log.warn({ runId, err: e instanceof Error ? e.message : String(e) }, "vendor call failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
        reply.raw.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "The model vendor could not be reached." } }));
        status = 502;
      } else reply.raw.destroy();
    } finally {
      clearTimeout(timer);
      reply.raw.off("close", onClose);
      slot.release();
    }
    if (countOnly) return;

    // ---- after the response: trace, then usage. Neither can change what the runner already received.
    const usage: Usage = sse.usage.seen ? sse.usage : (jsonUsage ?? sse.usage);
    const requestId = vendorRequestId ?? sse.messageId ?? `edge-${randomUUID()}`;
    const traceRef = await captureTrace(req, runId, route, body, sse.usage.seen ? sse.message : (jsonBody ?? Buffer.concat(chunks).toString("utf8")), status, truncated, requestId);
    const rep = await api.call("POST", `/internal/v1/runs/${encodeURIComponent(runId)}/usage`, {
      token,
      requestId,
      model: route.modelId,
      vendor: route.vendor,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      latencyMs: Date.now() - started,
      outcome,
      ...(fallback ? { fallback, wanted: primary.modelId } : {}),
      ...(traceRef ? { traceRef } : {}),
    });
    if (rep.kind !== "ok") {
      metrics.usageReportFailures++;
      req.log.error({ runId, requestId, kind: rep.kind }, "usage report failed");
    }
  };

  /** Scan, then store as sha256/<hash>. Degrades to no reference when the store is down; never stores unscanned content. */
  async function captureTrace(req: FastifyRequest, runId: string, route: Route, reqBody: Record<string, unknown>, response: unknown, status: number, truncated: boolean, requestId: string): Promise<string | undefined> {
    try {
      const { delta } = traces.build(runId, reqBody);
      const record = { v: 1, runId, requestId, vendor: route.vendor, model: route.modelId, status, truncated, request: delta, response };
      const scanned = scanJson(record, keys.knownKeys());
      const doc = { ...(scanned.value as Record<string, unknown>), redactions: scanned.findings };
      const ref = await store.put(JSON.stringify(doc), "application/json");
      metrics.traceStored++;
      if (scanned.findings.length) req.log.warn({ runId, findings: scanned.findings as Finding[] }, "secrets redacted from trace");
      return ref;
    } catch (e) {
      metrics.traceDropped++;
      req.log.error({ runId, err: e instanceof Error ? e.message : String(e) }, "trace not stored (degraded: call proceeded without a trace reference)");
      return undefined;
    }
  }

  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => undefined);
    return p;
  };
  app.post("/model/v1/messages", (req, reply) => track(messages(req, reply, false)));
  app.post("/model/v1/messages/count_tokens", (req, reply) => track(messages(req, reply, true)));
  app.all("/model/*", async (_req, reply) => modelError(reply, 404, "not_found_error", "Only the Messages API is served here."));

  // MCP gateway (spec 6.4, 12.4): services/edge/src/mcp. The runner sees one endpoint per allowed server; the edge holds the credentials.
  const mcp = registerMcpRoutes(app, {
    cfg, api,
    knownKeys: () => keys.knownKeys(),
    runAuth: (req) => {
      const token = bearerOf(req);
      const runId = token ? runIdOfToken(token) : null;
      return token && runId ? { runId, token } : null;
    },
  });

  // ------------------------------------------------------------------ runner control calls
  const runAuth = (req: FastifyRequest): { runId: string; token: string } | null => {
    const token = bearerOf(req);
    const runId = token ? runIdOfToken(token) : null;
    if (!token || !runId) return null;
    const claimed = req.headers["x-gantry-run-id"];
    if (typeof claimed === "string" && claimed !== runId) return null;
    return { runId, token };
  };
  const relay = (reply: FastifyReply, r: Awaited<ReturnType<ApiClient["call"]>>): FastifyReply => {
    if (r.kind === "unavailable") return reply.code(503).send({ ok: false, msg: "The control plane is unavailable." });
    // 401 from the API would be the edge's own token failing: never shown as the runner's problem (ApiClient maps it to unavailable).
    return reply.code(r.status).send(r.body);
  };
  const jsonBody = (req: FastifyRequest): Record<string, unknown> | null => {
    try {
      const j: unknown = JSON.parse((Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)).toString("utf8"));
      return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const denyRun = (reply: FastifyReply): FastifyReply => reply.code(401).send({ ok: false, msg: "A valid run token is required." });
  const invalid = (reply: FastifyReply, msg: string): FastifyReply => reply.code(422).send({ ok: false, msg });
  const strip = (b: Record<string, unknown>, ...drop: string[]): Record<string, unknown> => {
    const o = { ...b };
    for (const k of ["runId", "at", ...drop]) delete o[k];
    return o;
  };

  app.get("/run/v1/spec", async (req, reply) => {
    const a = runAuth(req);
    if (!a) return denyRun(reply);
    return relay(reply, await api.call("GET", `/internal/v1/runs/${encodeURIComponent(a.runId)}/spec`, undefined, { "x-run-token": a.token }));
  });

  app.post("/run/v1/heartbeat", async (req, reply) => {
    const a = runAuth(req);
    if (!a) return denyRun(reply);
    const b = jsonBody(req);
    if (!b) return invalid(reply, "The body must be a JSON object.");
    return relay(reply, await api.call("POST", `/internal/v1/runs/${encodeURIComponent(a.runId)}/heartbeat`, { ...strip(b, "token"), token: a.token }));
  });

  const DOC_MAX_BYTES = 512 * 1024;
  const Checkpoint = z.looseObject({ turn: z.number().int().nonnegative(), kind: z.enum(["transcript", "artefact"]), name: z.string().min(1).max(300), contentType: z.string().min(1).max(200), content: z.string() });
  app.post("/run/v1/checkpoint", async (req, reply) => {
    const a = runAuth(req);
    if (!a) return denyRun(reply);
    const p = Checkpoint.safeParse(jsonBody(req));
    if (!p.success) return invalid(reply, `Invalid checkpoint: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    // Spec 5.3 stored content: scan before it is stored. If it cannot be stored the checkpoint fails (503, the runner retries): a checkpoint
    // that points at nothing is worse than a late one.
    const scanned = scanText(p.data.content, keys.knownKeys());
    const bytes = Buffer.from(scanned.text, "utf8");
    let ref: string;
    try {
      ref = await store.put(bytes, p.data.contentType);
    } catch (e) {
      req.log.error({ runId: a.runId, err: e instanceof Error ? e.message : String(e) }, "checkpoint not stored: object storage unavailable");
      return reply.code(503).send({ ok: false, msg: "Object storage is unavailable; the checkpoint was not saved." });
    }
    if (scanned.findings.length) req.log.warn({ runId: a.runId, name: p.data.name, findings: scanned.findings }, "secrets redacted from checkpoint");
    const r = await api.call("POST", `/internal/v1/runs/${encodeURIComponent(a.runId)}/checkpoint`, {
      token: a.token,
      turn: p.data.turn,
      kind: p.data.kind,
      name: p.data.name,
      contentType: p.data.contentType,
      contentHash: ref.slice("sha256/".length),
      size: bytes.length,
      // A station document (markdown) is also kept with its artefact row, so people can read and compare it (the API cannot reach object storage).
      // It is the scanned text: secrets were already redacted above.
      ...(p.data.kind === "artefact" && /^text\/markdown\b/i.test(p.data.contentType) && bytes.length <= DOC_MAX_BYTES ? { content: scanned.text } : {}),
      // A transcript's tool calls, as names and short targets, for the run timeline (src/steps.ts).
      ...(p.data.kind === "transcript" ? { steps: stepsOf(p.data.content, p.data.turn, keys.knownKeys()) } : {}),
    });
    return relay(reply, r);
  });

  app.post("/run/v1/result", async (req, reply) => {
    const a = runAuth(req);
    if (!a) return denyRun(reply);
    const b = jsonBody(req);
    if (!b) return invalid(reply, "The body must be a JSON object.");
    // The result is stored by the API, so secrets are redacted on the way (spec 5.3 stored content).
    const s = scanJson(strip(b, "token"), keys.knownKeys());
    if (s.findings.length) req.log.warn({ runId: a.runId, findings: s.findings }, "secrets redacted from run result");
    return relay(reply, await api.call("POST", `/internal/v1/runs/${encodeURIComponent(a.runId)}/result`, { ...(s.value as Record<string, unknown>), token: a.token }));
  });

  // Governed web research (agent workspace, Phase 2): src/research.ts.
  const research = registerResearchRoutes(app, { api, store, knownKeys: () => keys.knownKeys(), runAuth, jsonBody, ...(deps.researchFetch ? { fetchImpl: deps.researchFetch } : {}) });

  // Model calls for the console and "explain why not" (spec 12.6): the API calls with the edge token, the key stays here.
  const service = registerServiceRoutes({ app, cfg, api, keys, limiter, fetchImpl: f as typeof fetch, track, store, maxTraceBytes: cfg.maxTraceBytes });

  return { app, metrics, mcp, service, research, keys, limiter, api, store, drain: async () => void (await Promise.allSettled([...pending])) };
}
