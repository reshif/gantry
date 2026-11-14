import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, runIdOfToken, type Gateway } from "../src/gateway.js";
import { S3ObjectStore } from "../src/trace.js";
import { baseConfig, close, FakeApi, FakeS3, FakeVendor, makeToken } from "./helpers.js";

describe("model gateway and run calls", () => {
  const api = new FakeApi();
  const vendor = new FakeVendor();
  const s3 = new FakeS3();
  let gw: Gateway;
  let base = "";
  const RUN = "run-w3-1";
  const TOKEN = makeToken(RUN);

  const msg = (body: unknown, token: string | null = TOKEN, headers: Record<string, string> = {}) =>
    fetch(`${base}/model/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
  const run = (method: "GET" | "POST", path: string, body?: unknown, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}`, "x-gantry-run-id": RUN } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const objectText = (ref: string): string => s3.objects.get(`/gantry-test/${ref}`)!.toString("utf8");
  const settle = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  beforeAll(async () => {
    await Promise.all([api.start(), vendor.start(), s3.start()]);
    api.route.baseUrl = vendor.url;
    const cfg = baseConfig({ apiUrl: api.url });
    gw = buildGateway({ cfg, store: new S3ObjectStore({ endpoint: s3.url, bucket: "gantry-test", accessKey: "k", secretKey: "s", region: "us-east-1" }), logger: false });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await Promise.all([close(api.server), close(vendor.server), close(s3.server)]);
  });
  beforeEach(async () => {
    await gw.drain();
    api.calls = [];
    api.allow = true;
    api.down = false;
    api.override = undefined;
    vendor.calls = [];
    vendor.force = [];
    vendor.delayMs = 0;
    delete vendor.leakKey;
    s3.down = false;
    gw.limiter.clearCooldown("w3-anthropic");
  });

  it("parses the run id out of a run token", () => {
    expect(runIdOfToken(TOKEN)).toBe(RUN);
    expect(runIdOfToken("grt.bad")).toBeNull();
    expect(runIdOfToken("nonsense")).toBeNull();
  });

  describe("streaming passthrough", () => {
    it("authorizes, injects the vendor key, streams SSE through, reports usage and a trace reference", async () => {
      const res = await msg({ model: "claude-test-1", stream: true, max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: message_start");
      expect(text).toContain("message_stop");
      // The vendor saw the injected key, never the run token.
      const seen = vendor.calls[0]!;
      expect(seen.url).toBe("/v1/messages");
      expect(seen.headers["x-api-key"]).toBe("sk-ant-test-vendor-key-0123456789abcdef");
      expect(String(seen.headers.authorization ?? "")).not.toContain("grt.");
      expect(JSON.stringify(seen.headers)).not.toContain(TOKEN);
      // Authorize came first, with the run token and requested model.
      const auth = api.of("/authorize")[0]!;
      expect(auth.url).toBe(`/internal/v1/runs/${RUN}/authorize`);
      expect(JSON.parse(auth.body)).toEqual({ token: TOKEN, model: "claude-test-1" });
      await settle(() => api.of("/usage").length > 0);
      const u = JSON.parse(api.of("/usage")[0]!.body);
      expect(u).toMatchObject({ token: TOKEN, requestId: "req_vendor_1", model: "claude-test-1", vendor: "w3-anthropic", inputTokens: 25, outputTokens: 42, cacheReadTokens: 100, cacheWriteTokens: 7, outcome: "ok" });
      expect(u.latencyMs).toBeGreaterThanOrEqual(0);
      expect(u.traceRef).toMatch(/^sha256\/[0-9a-f]{64}$/);
      const trace = JSON.parse(objectText(u.traceRef));
      expect(trace.response.content[0].text).toBe("Hello world");
      expect(trace.request.messages).toEqual([{ role: "user", content: "hi" }]);
    });

    it("relays a non-streaming call and its usage", async () => {
      const res = await msg({ model: "claude-test-1", max_tokens: 10, messages: [{ role: "user", content: "x" }] }, TOKEN, { "x-api-key": "ignored" });
      expect(res.status).toBe(200);
      expect((await res.json()).content[0].text).toBe("Hello world");
      await settle(() => api.of("/usage").length > 0);
      expect(JSON.parse(api.of("/usage")[0]!.body)).toMatchObject({ requestId: "req_vendor_2", inputTokens: 11, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 });
    });

    it("accepts the run token as x-api-key too", async () => {
      const res = await fetch(`${base}/model/v1/messages`, { method: "POST", headers: { "x-api-key": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-test-1", messages: [] }) });
      expect(res.status).toBe(200);
      await res.text();
    });

    it("stores trace increments: the second call carries only the new messages", async () => {
      const run2 = makeToken("run-w3-inc");
      const m1 = { role: "user", content: "one" };
      const m2 = { role: "assistant", content: "two" };
      const m3 = { role: "user", content: "three" };
      await (await msg({ model: "claude-test-1", system: "sys", messages: [m1] }, run2)).text();
      await (await msg({ model: "claude-test-1", system: "sys", messages: [m1, m2, m3] }, run2)).text();
      await settle(() => api.of("/usage").length >= 2);
      const refs = api.of("/usage").map((c) => JSON.parse(c.body).traceRef as string);
      const [t1, t2] = refs.map((r) => JSON.parse(objectText(r)));
      expect(t1.request.messages).toHaveLength(1);
      expect(t1.request.system).toBe("sys");
      expect(t2.request.messagesFrom).toBe(1);
      expect(t2.request.messages).toEqual([m2, m3]);
      expect(t2.request.system).toBeUndefined();
    });
  });

  describe("refusals", () => {
    it("T7: refuses after a stop, with the stop reason, and never calls the vendor", async () => {
      api.allow = false;
      api.denial = { code: "stopped", reason: "Halted at wo scope: runaway cost." };
      const res = await msg({ model: "claude-test-1", messages: [] });
      expect(res.status).toBe(403);
      const j = await res.json();
      expect(j).toEqual({ type: "error", error: { type: "permission_error", message: "Halted at wo scope: runaway cost." } });
      expect(res.headers.get("x-gantry-denial")).toBe("stopped");
      expect(vendor.calls).toHaveLength(0);
      expect(api.of("/usage")).toHaveLength(0);
    });

    it("refuses on a spent budget (403) and on a model the run is not pinned to (400)", async () => {
      api.allow = false;
      api.denial = { code: "budget", reason: "The work order budget is spent ($5.00 of $5.00)." };
      expect((await msg({ model: "claude-test-1", messages: [] })).status).toBe(403);
      api.denial = { code: "route", reason: "This run is pinned to model claude-test-1; other is not allowed." };
      const r = await msg({ model: "other", messages: [] });
      expect(r.status).toBe(400);
      expect((await r.json()).error.type).toBe("invalid_request_error");
      expect(vendor.calls).toHaveLength(0);
    });

    it("passes an API refusal status (409 stop on a thrown refusal) as a denial", async () => {
      api.override = () => [409, { ok: false, msg: "Killed at factory scope." }];
      const res = await msg({ model: "claude-test-1", messages: [] });
      expect(res.status).toBe(403);
      expect(vendor.calls).toHaveLength(0);
    });

    it("fails closed when the API is unreachable, errors, or answers without a decision", async () => {
      api.down = true;
      const down = await msg({ model: "claude-test-1", messages: [] });
      expect(down.status).toBe(503);
      expect(down.headers.get("retry-after")).toBe("5");
      api.down = false;
      api.override = () => [500, { ok: false }];
      expect((await msg({ model: "claude-test-1", messages: [] })).status).toBe(503);
      api.override = () => [200, { ok: true, msg: "?" }];
      expect((await msg({ model: "claude-test-1", messages: [] })).status).toBe(503);
      api.override = () => [401, { ok: false }]; // the edge's own token rejected: still no model call
      expect((await msg({ model: "claude-test-1", messages: [] })).status).toBe(503);
      expect(vendor.calls).toHaveLength(0);
      expect(gw.metrics.refused).toBeGreaterThan(0);
    });

    it("refuses requests without a usable run token before asking the API", async () => {
      expect((await msg({ model: "x", messages: [] }, null)).status).toBe(401);
      expect((await msg({ model: "x", messages: [] }, "sk-ant-not-a-run-token")).status).toBe(401);
      expect(api.calls).toHaveLength(0);
    });

    it("rejects a malformed body and unknown model paths", async () => {
      const bad = await fetch(`${base}/model/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{nope" });
      expect(bad.status).toBe(400);
      expect((await fetch(`${base}/model/v1/complete`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    });

    it("refuses when no key exists for the routed vendor", async () => {
      api.route = { ...api.route, vendor: "w3-nokey" };
      try {
        const res = await msg({ model: "claude-test-1", messages: [] });
        expect(res.status).toBe(503);
        expect(vendor.calls).toHaveLength(0);
      } finally {
        api.route = { ...api.route, vendor: "w3-anthropic" };
      }
    });

    it("fetches a user-entered vendor key from the API when it is not in vendor_keys.json", async () => {
      api.route = { ...api.route, vendor: "w3-entered" };
      api.override = (r) => (r.url.includes("/vendors/w3-entered/key") ? [200, { ok: true, key: "sk-ant-entered-in-product-9999999999" }] : undefined);
      try {
        const res = await msg({ model: "claude-test-1", messages: [] });
        expect(res.status).toBe(200);
        await res.text();
        expect(vendor.calls[0]!.headers["x-api-key"]).toBe("sk-ant-entered-in-product-9999999999");
        expect(gw.keys.knownKeys()).toContain("sk-ant-entered-in-product-9999999999");
      } finally {
        api.route = { ...api.route, vendor: "w3-anthropic" };
      }
    });
  });

  describe("vendor signals and concurrency", () => {
    it("passes a vendor 429 and its Retry-After through, records the error, and cools the vendor down", async () => {
      vendor.force.push({ status: 429, headers: { "retry-after": "2" } });
      const res = await msg({ model: "claude-test-1", messages: [] });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("2");
      await settle(() => api.of("/usage").length > 0);
      expect(JSON.parse(api.of("/usage")[0]!.body)).toMatchObject({ outcome: "error", inputTokens: 0 });
      // The cooldown (2s) is longer than the wait budget (0.5s): the next call is refused with the remaining time and never reaches the vendor.
      const next = await msg({ model: "claude-test-1", messages: [] });
      expect(next.status).toBe(429);
      expect(Number(next.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(vendor.calls).toHaveLength(1);
    });

    it("caps in-flight calls per vendor and queues the rest", async () => {
      vendor.delayMs = 80;
      const results = await Promise.all(Array.from({ length: 10 }, () => msg({ model: "claude-test-1", messages: [] }).then(async (r) => { await r.text(); return r.status; })));
      expect(results.every((s) => s === 200)).toBe(true);
      expect(vendor.maxActive).toBeLessThanOrEqual(4);
      expect(vendor.maxActive).toBeGreaterThan(1);
    });

    it("answers 502 when the vendor is unreachable", async () => {
      api.route = { ...api.route, baseUrl: "http://127.0.0.1:1" };
      try {
        const res = await msg({ model: "claude-test-1", messages: [] });
        expect(res.status).toBe(502);
      } finally {
        api.route = { ...api.route, baseUrl: vendor.url };
      }
    });
  });

  describe("secret scanning and trace storage", () => {
    it("redacts a vendor key a model echoes, even when a stream splits it across deltas", async () => {
      vendor.leakKey = "sk-ant-test-vendor-key-0123456789abcdef";
      const res = await msg({ model: "claude-test-1", stream: true, messages: [{ role: "user", content: "token " + "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789 here" }] });
      await res.text();
      await settle(() => api.of("/usage").length > 0);
      const ref = JSON.parse(api.of("/usage")[0]!.body).traceRef as string;
      const stored = objectText(ref);
      expect(stored).not.toContain("sk-ant-test-vendor-key");
      expect(stored).not.toContain("ghp_abcdef");
      expect(stored).toContain("[REDACTED:known-key]");
      expect(stored).toContain("[REDACTED:github-token]");
      expect(JSON.parse(stored).redactions.length).toBeGreaterThan(0);
    });

    it("DEGRADES when object storage is down: the call still works, usage carries no trace reference, the drop is counted", async () => {
      s3.down = true;
      const before = gw.metrics.traceDropped;
      const res = await msg({ model: "claude-test-1", messages: [{ role: "user", content: "x" }] });
      expect(res.status).toBe(200);
      await res.text();
      await settle(() => api.of("/usage").length > 0);
      const u = JSON.parse(api.of("/usage")[0]!.body);
      expect(u.traceRef).toBeUndefined();
      expect(u.inputTokens).toBe(11);
      expect(gw.metrics.traceDropped).toBe(before + 1);
    });
  });

  describe("run control calls (runner wrapper contract)", () => {
    it("GET /run/v1/spec relays the API spec with the run token", async () => {
      const res = await run("GET", "/run/v1/spec");
      expect(res.status).toBe(200);
      expect((await res.json()).adapter).toBe("stub");
      const c = api.of("/spec")[0]!;
      expect(c.url).toBe(`/internal/v1/runs/${RUN}/spec`);
      expect(c.headers["x-run-token"]).toBe(TOKEN);
      expect(c.headers.authorization).toBe("Bearer edge-token-for-tests");
    });

    it("refuses a missing token and a run id header that does not match the token", async () => {
      expect((await run("GET", "/run/v1/spec", undefined, null)).status).toBe(401);
      const res = await fetch(`${base}/run/v1/spec`, { headers: { authorization: `Bearer ${TOKEN}`, "x-gantry-run-id": "someone-else" } });
      expect(res.status).toBe(401);
      expect(api.calls).toHaveLength(0);
    });

    it("heartbeat is relayed with the token, and the runner's own token field cannot override it", async () => {
      const res = await run("POST", "/run/v1/heartbeat", { runId: RUN, at: "t", seq: 3, phase: "working", turn: 2, token: "grt.forged.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
      expect(res.status).toBe(200);
      expect(JSON.parse(api.of("/heartbeat")[0]!.body)).toEqual({ seq: 3, phase: "working", turn: 2, token: TOKEN });
    });

    it("relays a stop refusal (409) so the runner stops, and an unavailable API as 503", async () => {
      api.override = () => [409, { ok: false, msg: "Killed at wo scope." }];
      const r = await run("POST", "/run/v1/heartbeat", { seq: 1, phase: "working" });
      expect(r.status).toBe(409);
      expect((await r.json()).msg).toContain("Killed");
      api.override = undefined;
      api.down = true;
      expect((await run("POST", "/run/v1/heartbeat", { seq: 1, phase: "working" })).status).toBe(503);
    });

    it("checkpoint: scans, stores content by hash, and sends only the reference to the API", async () => {
      const res = await run("POST", "/run/v1/checkpoint", { runId: RUN, at: "t", turn: 2, kind: "artefact", name: "notes.md", contentType: "text/markdown", content: "deploy with " + "AKIA" + "ABCDEFGHIJKLMNOP now" });
      expect(res.status).toBe(200);
      const sent = JSON.parse(api.of("/checkpoint")[0]!.body);
      expect(sent).toMatchObject({ token: TOKEN, turn: 2, kind: "artefact", name: "notes.md", contentType: "text/markdown" });
      expect(sent.content).toBeUndefined();
      expect(sent.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const stored = objectText(`sha256/${sent.contentHash}`);
      expect(stored).toBe("deploy with [REDACTED:aws-access-key] now");
      expect(sent.size).toBe(Buffer.byteLength(stored));
    });

    it("checkpoint FAILS CLOSED (503) when object storage is down: nothing is recorded", async () => {
      s3.down = true;
      const res = await run("POST", "/run/v1/checkpoint", { turn: 1, kind: "transcript", name: "t", contentType: "text/plain", content: "x" });
      expect(res.status).toBe(503);
      expect(api.of("/checkpoint")).toHaveLength(0);
    });

    it("checkpoint rejects a malformed body with 422", async () => {
      expect((await run("POST", "/run/v1/checkpoint", { turn: -1 })).status).toBe(422);
    });

    it("result: redacts secrets in the output and relays", async () => {
      const res = await run("POST", "/run/v1/result", { runId: RUN, at: "t", status: "succeeded", output: { summary: "used key sk-ant-test-vendor-key-0123456789abcdef" }, usage: [], adapter: "stub", capabilities: {} });
      expect(res.status).toBe(200);
      const sent = JSON.parse(api.of("/result")[0]!.body);
      expect(sent.token).toBe(TOKEN);
      expect(sent.output.summary).toBe("used key [REDACTED:known-key]");
      expect(sent.runId).toBeUndefined();
    });

    it("the MCP endpoint wants a run token (the gateway itself is covered in mcp.test.ts)", async () => {
      expect((await fetch(`${base}/mcp/v1/x`, { method: "POST" })).status).toBe(401);
    });

    it("serves /healthz", async () => {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });
  });
});
