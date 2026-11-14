import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, type Gateway } from "../src/gateway.js";
import { baseConfig, close, FakeApi, FakeVendor, makeToken } from "./helpers.js";

describe("service model calls (console, spec 12.6)", () => {
  const api = new FakeApi();
  const vendor = new FakeVendor();
  let gw: Gateway;
  let base = "";
  const EDGE = "edge-token-for-tests";
  const call = (body: unknown, o: { token?: string | null; purpose?: string | null } = {}) =>
    fetch(`${base}/service/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? EDGE}` }), ...(o.purpose === null ? {} : { "x-gantry-purpose": o.purpose ?? "console" }) },
      body: JSON.stringify(body),
    });
  const settle = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  beforeAll(async () => {
    await Promise.all([api.start(), vendor.start()]);
    api.route.baseUrl = vendor.url;
    gw = buildGateway({ cfg: baseConfig({ apiUrl: api.url }), logger: false });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await Promise.all([close(api.server), close(vendor.server)]);
  });
  beforeEach(async () => {
    await gw.drain();
    api.calls = [];
    api.override = undefined;
    api.down = false;
    vendor.calls = [];
    vendor.force = [];
    gw.limiter.clearCooldown("w3-anthropic");
  });

  it("refuses a caller that is not the API: no token, a run token, the wrong token, no purpose", async () => {
    expect((await call({ messages: [] }, { token: null })).status).toBe(401);
    expect((await call({ messages: [] }, { token: makeToken("run-1") })).status).toBe(401);
    expect((await call({ messages: [] }, { token: "nope" })).status).toBe(401);
    expect((await call({ messages: [] }, { purpose: null })).status).toBe(400);
    expect((await call({ messages: [] }, { purpose: "other" })).status).toBe(400);
    expect(vendor.calls).toHaveLength(0);
    // And the edge token is not a run token on /model.
    const m = await fetch(`${base}/model/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${EDGE}`, "content-type": "application/json" }, body: "{}" });
    expect(m.status).toBe(401);
  });

  it("asks the API for the route, injects the vendor key, streams the answer and reports metered usage", async () => {
    const res = await call({ model: "console", stream: true, max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gantry-model")).toBe("claude-test-1");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    const seen = vendor.calls[0]!;
    expect(seen.headers["x-api-key"]).toBe("sk-ant-test-vendor-key-0123456789abcdef");
    // routing, not the caller, picks the model
    expect(JSON.parse(seen.body).model).toBe("claude-test-1");
    expect(JSON.parse(api.of("/authorize")[0]!.body)).toEqual({ purpose: "console" });
    expect(api.of("/authorize")[0]!.url).toBe("/internal/v1/service-calls/authorize");
    await settle(() => api.of("/usage").length > 0);
    const u = api.of("/usage")[0]!;
    expect(u.url).toBe("/internal/v1/service-calls/usage");
    expect(JSON.parse(u.body)).toMatchObject({ purpose: "console", model: "claude-test-1", vendor: "w3-anthropic", inputTokens: 25, outputTokens: 42, outcome: "ok" });
  });

  it("answers a non-streaming call and meters it", async () => {
    const res = await call({ max_tokens: 50, messages: [{ role: "user", content: "hi" }] }, { purpose: "explain" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: Array<{ text: string }> }).content[0]!.text).toBe("Hello world");
    await settle(() => api.of("/usage").length > 0);
    expect(JSON.parse(api.of("/usage")[0]!.body)).toMatchObject({ purpose: "explain", inputTokens: 11, outputTokens: 5 });
  });

  it("retries a connection-level vendor failure once, then says the vendor is unreachable", async () => {
    for (const failures of [1, 2]) {
      let n = 0;
      const flaky: typeof fetch = (i, init) => (++n <= failures ? Promise.reject(new TypeError("fetch failed")) : fetch(i, init));
      const g2 = buildGateway({ cfg: baseConfig({ apiUrl: api.url }), logger: false, fetchImpl: flaky });
      await g2.app.listen({ host: "127.0.0.1", port: 0 });
      const b2 = `http://127.0.0.1:${(g2.app.server.address() as { port: number }).port}`;
      const res = await fetch(`${b2}/service/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${EDGE}`, "x-gantry-purpose": "console" }, body: JSON.stringify({ max_tokens: 50, messages: [{ role: "user", content: "hi" }] }) });
      if (failures === 1) { expect(res.status).toBe(200); expect(n).toBe(2); }
      else { expect(res.status).toBe(502); expect(n).toBe(2); expect(JSON.stringify(await res.json())).toContain("could not be reached"); }
      await g2.drain();
      await g2.app.close();
    }
  });

  it("says so when no model is configured, and calls no vendor", async () => {
    api.override = (r) => (r.url.endsWith("/service-calls/authorize") ? [200, { ok: true, allow: false, code: "route", reason: "No vendor is connected for the default model." }] : undefined);
    const res = await call({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "no_model_configured", message: "No vendor is connected for the default model." } });
    expect(vendor.calls).toHaveLength(0);
    const ready = await fetch(`${base}/service/v1/ready`, { headers: { authorization: `Bearer ${EDGE}` } });
    expect(await ready.json()).toMatchObject({ ready: false, code: "no_model_configured" });
  });

  it("is not ready when the routed vendor has no key, and fails closed when the API is down", async () => {
    api.route = { vendor: "no-key-vendor", baseUrl: vendor.url, modelId: "claude-test-1" };
    try {
      const ready = await fetch(`${base}/service/v1/ready`, { headers: { authorization: `Bearer ${EDGE}` } });
      expect(await ready.json()).toMatchObject({ ready: false, code: "no_key", vendor: "no-key-vendor" });
      expect((await call({ messages: [] })).status).toBe(422);
    } finally {
      api.route = { vendor: "w3-anthropic", baseUrl: vendor.url, modelId: "claude-test-1" };
    }
    api.down = true;
    expect((await call({ messages: [] })).status).toBe(503);
    expect(vendor.calls).toHaveLength(0);
  });

  it("ready needs the edge token and reports the model when a call can be made", async () => {
    expect((await fetch(`${base}/service/v1/ready`)).status).toBe(401);
    const r = await fetch(`${base}/service/v1/ready`, { headers: { authorization: `Bearer ${EDGE}` } });
    expect(await r.json()).toEqual({ ready: true, vendor: "w3-anthropic", model: "claude-test-1" });
  });
});
