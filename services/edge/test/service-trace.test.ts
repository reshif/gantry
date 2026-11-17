import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, type Gateway } from "../src/gateway.js";
import { sha256, type ObjectStore } from "../src/trace.js";
import { baseConfig, close, FakeApi, FakeVendor, makeToken } from "./helpers.js";

class MemStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  failPut = false;
  async put(content: Buffer | string): Promise<string> {
    if (this.failPut) throw new Error("store down");
    const b = typeof content === "string" ? Buffer.from(content) : content;
    const key = `sha256/${sha256(b)}`;
    this.objects.set(key, b);
    return key;
  }
  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }
}

describe("service gateway traces the prompt of every conversational call", () => {
  const api = new FakeApi();
  const vendor = new FakeVendor();
  const store = new MemStore();
  let gw: Gateway;
  let base = "";
  const EDGE = "edge-token-for-tests";
  const manifest = (m: unknown): string => Buffer.from(JSON.stringify(m)).toString("base64url");
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/service/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${EDGE}`, "x-gantry-purpose": "console", ...headers }, body: JSON.stringify(body) });
  const settle = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  beforeAll(async () => {
    await Promise.all([api.start(), vendor.start()]);
    api.route.baseUrl = vendor.url;
    gw = buildGateway({ cfg: baseConfig({ apiUrl: api.url }), store, logger: false });
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
    store.objects.clear();
    store.failPut = false;
  });

  it("stores the full request and the answer, and reports the reference with where the call belongs", async () => {
    const m = { v: 1, kind: "turn", hash: "a".repeat(64), parts: [{ kind: "system", name: "System prompt as sent", sha256: "b".repeat(64), bytes: 12 }] };
    const res = await call(
      { max_tokens: 50, system: "You are the intake agent.", tools: [{ name: "get_work_order" }], messages: [{ role: "user", content: "hello" }] },
      { "x-gantry-surface": "workorder", "x-gantry-trace-project": "p-1", "x-gantry-work-order": "WO-7", "x-gantry-actor": "p-asha", "x-gantry-turn": "turn-1", "x-gantry-manifest": manifest(m) },
    );
    expect(res.status).toBe(200);
    await res.text();
    await settle(() => api.of("/usage").length > 0);
    const u = JSON.parse(api.of("/usage")[0]!.body) as Record<string, unknown>;
    expect(u).toMatchObject({ surface: "workorder", project: "p-1", woId: "WO-7", actor: "p-asha", turn: "turn-1", promptHash: "a".repeat(64) });
    expect(u.traceRef).toMatch(/^sha256\/[0-9a-f]{64}$/);
    const stored = JSON.parse(store.objects.get(u.traceRef as string)!.toString()) as Record<string, any>;
    expect(stored.request.system).toBe("You are the intake agent.");
    expect(stored.request.messages[0].content).toBe("hello");
    expect(stored.manifest.hash).toBe("a".repeat(64));
    expect(stored.woId).toBe("WO-7");
    expect(stored.response).toBeTruthy();
    expect(gw.service.traceStored).toBe(1);
  });

  it("redacts secrets in the prompt and in the answer before anything is stored", async () => {
    const secret = "ghp_" + "A1b2C3d4E5".repeat(4);
    const key = "sk-ant-test-vendor-key-0123456789abcdef";
    await (await call({ max_tokens: 50, system: `token ${secret}`, messages: [{ role: "user", content: `my key is ${key} and ${secret}` }] })).text();
    await settle(() => api.of("/usage").length > 0);
    const ref = (JSON.parse(api.of("/usage")[0]!.body) as { traceRef: string }).traceRef;
    const text = store.objects.get(ref)!.toString();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(key);
    expect(text).toContain("[REDACTED:github-token]");
    expect(JSON.parse(text).redactions.length).toBeGreaterThan(0);
  });

  it("ignores a malformed or oversized manifest header and still records the call", async () => {
    await (await call({ max_tokens: 5, messages: [{ role: "user", content: "x" }] }, { "x-gantry-manifest": "not base64 json!" })).text();
    await settle(() => api.of("/usage").length > 0);
    const u = JSON.parse(api.of("/usage")[0]!.body) as Record<string, unknown>;
    expect(u.traceRef).toBeTruthy();
    expect(u.promptHash).toBeUndefined();
  });

  it("degrades to a call with no trace reference when the store is down, and never blocks the answer", async () => {
    store.failPut = true;
    const res = await call({ max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
    await res.text();
    await settle(() => api.of("/usage").length > 0);
    expect((JSON.parse(api.of("/usage")[0]!.body) as Record<string, unknown>).traceRef).toBeUndefined();
    expect(gw.service.traceDropped).toBe(1);
  });

  it("serves a stored trace to the edge token only, by a well-formed reference", async () => {
    await (await call({ max_tokens: 5, messages: [{ role: "user", content: "x" }] })).text();
    await settle(() => api.of("/usage").length > 0);
    const hash = (JSON.parse(api.of("/usage")[0]!.body) as { traceRef: string }).traceRef.slice("sha256/".length);
    expect((await fetch(`${base}/service/v1/trace/${hash}`)).status).toBe(401);
    expect((await fetch(`${base}/service/v1/trace/${hash}`, { headers: { authorization: `Bearer ${makeToken("run-1")}` } })).status).toBe(401);
    expect((await fetch(`${base}/service/v1/trace/..%2Fsecret`, { headers: { authorization: `Bearer ${EDGE}` } })).status).toBe(400);
    expect((await fetch(`${base}/service/v1/trace/${"0".repeat(64)}`, { headers: { authorization: `Bearer ${EDGE}` } })).status).toBe(404);
    const ok = await fetch(`${base}/service/v1/trace/${hash}`, { headers: { authorization: `Bearer ${EDGE}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { kind: string }).kind).toBe("service-call");
  });
});
