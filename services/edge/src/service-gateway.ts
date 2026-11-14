import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiClient, Route } from "./api.js";
import type { EdgeConfig } from "./config.js";
import type { VendorLimiter } from "./limiter.js";
import { SseUsage, usageFromJson, type Usage } from "./usage.js";
import type { VendorKeys } from "./vendor-keys.js";

/**
 * Model calls that belong to no run (spec 12.6): the console and "explain why not" call a model through the edge like a run does, so the
 * vendor keys stay here. The caller is the API itself, authenticated with the edge token (a run token is not accepted on this path, and the
 * edge token is not accepted on /model). The API decides the route (`/internal/v1/service-calls/authorize`) and meters the call
 * (`/usage`); the edge holds the key, the vendor concurrency slot and the stream.
 *
 *   POST /service/v1/messages   a Messages API body; `x-gantry-purpose: console|explain|onboarding`. `model` is ignored: routing picks it, or the API's validated choice in `x-gantry-model-pick` (+ `x-gantry-project`) does.
 *   GET  /service/v1/ready      { ready, reason?, vendor?, model? }: can a call be made right now (a route exists and its key is present)
 */

const PURPOSES = new Set(["console", "explain", "onboarding"]);

const fail = (reply: FastifyReply, status: number, type: string, message: string, extra: Record<string, string> = {}): FastifyReply => {
  for (const [k, v] of Object.entries(extra)) reply.header(k, v);
  return reply.code(status).header("content-type", "application/json").send({ type: "error", error: { type, message } });
};

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const upstreamUrl = (base: string, path: string): string => `${base}${base.endsWith("/v1") && path.startsWith("/v1/") ? path.slice(3) : path}`;

export interface ServiceGatewayDeps {
  app: FastifyInstance;
  cfg: EdgeConfig;
  api: ApiClient;
  keys: VendorKeys;
  limiter: VendorLimiter;
  fetchImpl: typeof fetch;
  track: <T>(p: Promise<T>) => Promise<T>;
}

export interface ServiceMetrics {
  calls: number;
  refused: number;
  usageReportFailures: number;
}

export function registerServiceRoutes(d: ServiceGatewayDeps): ServiceMetrics {
  const { app, cfg, api, keys, limiter } = d;
  const f = d.fetchImpl;
  const metrics: ServiceMetrics = { calls: 0, refused: 0, usageReportFailures: 0 };

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
    const sse = new SseUsage();
    const chunks: Buffer[] = [];
    let jsonUsage: Usage | undefined;
    let status = 0;
    let outcome: "ok" | "error" = "ok";
    let vendorRequestId: string | undefined;
    reply.hijack();
    try {
      const payload = JSON.stringify({ ...body, model: route.upstreamModel ?? route.modelId });
      // One retry for a connection-level failure (nothing has reached the caller yet: headers are only written after a response arrives). Never after a timeout or abort.
      const res = await f(url, { method: "POST", headers, body: payload, signal: ac.signal }).catch(async (e: unknown) => {
        if (ac.signal.aborted) throw e;
        req.log.warn({ purpose, err: e instanceof Error ? e.message : String(e) }, "service model call failed, retrying once");
        await new Promise((r) => setTimeout(r, 400));
        return f(url, { method: "POST", headers, body: payload, signal: ac.signal });
      });
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
      req.log.warn({ purpose, err: e instanceof Error ? e.message : String(e) }, "service model call failed");
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
    const rep = await api.call("POST", "/internal/v1/service-calls/usage", {
      purpose,
      requestId: vendorRequestId ?? sse.messageId ?? `edge-${randomUUID()}`,
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
  app.post("/service/v1/messages", (req, reply) => d.track(messages(req, reply)));
  return metrics;
}
