import { fetchRiding, causeOf } from "./blip-retry.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiClient, Route } from "./api.js";
import type { EdgeConfig } from "./config.js";
import type { VendorLimiter } from "./limiter.js";
import { SseUsage, usageFromJson, type Usage } from "./usage.js";
import type { VendorKeys } from "./vendor-keys.js";
import { scanJson, type Finding } from "./secrets-scan.js";
import type { ObjectStore } from "./trace.js";

/**
 * Model calls that belong to no run (spec 12.6): the console and "explain why not" call a model through the edge like a run does, so the
 * vendor keys stay here. The caller is the API itself, authenticated with the edge token (a run token is not accepted on this path, and the
 * edge token is not accepted on /model). The API decides the route (`/internal/v1/service-calls/authorize`) and meters the call
 * (`/usage`); the edge holds the key, the vendor concurrency slot and the stream.
 *
 *   POST /service/v1/messages   a Messages API body; `x-gantry-purpose: console|explain|onboarding`. `model` is ignored: routing picks it, or the API's validated choice in `x-gantry-model-pick` (+ `x-gantry-project`) does.
 *   GET  /service/v1/trace/{ref} the stored trace of a call (edge token only: the API checks who may read it, then asks here)
 *
 * Every call is traced like a run's (spec 7.4): the full request (system prompt, tools, messages) and the answer are scanned for secrets, redacted and stored
 * as sha256/<hash>, and the reference goes to the API on the usage report together with where the call belongs (project, work order, person, turn) and the
 * prompt manifest hash the API sent (`x-gantry-manifest`, base64url JSON). Same store and retention as the run traces; a store outage degrades to a call with no reference.
 *
 *   GET  /service/v1/ready      { ready, reason?, vendor?, model? }: can a call be made right now (a route exists and its key is present)
 */

const PURPOSES = new Set(["console", "explain", "onboarding"]);
const SURFACES = new Set(["console", "explain", "onboarding", "workorder"]);
/** The prompt manifest travels in a header; a bigger one is ignored (the caller sends a compact form, and the trace holds the full request). */
const MAX_MANIFEST_B64 = 12_000;

const fail = (reply: FastifyReply, status: number, type: string, message: string, extra: Record<string, string> = {}): FastifyReply => {
  for (const [k, v] of Object.entries(extra)) reply.header(k, v);
  return reply.code(status).header("content-type", "application/json").send({ type: "error", error: { type, message } });
};

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const parseOr = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 200_000);
  }
};

/** The prompt manifest the API sent: base64url JSON, an object; anything else is ignored (the trace still holds the full request). */
function decodeManifest(v: string | undefined): Record<string, unknown> | null {
  if (!v || v.length > MAX_MANIFEST_B64) return null;
  try {
    const j: unknown = JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const upstreamUrl = (base: string, path: string): string => `${base}${base.endsWith("/v1") && path.startsWith("/v1/") ? path.slice(3) : path}`;

export interface ServiceGatewayDeps {
  app: FastifyInstance;
  cfg: EdgeConfig;
  api: ApiClient;
  keys: VendorKeys;
  limiter: VendorLimiter;
  fetchImpl: typeof fetch;
  track: <T>(p: Promise<T>) => Promise<T>;
  store: ObjectStore;
  maxTraceBytes: number;
}

export interface ServiceMetrics {
  calls: number;
  refused: number;
  traceStored: number;
  traceDropped: number;
  usageReportFailures: number;
}

export function registerServiceRoutes(d: ServiceGatewayDeps): ServiceMetrics {
  const { app, cfg, api, keys, limiter } = d;
  const f = d.fetchImpl;
  const metrics: ServiceMetrics = { calls: 0, refused: 0, traceStored: 0, traceDropped: 0, usageReportFailures: 0 };

  const isCaller = (req: FastifyRequest): boolean => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
    return !!m && sameToken(m[1]!, cfg.edgeToken);
  };

  const authorize = async (purpose: string, pick: { model?: string; project?: string } = {}): Promise<{ ok: true; route: Route } | { ok: false; status: number; code: string; reason: string }> => {
    const r = await api.call("POST", "/internal/v1/service-calls/authorize", { purpose, ...(pick.model ? { model: pick.model } : {}), ...(pick.project ? { project: pick.project } : {}) });
    if (r.kind === "unavailable") return { ok: false, status: 503, code: "api_error", reason: "Gantry could not resolve a model route right now." };
    if (r.kind === "refused") return { ok: false, status: r.status === 409 ? 409 : 422, code: "no_model_configured", reason: String(r.body.msg ?? "No model is configured.") };
    if (r.body.allow === true) {
      const route = r.body.route as Route | undefined;
      if (route && typeof route.vendor === "string" && typeof route.baseUrl === "string" && typeof route.modelId === "string") return { ok: true, route };
      return { ok: false, status: 503, code: "api_error", reason: "The API allowed the call without a route." };
    }
    return { ok: false, status: 422, code: "no_model_configured", reason: String(r.body.reason ?? r.body.msg ?? "No model is configured.") };
  };

  app.get("/service/v1/trace/:ref", async (req, reply) => {
    if (!isCaller(req)) return reply.code(401).send({ ok: false, msg: "The edge token is required." });
    const ref = `sha256/${String((req.params as { ref?: string }).ref ?? "")}`;
    if (!/^sha256\/[0-9a-f]{64}$/.test(ref)) return reply.code(400).send({ ok: false, msg: "Not a trace reference." });
    let bytes: Buffer | null;
    try {
      bytes = await d.store.get(ref);
    } catch {
      return reply.code(503).send({ ok: false, msg: "The trace store is not reachable right now." });
    }
    if (!bytes) return reply.code(404).send({ ok: false, msg: "No such trace." });
    return reply.header("content-type", "application/json").header("cache-control", "no-store").send(bytes);
  });

  app.get("/service/v1/ready", async (req, reply) => {
    if (!isCaller(req)) return reply.code(401).send({ ok: false, msg: "The edge token is required." });
    const q = (req.query ?? {}) as { purpose?: string; model?: string; project?: string };
    const a = await authorize(q.purpose === "onboarding" ? "onboarding" : "console", q.purpose === "onboarding" ? {} : { ...(q.model ? { model: String(q.model) } : {}), ...(q.project ? { project: String(q.project) } : {}) });
    if (!a.ok) return { ready: false, code: a.code, reason: a.reason };
    const key = await keys.get(a.route.vendor);
    if (!key && !a.route.keyless) return { ready: false, code: "no_key", reason: `Vendor ${a.route.vendor} is connected but no API key is stored for it.`, vendor: a.route.vendor, model: a.route.modelId };
    return { ready: true, vendor: a.route.vendor, model: a.route.modelId };
  });

  const messages = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    if (!isCaller(req)) {
      metrics.refused++;
      return fail(reply, 401, "authentication_error", "The edge token is required.");
    }
    const purpose = String(req.headers["x-gantry-purpose"] ?? "");
    if (!PURPOSES.has(purpose)) return fail(reply, 400, "invalid_request_error", "x-gantry-purpose must be console, explain or onboarding.");
    let body: Record<string, unknown>;
    try {
      const j: unknown = JSON.parse((Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)).toString("utf8"));
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
      body = j as Record<string, unknown>;
    } catch {
      return fail(reply, 400, "invalid_request_error", "The request body must be a JSON object.");
    }
    const h = (n: string): string | undefined => (typeof req.headers[n] === "string" && req.headers[n] ? (req.headers[n] as string) : undefined);
    const auth = await authorize(purpose, { ...(h("x-gantry-model-pick") ? { model: h("x-gantry-model-pick")! } : {}), ...(h("x-gantry-project") ? { project: h("x-gantry-project")! } : {}) });
    if (!auth.ok) {
      metrics.refused++;
      return fail(reply, auth.status, auth.code, auth.reason);
    }
    const route = auth.route;
    const key = await keys.get(route.vendor);
    if (!key && !route.keyless) {
      metrics.refused++;
      return fail(reply, 422, "no_model_configured", `No API key is configured for vendor ${route.vendor}.`);
    }
    const slot = await limiter.acquire(route.vendor);
    if (!slot.ok) {
      metrics.refused++;
      return fail(reply, 429, "rate_limit_error", `Vendor ${route.vendor} is ${slot.reason === "cooldown" ? "rate limiting" : "busy"}; retry later.`, { "retry-after": String(slot.retryAfterSeconds) });
    }
    metrics.calls++;
    const started = Date.now();
    const ac = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) ac.abort();
    });
    const timer = setTimeout(() => ac.abort(), cfg.vendorTimeoutMs);
    const url = upstreamUrl(route.baseUrl, "/v1/messages");
    const headers: Record<string, string> = { "content-type": "application/json", "accept-encoding": "identity", "anthropic-version": "2023-06-01" };
    if (key) {
      headers["x-api-key"] = key;
      if (!/(^|\.)api\.anthropic\.com$/.test(new URL(url).hostname)) headers.authorization = `Bearer ${key}`;
    }
    const where: Record<string, string> = {
      // The scope the trace is read under: its own header, so naming a project for the trace never changes how the call is routed.
      ...(h("x-gantry-trace-project") ?? h("x-gantry-project") ? { project: (h("x-gantry-trace-project") ?? h("x-gantry-project"))! } : {}),
      ...(h("x-gantry-work-order") ? { woId: h("x-gantry-work-order")! } : {}),
      ...(h("x-gantry-actor") ? { actor: h("x-gantry-actor")! } : {}),
      ...(h("x-gantry-turn") ? { turn: h("x-gantry-turn")! } : {}),
      surface: SURFACES.has(h("x-gantry-surface") ?? "") ? h("x-gantry-surface")! : purpose,
    };
    const manifest = decodeManifest(h("x-gantry-manifest"));
    const sse = new SseUsage();
    const chunks: Buffer[] = [];
    let jsonUsage: Usage | undefined;
    let status = 0;
    let outcome: "ok" | "error" = "ok";
    let vendorRequestId: string | undefined;
    reply.hijack();
    try {
      const payload = JSON.stringify({ ...body, model: route.upstreamModel ?? route.modelId });
      // Connection-level failures are retried with backoff that rides out a short network drop (nothing has reached the caller yet: headers are only written after a response arrives). Never after a timeout or abort.
      const res = await fetchRiding(() => f(url, { method: "POST", headers, body: payload, signal: ac.signal, lan: route.lan } as RequestInit), ac.signal, (i) => req.log.warn({ purpose, ...i }, "service model call failed, retrying"));
      if (res.status === 429 || res.status === 529 || res.status === 503) {
        const ra = Number(res.headers.get("retry-after"));
        limiter.pause(route.vendor, Number.isFinite(ra) && ra > 0 ? ra : res.status === 429 ? 5 : 2);
      }
      status = res.status;
      vendorRequestId = res.headers.get("request-id") ?? res.headers.get("x-request-id") ?? undefined;
      const out: Record<string, string> = { "cache-control": "no-store", "x-gantry-model": route.modelId, "x-gantry-vendor": route.vendor };
      for (const h of ["content-type", "retry-after", "request-id"]) {
        const v = res.headers.get(h);
        if (v) out[h] = v;
      }
      reply.raw.writeHead(res.status, out);
      const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
      const dec = new TextDecoder();
      if (res.body) {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (!reply.raw.write(chunk)) await new Promise<void>((r) => reply.raw.once("drain", r));
          if (isSse) sse.push(dec.decode(chunk, { stream: true }));
          else if (chunks.length < 4096) chunks.push(Buffer.from(chunk));
        }
      }
      sse.end();
      reply.raw.end();
      if (!isSse) {
        try {
          jsonUsage = usageFromJson(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          /* a vendor error page: passed through, no usage */
        }
      }
      if (res.status >= 400) outcome = "error";
    } catch (e) {
      outcome = "error";
      req.log.warn({ purpose, ...causeOf(e) }, "service model call failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
        reply.raw.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "The model vendor could not be reached. This is usually temporary: try again." } }));
        status = 502;
      } else reply.raw.destroy();
    } finally {
      clearTimeout(timer);
      slot.release();
    }
    const usage: Usage = sse.usage.seen ? sse.usage : (jsonUsage ?? sse.usage);
    const requestId = vendorRequestId ?? sse.messageId ?? `edge-${randomUUID()}`;
    const traceRef = await captureTrace(req, { purpose, route, body, response: sse.usage.seen ? sse.message : parseOr(Buffer.concat(chunks).toString("utf8")), status, requestId, where, manifest });
    const rep = await api.call("POST", "/internal/v1/service-calls/usage", {
      purpose,
      requestId,
      ...(traceRef ? { traceRef } : {}),
      surface: where.surface,
      ...(where.project ? { project: where.project } : {}),
      ...(where.woId ? { woId: where.woId } : {}),
      ...(where.actor ? { actor: where.actor } : {}),
      ...(where.turn ? { turn: where.turn } : {}),
      ...(manifest && typeof manifest.hash === "string" ? { promptHash: manifest.hash } : {}),
      model: route.modelId,
      vendor: route.vendor,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      latencyMs: Date.now() - started,
      outcome: outcome === "ok" && status < 400 ? "ok" : "error",
    });
    if (rep.kind !== "ok") {
      metrics.usageReportFailures++;
      req.log.error({ purpose, kind: rep.kind }, "service-call usage report failed");
    }
  };
  /** Scan, then store as sha256/<hash>: the same path as a run's trace. Degrades to no reference when the store is down; never stores unscanned content. */
  async function captureTrace(req: FastifyRequest, t: { purpose: string; route: Route; body: Record<string, unknown>; response: unknown; status: number; requestId: string; where: Record<string, string>; manifest: Record<string, unknown> | null }): Promise<string | undefined> {
    try {
      const record = { v: 1, kind: "service-call", purpose: t.purpose, requestId: t.requestId, vendor: t.route.vendor, model: t.route.modelId, status: t.status, ...t.where, manifest: t.manifest, request: t.body, response: t.response };
      const scanned = scanJson(record, d.keys.knownKeys());
      const text = JSON.stringify({ ...(scanned.value as Record<string, unknown>), redactions: scanned.findings });
      if (Buffer.byteLength(text) > d.maxTraceBytes) throw new Error("trace exceeds the size limit");
      const ref = await d.store.put(text, "application/json");
      metrics.traceStored++;
      if (scanned.findings.length) req.log.warn({ purpose: t.purpose, findings: scanned.findings as Finding[] }, "secrets redacted from service-call trace");
      return ref;
    } catch (e) {
      metrics.traceDropped++;
      req.log.error({ purpose: t.purpose, err: e instanceof Error ? e.message : String(e) }, "service-call trace not stored (degraded: the call proceeded without a trace reference)");
      return undefined;
    }
  }
  app.post("/service/v1/messages", (req, reply) => d.track(messages(req, reply)));
  return metrics;
}
