import { randomBytes } from "node:crypto";
import { decrypt, verifyChain, withTx } from "@gantry/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadLimits } from "../src/areas/internal/metering.js";
import { loadRunCtx } from "../src/areas/internal/context.js";
import { issueRunToken } from "../src/areas/internal/tokens.js";
import { priceBookAt } from "../src/areas/models/prices.js";
import { resolveModel, type ModelFacts, type VendorFacts } from "../src/areas/models/resolve.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);
const ADMIN = "p-asha";
const NOBODY = "p-tomas";
const EDGE = { authorization: "Bearer edge-token-for-tests" };
// Assembled at runtime so no credential-shaped literal sits in the source.
const FAKE_KEY = "sk" + "-" + "x".repeat(30) + "ab12";

d("models, vendors, routing, prices and budgets (spec 8.7, 10.4, 10.5)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ config: { secrets: { sessionKey: Buffer.from("test-session-key-0123456789abcdef"), dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `mdl-${Date.now()}-${n++}` });
  const vendors = async () => (await w.call(ADMIN, "GET", "/api/v1/vendors")).body as any[];
  const vendor = async (id: string) => (await vendors()).find((v) => v.id === id);
  const routing = async () => (await w.call(ADMIN, "GET", "/api/v1/routing")).body as any;
  const putRouting = async (next: object, who = ADMIN, ifm?: number, label?: string) => {
    const cur = await routing();
    const { version: _v, ...base } = cur;
    return w.call(who, "PUT", "/api/v1/routing", { routing: { ...base, ...next }, ...(label ? { label } : {}) }, { "if-match": String(ifm ?? cur.version) });
  };
  const resolve = async (qs: string) => (await w.call(ADMIN, "GET", `/api/v1/routing/resolve?${qs}`)).body as any;
  const events = (type: string) => q(`select * from events where type = $1 order by seq`, [type]);
  let orig: any;
  /** Back to the seeded routing, so each scenario starts from the same policy. */
  const restore = async () => putRouting({ defaultModel: orig.defaultModel, overrides: orig.overrides, fallback: orig.fallback, rules: orig.rules, classOverrides: {}, projects: {}, crossModelFallback: false });
  beforeAll(async () => {
    orig = await routing();
  });

  describe("reads", () => {
    it("returns the legacy shapes from the seeded data", async () => {
      const vs = await vendors();
      expect(vs.map((v) => v.id)).toEqual(["anthropic", "openai", "bedrock", "local"]);
      const a = vs[0];
      expect(a).toMatchObject({ id: "anthropic", name: "Anthropic", connected: true, health: "healthy", region: "us-east / eu (API)", keyMask: expect.stringContaining("••••"), retention: "standard" });
      expect(a.models.find((m: any) => m.id === "claude-opus-5-5")).toMatchObject({ enabled: true, context: 500000, inPrice: 5, outPrice: 25, vendor: "anthropic", canonical: "claude-opus-5-5" });
      expect(vs[2].models.find((m: any) => m.id === "bedrock-claude-opus-5-5")).toMatchObject({ canonical: "claude-opus-5-5" });
      expect(vs[3]).toMatchObject({ connected: false, health: "offline", latency: 0 });
      const r = await routing();
      expect(r).toMatchObject({ defaultModel: "claude-opus-5-5", overrides: { intake: "claude-haiku-5-5" }, version: 1 });
      expect(r.rules[0]).toMatchObject({ id: "RR-1", tag: "regulated", use: "bedrock", region: "eu-central-1", alt: "local" });
      expect(r.crossModelFallback).toBeUndefined();
    });
    it("is for signed-in people only", async () => {
      expect((await t.app.inject({ method: "GET", url: "/api/v1/vendors" })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "GET", url: "/api/v1/routing", headers: EDGE })).statusCode).toBeGreaterThanOrEqual(401);
    });
    it("derives health, latency and spend from the usage meter", async () => {
      for (let i = 0; i < 6; i++) await q(`insert into usage_meter (org_id, vendor_id, model_id, input_tokens, cost_micros, latency_ms, outcome) values ($1,'openai','codex-pro',10,2000000,$2,$3)`, [t.orgId, 1000 + i * 100, i < 2 ? "error" : "ok"]);
      const o = await vendor("openai");
      expect(o.health).toBe("degraded");
      expect(o.latency).toBeGreaterThan(900);
      expect(o.mtd).toBeCloseTo(12, 5);
      expect((await vendor("anthropic")).health).toBe("healthy");
      await q(`delete from usage_meter where vendor_id = 'openai'`);
    });
  });

  describe("vendors (setVendor, addVendor)", () => {
    it("connects a vendor with a key: sealed with the data key, masked everywhere, never in an event", async () => {
      const r = await w.call(ADMIN, "PATCH", "/api/v1/vendors/local", { patch: { key: FAKE_KEY, connected: true, endpoint: "http://gpu-pool.internal:8000/v1", budget: 0 }, action: "vendor.connect" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.msg).toBe("Local models connected.");
      const v = await vendor("local");
      expect(v.connected).toBe(true);
      expect(v.keyMask).toContain("••••");
      expect(JSON.stringify(await vendors())).not.toContain(FAKE_KEY);
      const row = (await q(`select secret_enc from vendors where id = 'local'`))[0];
      expect(row.secret_enc).not.toContain(FAKE_KEY);
      const opened = decrypt(row.secret_enc, DATA_KEY, "vendor:local");
      expect(opened).toEqual({ ok: true, value: FAKE_KEY });
      const ev = (await events("vendor.connect")).at(-1);
      expect(JSON.stringify(ev)).not.toContain(FAKE_KEY);
      expect(ev.after).toMatchObject({ connected: true, keyFingerprint: expect.any(String) });
      expect(ev.before).toMatchObject({ connected: false });
      expect((await t.db.admin.query(`select 1`)).rowCount).toBe(1);
      expect((await withTx(t.db.app, (tx) => verifyChain(tx, t.orgId))).ok).toBe(true);
    });
    it("refuses a hosted vendor without a key and a bad endpoint", async () => {
      await q(`update vendors set connected = false, secret_enc = null where id = 'openai'`);
      const r = await w.call(ADMIN, "PATCH", "/api/v1/vendors/openai", { patch: { connected: true } });
      expect(r.status).toBe(422);
      expect(r.body.msg).toMatch(/API key/);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/vendors/openai", { patch: { endpoint: "https://evil.example.com" } })).status).toBe(422);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/vendors/local", { patch: { endpoint: "ftp://x" } })).body.msg).toMatch(/http/);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/vendors/local", { patch: { endpoint: "https://user:pw@host.example.com/v1" } })).body.msg).toMatch(/not in the URL/);
      await q(`update vendors set connected = true where id = 'openai'`);
    });
    it("denies a person without model.edit and audits the denial", async () => {
      const before = (await events("model.edit.denied")).length;
      const r = await w.call(NOBODY, "PATCH", "/api/v1/vendors/anthropic", { patch: { budget: 1 } });
      expect(r.status).toBe(403);
      expect((await vendor("anthropic")).budget).toBe(9000);
      expect((await q(`select count(*)::int as n from events where outcome = 'denied' and type like '%denied'`))[0].n).toBeGreaterThan(before);
    });
    it("refuses a stale version", async () => {
      const v = await vendor("anthropic");
      const bad = await w.call(ADMIN, "PATCH", "/api/v1/vendors/anthropic", { patch: { budget: 9100 } }, { "if-match": String(v.version + 5) });
      expect(bad.status).toBe(409);
      const ok = await w.call(ADMIN, "PATCH", "/api/v1/vendors/anthropic", { patch: { budget: 9100 } }, { "if-match": String(v.version) });
      expect(ok.status).toBe(200);
      expect((await vendor("anthropic")).budget).toBe(9100);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/vendors/anthropic", { patch: { budget: 9000 } }, { "if-match": String(v.version) })).status).toBe(409);
    });
    it("refuses to disconnect the vendor of the factory default; disconnect clears the key", async () => {
      const r = await w.call(ADMIN, "PATCH", "/api/v1/vendors/anthropic", { patch: { connected: false } });
      expect(r.status).toBe(409);
      expect(r.body.msg).toMatch(/factory default/);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/vendors/local", { patch: { connected: false } })).status).toBe(200);
      const row = (await q(`select connected, secret_enc, secret_mask from vendors where id = 'local'`))[0];
      expect(row).toMatchObject({ connected: false, secret_enc: null, secret_mask: "" });
    });
    it("adds a custom vendor: idempotent, sealed key, marked custom and not qualified", async () => {
      const k = key();
      const body = { name: "Mistral EU", endpoint: "https://llm.example.com/v1", key: FAKE_KEY, region: "eu-west-1", retention: "zero" };
      const r = await w.call(ADMIN, "POST", "/api/v1/vendors", body, k);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.msg).toMatch(/not qualified/);
      const again = await w.call(ADMIN, "POST", "/api/v1/vendors", body, k);
      expect(again.status).toBe(200);
      expect((await vendors()).filter((v) => v.id === "mistral-eu")).toHaveLength(1);
      const v = await vendor("mistral-eu");
      expect(v).toMatchObject({ custom: true, connected: true, retention: "zero", region: "eu-west-1", qualified: {} });
      expect(decrypt((await q(`select secret_enc from vendors where id = 'mistral-eu'`))[0].secret_enc, DATA_KEY, "vendor:mistral-eu")).toEqual({ ok: true, value: FAKE_KEY });
      expect(JSON.stringify(await events("vendor.add"))).not.toContain(FAKE_KEY);
      expect((await w.call(ADMIN, "POST", "/api/v1/vendors", { name: "Mistral EU" }, key())).status).toBe(409);
      expect((await w.call(ADMIN, "POST", "/api/v1/vendors", { name: "Plain", endpoint: "http://insecure.example.com" }, key())).status).toBe(422);
      expect((await w.call(NOBODY, "POST", "/api/v1/vendors", { name: "Nope" }, key())).status).toBe(403);
    });
  });

  describe("models and prices", () => {
    it("adds a model and publishes a price version for it; removes it again", async () => {
      const before = (await w.call(ADMIN, "GET", "/api/v1/prices")).body;
      const r = await w.call(ADMIN, "POST", "/api/v1/models", { vendor: "mistral-eu", def: { id: "mistral-large", name: "Mistral Large", inPrice: "2", outPrice: "6", context: 128000, tier: "frontier" } }, key());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const v = await vendor("mistral-eu");
      expect(v.models).toEqual([expect.objectContaining({ id: "mistral-large", enabled: true, inPrice: 2, outPrice: 6, context: 128000, custom: true, tier: "frontier" })]);
      const after = (await w.call(ADMIN, "GET", "/api/v1/prices")).body;
      expect(after.current).toBe(before.current + 1);
      expect(after.versions[0].prices["mistral-large"]).toEqual({ in: 2, out: 6 });
      expect(after.versions[0].prices["claude-opus-5-5"]).toEqual({ in: 5, out: 25 });
      expect((await w.call(ADMIN, "POST", "/api/v1/models", { vendor: "mistral-eu", def: { id: "mistral-large", name: "Again", inPrice: 1, outPrice: 1 } }, key())).status).toBe(409);
      expect((await w.call(ADMIN, "POST", "/api/v1/models", { vendor: "mistral-eu", def: { name: "Bad", inPrice: -1, outPrice: 1 } }, key())).status).toBe(422);
      expect((await w.call(NOBODY, "POST", "/api/v1/models", { vendor: "mistral-eu", def: { name: "X", inPrice: 1, outPrice: 1 } }, key())).status).toBe(403);
      expect((await w.call(ADMIN, "DELETE", "/api/v1/models/mistral-large")).status).toBe(200);
      expect((await vendor("mistral-eu")).models).toEqual([]);
    });
    it("refuses to remove or disable a model that routing or an agent uses", async () => {
      const r1 = await w.call(ADMIN, "DELETE", "/api/v1/models/claude-opus-5-5");
      expect(r1.status).toBe(409);
      expect(r1.body.msg).toMatch(/Routing uses/);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/models/claude-opus-5-5", { enabled: false })).body.msg).toMatch(/factory default/);
      const r2 = await w.call(ADMIN, "PATCH", "/api/v1/models/claude-sonnet-5-5", { enabled: false });
      expect(r2.status).toBe(409);
      expect(r2.body.msg).toMatch(/Primary model of/);
      expect((await w.call(ADMIN, "DELETE", "/api/v1/models/claude-haiku-5-5")).status).toBe(409);
      expect((await w.call(NOBODY, "PATCH", "/api/v1/models/codex-mini", { enabled: true })).status).toBe(403);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/models/codex-mini", { enabled: true })).status).toBe(200);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/models/codex-mini", { enabled: false })).status).toBe(200);
      expect((await w.call(ADMIN, "PATCH", "/api/v1/models/nope", { enabled: false })).status).toBe(404);
    });
    it("versions prices with effective dates: the version in force at a moment prices the usage", async () => {
      const t0 = Date.now();
      const soon = new Date(t0 + 3600_000).toISOString();
      const cur = (await w.call(ADMIN, "GET", "/api/v1/prices")).body.current;
      const r = await w.call(ADMIN, "POST", "/api/v1/prices", { prices: { "claude-sonnet-5-5": { in: 4, out: 20 } }, effectiveFrom: soon, note: "Price rise" }, key());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.msg).toMatch(/takes effect/);
      const now = await priceBookAt(t.db.admin, t.orgId);
      expect(now.version).toBe(cur);
      expect(now.prices["claude-sonnet-5-5"]).toEqual({ in: 3, out: 15 });
      const later = await priceBookAt(t.db.admin, t.orgId, new Date(t0 + 7200_000));
      expect(later.version).toBe(r.body.version);
      expect(later.prices["claude-sonnet-5-5"]).toEqual({ in: 4, out: 20 });
      const qs = (at?: string) => `/api/v1/prices/quote?model=claude-sonnet-5-5&input=1000000&output=1000000${at ? `&at=${encodeURIComponent(at)}` : ""}`;
      expect((await w.call(ADMIN, "GET", qs())).body).toMatchObject({ priceVersion: cur, costMicros: 18_000_000, priced: true });
      expect((await w.call(ADMIN, "GET", qs(new Date(t0 + 7200_000).toISOString()))).body).toMatchObject({ priceVersion: r.body.version, costMicros: 24_000_000 });
      expect((await w.call(ADMIN, "GET", "/api/v1/prices/quote?model=nope&input=5")).body).toMatchObject({ priced: false, costMicros: 0 });
      // The vendor read shows the price in force now.
      expect((await vendor("anthropic")).models.find((m: any) => m.id === "claude-sonnet-5-5")).toMatchObject({ inPrice: 3, outPrice: 15 });
      // Published versions are immutable; a past effective date and unknown models are refused.
      await expect(q(`update price_versions set note = 'x' where version = $1`, [r.body.version])).rejects.toThrow(/immutable/);
      expect((await w.call(ADMIN, "POST", "/api/v1/prices", { prices: { "claude-sonnet-5-5": { in: 1, out: 1 } }, effectiveFrom: new Date(t0 - 86400_000).toISOString() }, key())).status).toBe(422);
      expect((await w.call(ADMIN, "POST", "/api/v1/prices", { prices: { nope: { in: 1, out: 1 } } }, key())).status).toBe(422);
      expect((await w.call(NOBODY, "POST", "/api/v1/prices", { prices: { "claude-sonnet-5-5": { in: 1, out: 1 } } }, key())).status).toBe(403);
      // A price effective now takes over at once.
      const now2 = await w.call(ADMIN, "POST", "/api/v1/prices", { prices: { "claude-sonnet-5-5": { in: 3.5, out: 16 } }, note: "Now" }, key());
      expect((await priceBookAt(t.db.admin, t.orgId)).prices["claude-sonnet-5-5"]).toEqual({ in: 3.5, out: 16 });
      expect(now2.body.version).toBe(r.body.version + 1);
      await q(`delete from price_versions where false`);
    });
  });

  describe("routing (setRouting)", () => {
    it("saves a new version, audits before and after, and refuses stale and unknown references", async () => {
      const cur = await routing();
      const r = await putRouting({ overrides: { ...cur.overrides, build: "claude-sonnet-5-5" } }, ADMIN, undefined, "Build now uses Sonnet");
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.version).toBe(cur.version + 1);
      const after = await routing();
      expect(after.overrides.build).toBe("claude-sonnet-5-5");
      const ev = (await events("routing.edit")).at(-1);
      expect(ev.before.overrides.build).toBeUndefined();
      expect(ev.after.overrides.build).toBe("claude-sonnet-5-5");
      expect(ev.after.label).toBe("Build now uses Sonnet");
      // stale: the old version
      const stale = await putRouting({ overrides: { ...cur.overrides, build: "claude-haiku-5-5" } }, ADMIN, cur.version);
      expect(stale.status).toBe(409);
      // missing If-Match
      const raw = await w.call(ADMIN, "PUT", "/api/v1/routing", { routing: { defaultModel: "claude-opus-5-5", fallback: ["claude-opus-5-5"] } }, { "if-match": "" });
      expect([409, 422]).toContain(raw.status);
      expect((await putRouting({ defaultModel: "no-such-model" })).status).toBe(422);
      expect((await putRouting({ overrides: { nope: "claude-sonnet-5-5" } })).body.msg).toMatch(/no station nope/);
      expect((await putRouting({ fallback: [] })).body.msg).toMatch(/at least one fallback/);
      expect((await putRouting({ classOverrides: { nope: "claude-sonnet-5-5" } })).body.msg).toMatch(/class nope/);
      expect((await putRouting({ rules: [...after.rules, { id: "RR-9", tag: "regulated", use: "bedrock", region: "", alt: "", note: "" }] })).body.msg).toMatch(/already exists/);
      expect((await putRouting({ rules: [{ id: "RR-9", tag: "x", use: "bedrock", region: "", alt: "bedrock", note: "" }] })).body.msg).toMatch(/different vendor/);
      expect((await putRouting({ projects: { nope: { defaultModel: "claude-opus-5-5" } } })).body.msg).toMatch(/no project nope/);
      expect((await putRouting({ defaultModel: "codex-mini" })).body.msg).toMatch(/disabled/);
      await q(`update models set enabled = true where id = 'local-coder-7b'`);
      expect((await putRouting({ defaultModel: "local-coder-7b" })).body.msg).toMatch(/not connected/);
      await q(`update models set enabled = false where id = 'local-coder-7b'`);
      expect((await putRouting({})).body.msg).toMatch(/already like that/);
      // denied
      expect((await putRouting({ overrides: {} }, NOBODY)).status).toBe(403);
      expect((await routing()).version).toBe(after.version);
    });
    it("is refused while the factory is killed", async () => {
      await q(`insert into stops (org_id, id, scope_type, mode, reason, set_by) values ($1,'factory:t:1','factory','kill','test kill','p-asha')`, [t.orgId]);
      const r = await putRouting({ overrides: {} });
      expect(r.status).toBe(409);
      expect(r.body.msg).toMatch(/factory is killed/);
      await q(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = 'factory:t:1'`);
    });
  });

  describe("resolution: default, project, station, class, then the filter", () => {
    beforeEach(restore);
    beforeAll(async () => {
      // A hosted vendor with no endpoint cannot be called, so give Bedrock the endpoint its region serves.
      await q(`update vendors set endpoint = 'https://bedrock-runtime.eu-central-1.example.com' where id = 'bedrock'`);
    });
    it("applies the layers in order", async () => {
      const ok = await putRouting({
        overrides: { build: "claude-sonnet-5-5" },
        rules: [],
        classOverrides: { bug: "claude-haiku-5-5" },
        projects: { payments: { defaultModel: "claude-sonnet-5-5", overrides: { build: "claude-opus-5-5" } } },
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await resolve("station=review")).model).toBe("claude-opus-5-5");
      expect((await resolve("station=review&project=payments")).model).toBe("claude-sonnet-5-5");
      expect((await resolve("station=build")).model).toBe("claude-sonnet-5-5");
      expect((await resolve("station=build&project=payments")).model).toBe("claude-opus-5-5");
      const cl = await resolve("station=build&project=payments&class=bug");
      expect(cl).toMatchObject({ model: "claude-haiku-5-5", layer: "class", vendor: "anthropic" });
      expect(cl.steps[0]).toMatch(/Factory default/);
      expect((await w.call(ADMIN, "GET", "/api/v1/routing/resolve")).status).toBe(422);
      expect((await w.call(ADMIN, "GET", "/api/v1/routing/resolve?station=build&project=nope")).status).toBe(404);
    });
    it("filters by allowed vendors, regions and retention before any fallback", async () => {
      await putRouting({ projects: { payments: { allowedVendors: ["bedrock"] } } });
      const a = await resolve("station=review&project=payments");
      expect(a).toMatchObject({ model: "bedrock-claude-opus-5-5", vendor: "bedrock", sameModelFallback: true, crossModel: false });
      expect(a.steps.join(" ")).toMatch(/not allowed for this project/);
      await putRouting({ projects: { payments: { allowedRegions: ["eu-central-1"] } } });
      expect(await resolve("station=review&project=payments")).toMatchObject({ vendor: "bedrock" });
      await putRouting({ projects: { payments: { allowedRegions: ["ap-south-1"] } } });
      const none = await resolve("station=review&project=payments");
      expect(none.model).toBeNull();
      expect(none.blocked).toMatch(/outside the allowed regions/);
      await putRouting({ projects: { payments: { allowedRetention: ["zero"] } } });
      expect((await resolve("station=review&project=payments")).blocked).toMatch(/keeps data in mode/);
      await q(`update vendors set config = config || '{"retention":"zero"}' where id = 'anthropic'`);
      expect(await resolve("station=review&project=payments")).toMatchObject({ vendor: "anthropic", model: "claude-opus-5-5" });
      await q(`update vendors set config = config - 'retention' where id = 'anthropic'`);
      await putRouting({ projects: {} });
    });
    it("a residency rule keeps a regulated repo on its vendor: the same model there, never a different one without opt-in", async () => {
      const repo = (await q(`select r.id from repos r join projects p on p.id = r.project_id and p.org_id = r.org_id where p.regulated limit 1`))[0].id;
      const r = await resolve(`station=review&repo=${repo}`);
      expect(r).toMatchObject({ model: "bedrock-claude-opus-5-5", vendor: "bedrock", rule: { id: "RR-1" }, sameModelFallback: true });
      // Bedrock disabled for that model: nothing else serves it, and the fallback order is not tried (cross-model is off).
      await q(`update models set enabled = false where id = 'bedrock-claude-opus-5-5'`);
      const blocked = await resolve(`station=review&repo=${repo}`);
      expect(blocked.model).toBeNull();
      expect(blocked.blocked).toMatch(/RR-1: no allowed vendor/);
      expect(blocked.steps.join(" ")).toMatch(/Cross-model fallback is off/);
      // Factory switch alone is not enough; the project must opt in as well.
      await putRouting({ crossModelFallback: true });
      expect((await resolve(`station=review&repo=${repo}`)).model).toBeNull();
      const proj = (await q(`select project_id from repos where id = $1`, [repo]))[0].project_id;
      await putRouting({ crossModelFallback: true, projects: { [proj]: { crossModelFallback: true } } });
      const x = await resolve(`station=review&repo=${repo}`);
      expect(x).toMatchObject({ model: "bedrock-claude-sonnet-5-5", crossModel: true, vendor: "bedrock" });
      expect(x.steps.join(" ")).toMatch(/flagged/);
      await putRouting({ crossModelFallback: false, projects: {} });
      await q(`update models set enabled = true where id = 'bedrock-claude-opus-5-5'`);
    });
    it("a custom vendor is not qualified for a station until its suite passed on it", async () => {
      await w.call(ADMIN, "POST", "/api/v1/models", { vendor: "mistral-eu", def: { id: "mistral-large", name: "Mistral Large", inPrice: 2, outPrice: 6 } }, key());
      await putRouting({ overrides: { build: "mistral-large" } });
      const before = await resolve("station=build");
      expect(before.model).toBeNull();
      expect(before.blocked).toMatch(/not qualified for station build/);
      // No eval run yet: qualification is refused.
      const none = await w.call(ADMIN, "POST", "/api/v1/vendors/mistral-eu/qualify", { station: "build" });
      expect(none.status).toBe(409);
      expect(none.body.msg).toMatch(/No eval run/);
      await q(`insert into suites (org_id, id, name, station, data) values ($1,'SUITE-MDL','Build suite','build',$2::jsonb) on conflict (org_id, id) do nothing`, [t.orgId, JSON.stringify({ threshold: 0.9 })]);
      await q(`insert into eval_runs (org_id, id, suite_id, status, score, data) values ($1,'RUN-MDL-1','SUITE-MDL','completed',0.8,$2::jsonb)`, [t.orgId, JSON.stringify({ vendor: "mistral-eu" })]);
      const low = await w.call(ADMIN, "POST", "/api/v1/vendors/mistral-eu/qualify", { station: "build" });
      expect(low.status).toBe(409);
      expect(low.body.msg).toMatch(/0\.9 is needed/);
      await q(`insert into eval_runs (org_id, id, suite_id, status, score, data) values ($1,'RUN-MDL-2','SUITE-MDL','completed',0.95,$2::jsonb)`, [t.orgId, JSON.stringify({ vendor: "mistral-eu" })]);
      expect((await w.call(NOBODY, "POST", "/api/v1/vendors/mistral-eu/qualify", { station: "build" })).status).toBe(403);
      const ok = await w.call(ADMIN, "POST", "/api/v1/vendors/mistral-eu/qualify", { station: "build" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await vendor("mistral-eu")).qualified.build).toMatchObject({ suite: "SUITE-MDL", run: "RUN-MDL-2" });
      expect(await resolve("station=build")).toMatchObject({ model: "mistral-large", vendor: "mistral-eu" });
      expect((await resolve("station=verify&model=mistral-large")).model).toBeNull();
      expect((await w.call(ADMIN, "POST", "/api/v1/vendors/anthropic/qualify", { station: "build" })).status).toBe(422);
      await putRouting({ overrides: { intake: "claude-haiku-5-5", verify: "claude-sonnet-5-5", close: "claude-haiku-5-5" } });
    });
  });

  describe("the edge's authorize step uses routing, filters and budgets", () => {
    beforeEach(restore);
    let runN = 0;
    async function makeRun(o: { project?: string; repo?: string | null; model?: string | null; woData?: object; cls?: string; station?: string } = {}) {
      const i = ++runN;
      const project = o.project ?? "payments";
      const woId = `WO-mdl-${i}`;
      const attemptId = `at-mdl-${i}`;
      const runId = `run-mdl-${i}`;
      await q(`insert into work_orders (org_id, id, project_id, repo_id, title, class, position, state, flow_version, data) values ($1,$2,$3,$4,'T',$5,$6,'running',1,$7::jsonb)`, [t.orgId, woId, project, o.repo ?? null, o.cls ?? "feature", o.station ?? "build", JSON.stringify(o.woData ?? {})]);
      const a = await q(`insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,$4,1,'running','{}'::jsonb) returning fencing::text as fencing`, [t.orgId, attemptId, woId, o.station ?? "build"]);
      await q(`insert into runs (org_id, id, attempt_id, wo_id, model_id, data) values ($1,$2,$3,$4,$5,'{}'::jsonb)`, [t.orgId, runId, attemptId, woId, o.model === undefined ? null : o.model]);
      const tk = await withTx(t.db.app, (tx) => issueRunToken(tx, runId, attemptId, a[0].fencing));
      return { runId, token: tk.token, woId };
    }
    const authorize = async (r: { runId: string; token: string }, model?: string) =>
      (await t.app.inject({ method: "POST", url: `/internal/v1/runs/${r.runId}/authorize`, headers: EDGE, payload: { token: r.token, ...(model ? { model } : {}) } })).json();

    it("routes an unpinned run by station and class, and returns the route with same-model alternates", async () => {
      await putRouting({ overrides: { build: "claude-sonnet-5-5", intake: "claude-haiku-5-5", verify: "claude-sonnet-5-5", close: "claude-haiku-5-5" }, classOverrides: { bug: "claude-haiku-5-5" } });
      const a = await authorize(await makeRun({ model: null }));
      expect(a).toMatchObject({ allow: true, route: { vendor: "anthropic", modelId: "claude-sonnet-5-5", upstreamModel: "claude-sonnet-5-5", baseUrl: "https://api.anthropic.com" } });
      expect(a.route.alternates).toEqual([{ vendor: "bedrock", baseUrl: "https://bedrock-runtime.eu-central-1.example.com", modelId: "bedrock-claude-sonnet-5-5", upstreamModel: "bedrock-claude-sonnet-5-5", crossModel: false }]);
      const c = await authorize(await makeRun({ model: null, cls: "bug" }));
      expect(c.route.modelId).toBe("claude-haiku-5-5");
      await putRouting({ classOverrides: {} });
    });
    it("a regulated repo's run is routed to the same model on its residency vendor; a pinned model keeps its identity", async () => {
      const repo = (await q(`select r.id, r.project_id from repos r join projects p on p.id = r.project_id and p.org_id = r.org_id where p.regulated limit 1`))[0];
      const a = await authorize(await makeRun({ project: repo.project_id, repo: repo.id, model: "claude-opus-5-5" }));
      expect(a).toMatchObject({ allow: true, route: { vendor: "bedrock", modelId: "bedrock-claude-opus-5-5", baseUrl: "https://bedrock-runtime.eu-central-1.example.com" } });
      expect(a.route.crossModel).toBeUndefined();
      const refused = await authorize(await makeRun({ project: repo.project_id, repo: repo.id, model: "claude-opus-5-5" }), "claude-sonnet-5-5");
      expect(refused).toMatchObject({ allow: false, code: "route" });
      await q(`update models set enabled = false where id = 'bedrock-claude-opus-5-5'`);
      const blocked = await authorize(await makeRun({ project: repo.project_id, repo: repo.id, model: "claude-opus-5-5" }));
      expect(blocked).toMatchObject({ allow: false, code: "route" });
      expect(blocked.reason).toMatch(/RR-1/);
      await q(`update models set enabled = true where id = 'bedrock-claude-opus-5-5'`);
    });
    it("records a fallback reported with usage: flagged on the run and in the audit trail", async () => {
      const r = await makeRun({ model: "claude-sonnet-5-5" });
      const usage = (body: object) => t.app.inject({ method: "POST", url: `/internal/v1/runs/${r.runId}/usage`, headers: EDGE, payload: { token: r.token, inputTokens: 1000, outputTokens: 1000, ...body } });
      const res = await usage({ requestId: "rq-fb-1", model: "bedrock-claude-sonnet-5-5", vendor: "bedrock", fallback: "same_model", wanted: "claude-sonnet-5-5" });
      expect(res.statusCode, res.body).toBe(200);
      expect((await q(`select data from runs where id = $1`, [r.runId]))[0].data.fallbacks).toEqual([expect.objectContaining({ kind: "same_model", model: "bedrock-claude-sonnet-5-5", wanted: "claude-sonnet-5-5" })]);
      const ev = (await events("model.fallback")).at(-1);
      expect(ev).toMatchObject({ outcome: "ok", subject: { type: "run", id: r.runId } });
      const meter = (await q(`select vendor_id, model_id, cost_micros::int as c, price_version from usage_meter where request_id = 'rq-fb-1'`))[0];
      expect(meter).toMatchObject({ vendor_id: "bedrock", model_id: "bedrock-claude-sonnet-5-5" });
      expect(meter.c).toBe(Math.round(1000 * 3.3 + 1000 * 16.5));
      const x = await usage({ requestId: "rq-fb-2", model: "bedrock-claude-opus-5-5", vendor: "bedrock", fallback: "cross_model", wanted: "claude-sonnet-5-5" });
      expect(x.statusCode).toBe(200);
      expect((await events("model.fallback")).at(-1)).toMatchObject({ outcome: "regression" });
    });
    it("uses the project's per-work-order budget, then the work order's own cap; refuses the next call on breach", async () => {
      const wo = await makeRun({ project: "storefront", model: "claude-sonnet-5-5" });
      const ctx = async (id = wo.runId) => withTx(t.db.app, async (tx) => (await loadRunCtx(tx, t.orgId, id))!);
      expect((await withTx(t.db.app, async (tx) => loadLimits(tx, await ctx()))).woMicros).toBeNull();
      const denied = await w.call(NOBODY, "PUT", "/api/v1/budgets/storefront", { perWorkOrder: 5 });
      expect([403, 404]).toContain(denied.status);
      const r = await w.call(ADMIN, "PUT", "/api/v1/budgets/storefront", { perWorkOrder: 5 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await withTx(t.db.app, async (tx) => loadLimits(tx, await ctx()))).woMicros).toBe(5_000_000);
      const own = await makeRun({ project: "storefront", model: "claude-sonnet-5-5", woData: { budgetUsd: 2 } });
      expect((await withTx(t.db.app, async (tx) => loadLimits(tx, await ctx(own.runId)))).woMicros).toBe(2_000_000);
      // Spend past the work-order cap: the next authorize is refused with the budget code.
      expect((await authorize(wo))).toMatchObject({ allow: true });
      await q(`insert into run_usage (org_id, run_id, attempt_id, wo_id, project_id, model_id, input_tokens, output_tokens, cost_micros) select $1, run_id, attempt_id, wo_id, 'storefront', 'claude-sonnet-5-5', 1, 1, 5000000 from (select id as run_id, attempt_id, wo_id from runs where id = $2) x`, [t.orgId, wo.runId]);
      const br = await authorize(wo);
      expect(br).toMatchObject({ allow: false, code: "budget" });
      expect(br.reason).toMatch(/work order budget is spent/);
      expect((await w.call(ADMIN, "GET", "/api/v1/budgets")).body.find((b: any) => b.project === "storefront")).toMatchObject({ perWorkOrder: 5 });
      expect((await w.call(ADMIN, "PUT", "/api/v1/budgets/nope", { perWorkOrder: 5 })).status).toBeGreaterThanOrEqual(403);
      expect((await w.call(ADMIN, "PUT", "/api/v1/budgets/storefront", { perWorkOrder: -1 })).status).toBe(422);
    });
  });

  describe("the pure resolver", () => {
    const v = (id: string, o: Partial<VendorFacts> = {}): VendorFacts => ({ id, name: id, connected: true, endpoint: "https://x", product: "", region: "", retention: "standard", custom: false, hasSecret: true, qualified: [], ...o });
    const m = (id: string, vendorId: string, o: Partial<ModelFacts> = {}): ModelFacts => ({ id, vendorId, enabled: true, canonical: id.replace(/^v2-/, ""), upstream: id, ...o });
    const routing = { defaultModel: "a", overrides: {}, fallback: ["a", "b"], rules: [] };
    it("tries the same model on the other vendor first, in order, and a different model only with both switches", () => {
      const vendors = [v("v1"), v("v2")];
      const models = [m("a", "v1"), m("v2-a", "v2"), m("b", "v1")];
      const r = resolveModel({ routing, vendors, models, station: "build" });
      expect(r.pick).toMatchObject({ model: "a", vendor: "v1" });
      expect(r.alternates).toEqual([expect.objectContaining({ model: "v2-a", vendor: "v2", crossModel: false })]);
      const down = resolveModel({ routing, vendors: [v("v1", { connected: false }), v("v2")], models, station: "build" });
      expect(down.pick).toMatchObject({ model: "v2-a", sameModel: true });
      const only = [m("a", "v1"), m("b", "v1")];
      const off = resolveModel({ routing, vendors: [v("v1", { connected: false })], models: only, station: "build" });
      expect(off.pick).toBeNull();
      const on = resolveModel({ routing: { ...routing, crossModelFallback: true, projects: { p: { crossModelFallback: true } } }, vendors: [v("v1", { connected: false }), v("v2")], models: [m("a", "v1"), m("b", "v2")], station: "build", project: "p" });
      expect(on.pick).toMatchObject({ model: "b", crossModel: true });
      const optOutProject = resolveModel({ routing: { ...routing, crossModelFallback: true }, vendors: [v("v1", { connected: false }), v("v2")], models: [m("a", "v1"), m("b", "v2")], station: "build", project: "p" });
      expect(optOutProject.pick).toBeNull();
    });
    it("honours a project opt-in kept in the project's own config", () => {
      const r = resolveModel({ routing: { ...routing, crossModelFallback: true }, vendors: [v("v1", { connected: false }), v("v2")], models: [m("a", "v1"), m("b", "v2")], station: "build", projectCrossModel: true });
      expect(r.pick?.model).toBe("b");
    });
  });
});
