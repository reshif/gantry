import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, type Gateway } from "../src/gateway.js";
import { baseConfig, close, FakeApi, FakeVendor, makeToken } from "./helpers.js";

/** Spec 10.4 Fallback: the same model on another allowed vendor at a turn boundary; a different model only when the API listed it (project opt-in). */
describe("model fallback at the edge", () => {
  const api = new FakeApi();
  const primary = new FakeVendor();
  const second = new FakeVendor();
  const keyless = new FakeVendor();
  let gw: Gateway;
  let base = "";
  const RUN = "run-mdl-fb";
  const TOKEN = makeToken(RUN);
  const msg = (body: unknown) => fetch(`${base}/model/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  const settle = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  const route = (o: object = {}) => ({ vendor: "fb-one", baseUrl: primary.url, modelId: "claude-test-1", upstreamModel: "claude-test-1", ...o });
  const alt = (o: object = {}) => ({ vendor: "fb-two", baseUrl: second.url, modelId: "two-claude-test-1", upstreamModel: "vendor-two/claude-test-1", crossModel: false, ...o });

  beforeAll(async () => {
    await Promise.all([api.start(), primary.start(), second.start(), keyless.start()]);
    gw = buildGateway({ cfg: baseConfig({ apiUrl: api.url, vendorKeys: { "fb-one": "key-one-0123456789", "fb-two": "key-two-0123456789" } }), logger: false });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(gw.app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await gw.app.close();
    await Promise.all([close(api.server), close(primary.server), close(second.server), close(keyless.server)]);
  });
  beforeEach(async () => {
    await gw.drain();
    api.calls = [];
    api.allow = true;
    for (const v of [primary, second, keyless]) {
      v.calls = [];
      v.force = [];
    }
    gw.limiter.clearCooldown("fb-one");
    gw.limiter.clearCooldown("fb-two");
  });

  it("serves the call from the same model on the other vendor when the first one fails, with its own key and model id, and reports the fallback", async () => {
    api.route = route({ alternates: [alt()] }) as typeof api.route;
    primary.force.push({ status: 503 });
    const res = await msg({ model: "claude-test-1", messages: [] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: Array<{ text: string }> }).content[0]!.text).toBe("Hello world");
    expect(primary.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.headers["x-api-key"]).toBe("key-two-0123456789");
    expect(JSON.parse(second.calls[0]!.body).model).toBe("vendor-two/claude-test-1");
    expect(JSON.parse(primary.calls[0]!.body).model).toBe("claude-test-1");
    await settle(() => api.of("/usage").length > 0);
    expect(JSON.parse(api.of("/usage")[0]!.body)).toMatchObject({ vendor: "fb-two", model: "two-claude-test-1", fallback: "same_model", wanted: "claude-test-1", outcome: "ok" });
    expect(gw.metrics.fallbacks).toBeGreaterThanOrEqual(1);
  });

  it("falls back when the first vendor cannot be reached", async () => {
    api.route = route({ baseUrl: "http://127.0.0.1:1", alternates: [alt()] }) as typeof api.route;
    const res = await msg({ model: "claude-test-1", messages: [] });
    expect(res.status).toBe(200);
    await res.text();
    expect(second.calls).toHaveLength(1);
  });

  it("rides out a short drop on the run path: the connection fails twice, then the one vendor answers once", async () => {
    let n = 0;
    const flaky: typeof fetch = (i, init) => (++n <= 2 ? Promise.reject(new TypeError("fetch failed")) : fetch(i, init));
    const g2 = buildGateway({ cfg: baseConfig({ apiUrl: api.url, vendorKeys: { "fb-one": "key-one-0123456789" } }), logger: false, fetchImpl: flaky });
    await g2.app.listen({ host: "127.0.0.1", port: 0 });
    api.route = route() as typeof api.route;
    const res = await fetch(`http://127.0.0.1:${(g2.app.server.address() as { port: number }).port}/model/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ model: "claude-test-1", messages: [] }) });
    expect(res.status).toBe(200);
    await res.text();
    expect(n).toBe(3);
    expect(primary.calls).toHaveLength(1);
    await g2.drain();
    await g2.app.close();
  }, 20_000);

  it("with a fallback configured a dropped primary gets one short retry (2 attempts), then the fallback answers once, and both slots are released (statechart edge-blips)", async () => {
    const seen: string[] = [];
    const down: typeof fetch = (i, init) => {
      if (String(i).startsWith(primary.url)) { seen.push("primary"); return Promise.reject(new TypeError("fetch failed")); }
      return fetch(i, init);
    };
    const g2 = buildGateway({ cfg: baseConfig({ apiUrl: api.url, vendorKeys: { "fb-one": "key-one-0123456789", "fb-two": "key-two-0123456789" } }), logger: false, fetchImpl: down });
    await g2.app.listen({ host: "127.0.0.1", port: 0 });
    api.route = route({ alternates: [alt()] }) as typeof api.route;
    const res = await fetch(`http://127.0.0.1:${(g2.app.server.address() as { port: number }).port}/model/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ model: "claude-test-1", messages: [] }) });
    expect(res.status).toBe(200);
    await res.text();
    expect(seen).toHaveLength(2);
    expect(second.calls).toHaveLength(1);
    await g2.drain();
    expect(g2.limiter.inflight("fb-one")).toBe(0);
    expect(g2.limiter.inflight("fb-two")).toBe(0);
    await g2.app.close();
  }, 20_000);

  it("does not fall back on a request error: a 400 is passed through", async () => {
    api.route = route({ alternates: [alt()] }) as typeof api.route;
    primary.force.push({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } });
    const res = await msg({ model: "claude-test-1", messages: [] });
    expect(res.status).toBe(400);
    await res.text();
    expect(second.calls).toHaveLength(0);
  });

  it("flags a different model as a cross-model fallback", async () => {
    api.route = route({ alternates: [alt({ modelId: "other-model", upstreamModel: "other-model", crossModel: true })] }) as typeof api.route;
    primary.force.push({ status: 529 });
    const res = await msg({ model: "claude-test-1", messages: [] });
    expect(res.status).toBe(200);
    await res.text();
    await settle(() => api.of("/usage").length > 0);
    expect(JSON.parse(api.of("/usage")[0]!.body)).toMatchObject({ model: "other-model", fallback: "cross_model", wanted: "claude-test-1" });
  });

  it("returns the last vendor's answer when every vendor fails, and never tries a vendor with no key", async () => {
    api.route = route({ alternates: [alt({ vendor: "fb-nokey", baseUrl: keyless.url }), alt()] }) as typeof api.route;
    primary.force.push({ status: 503 });
    second.force.push({ status: 500 });
    const res = await msg({ model: "claude-test-1", messages: [] });
    expect(res.status).toBe(500);
    await res.text();
    expect(keyless.calls).toHaveLength(0);
  });

  it("rewrites the model for a routed primary (residency vendor) and sends no key to a keyless endpoint", async () => {
    api.route = route({ vendor: "fb-local", baseUrl: keyless.url, modelId: "local-claude", upstreamModel: "local/claude", keyless: true }) as typeof api.route;
    const res = await msg({ model: "claude-test-1", messages: [] });
    expect(res.status).toBe(200);
    await res.text();
    expect(JSON.parse(keyless.calls[0]!.body).model).toBe("local/claude");
    expect(keyless.calls[0]!.headers["x-api-key"]).toBeUndefined();
    expect(keyless.calls[0]!.headers.authorization).toBeUndefined();
    await settle(() => api.of("/usage").length > 0);
    expect(JSON.parse(api.of("/usage")[0]!.body).fallback).toBeUndefined();
  });

  it("refuses a vendor with no key and no keyless flag, as before", async () => {
    api.route = route({ vendor: "fb-missing" }) as typeof api.route;
    const res = await msg({ model: "claude-test-1", messages: [] });
    expect(res.status).toBe(503);
    await res.text();
  });
});
