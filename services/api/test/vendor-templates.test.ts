import { randomBytes } from "node:crypto";
import { decrypt, withTx } from "@gantry/db";
import { VENDOR_TEMPLATES, canonicalModelId, knownModel } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureRuntime, resetRuntime } from "../src/areas/integrations/runtime.js";
import { issueRunToken } from "../src/areas/internal/tokens.js";
import { proxiedHttp, type OutboundHttp } from "../src/areas/notifications/http.js";
import { discoverModels } from "../src/areas/models/discovery.js";
import { Double } from "./notify-doubles.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);
const ADMIN = "p-asha";
const NOBODY = "p-tomas";
const EDGE = { authorization: "Bearer edge-token-for-tests" };
// Assembled at runtime so no credential-shaped literal sits in the source.
const ANT_KEY = "sk-ant" + "-" + "x".repeat(30) + "ab12";
const AWS_ID = "AKIA" + "ABCDEFGHIJKLMNOP";
const AWS_SECRET = "s".repeat(40);

/** An outbound client that sends every request to a local double, keeping the path, query and headers. */
const toDouble = (dbl: Double): OutboundHttp => {
  const real = proxiedHttp({ proxy: null });
  return { request: (r) => { const u = new URL(r.url); return real.request({ ...r, url: `${dbl.url}${u.pathname}${u.search}`, headers: { ...r.headers, "x-original-host": u.host } }); } };
};

d("vendor templates and model discovery (spec 10.4)", () => {
  let t: TestApp;
  let dbl: Double;
  beforeAll(async () => {
    t = await startApp({ config: { secrets: { sessionKey: Buffer.from("test-session-key-0123456789abcdef"), dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    dbl = await new Double().start();
    configureRuntime({ http: toDouble(dbl) });
    dbl.on("/v1/models", (s) =>
    s.headers["x-api-key"] === ANT_KEY && s.headers["anthropic-version"]
      ? [200, { data: [{ id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5", max_input_tokens: 200000 }, { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-future-9", display_name: "Claude Future 9" }], has_more: false }]
      : [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }],
  );
  });
  afterAll(async () => {
    resetRuntime();
    await dbl.stop();
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `vt-${Date.now()}-${n++}` });
  const events = (type: string) => q(`select * from events where type = $1 order by seq`, [type]);
  const fromTemplate = (body: object, who = ADMIN) => w.call(who, "POST", "/api/v1/vendors/from-template", body, key());
  const modelsOf = async (vendor: string) => ((await w.call(ADMIN, "GET", "/api/v1/vendors")).body as any[]).find((v) => v.id === vendor)?.models as any[];

  it("lists the templates with their fields and no secrets", async () => {
    const r = await w.call(ADMIN, "GET", "/api/v1/vendor-templates");
    expect(r.status).toBe(200);
    expect((r.body as any[]).map((x) => x.id)).toEqual(VENDOR_TEMPLATES.map((x) => x.id));
    expect((r.body as any[]).find((x) => x.id === "bedrock").fields.map((f: any) => f.key)).toEqual(["region", "accessKeyId", "secretAccessKey", "sessionToken"]);
  });

  it("adds Anthropic from its template: discovers models, prices known ones, enables them, seals the key, audits", async () => {
    const r = await fromTemplate({ template: "anthropic", name: "Anthropic Team", fields: { apiKey: ANT_KEY } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.discovery).toMatchObject({ found: 3, added: 3, enabled: 2, needPrice: 1 });
    const ms = await modelsOf("anthropic-team");
    expect(ms.map((m) => m.id).sort()).toEqual(["anthropic-team-claude-opus-5-5", "claude-future-9", "claude-sonnet-4-5"]);
    const sonnet = ms.find((m) => m.id === "claude-sonnet-4-5");
    expect(sonnet).toMatchObject({ enabled: true, inPrice: 3, outPrice: 15, context: 200000, canonical: "claude-sonnet-4-5" });
    const future = ms.find((m) => m.id === "claude-future-9");
    expect(future).toMatchObject({ enabled: false, inPrice: 0, outPrice: 0 });
    expect(decrypt((await q(`select secret_enc from vendors where id = 'anthropic-team'`))[0].secret_enc, DATA_KEY, "vendor:anthropic-team")).toEqual({ ok: true, value: ANT_KEY });
    const seen = dbl.calls("/v1/models")[0]!;
    expect(seen.headers["x-api-key"]).toBe(ANT_KEY);
    expect(JSON.stringify(await events("vendor.add"))).not.toContain(ANT_KEY);
    expect(JSON.stringify(await events("vendor.discover"))).not.toContain(ANT_KEY);
    expect((await events("vendor.discover"))[0].outcome ?? "ok").toBe("ok");
    expect(((await w.call(ADMIN, "GET", "/api/v1/prices")).body as any).versions[0].prices["claude-sonnet-4-5"]).toMatchObject({ in: 3, out: 15 });
  });

  it("refresh adds only new models and keeps a person's switches and prices", async () => {
    await w.call(ADMIN, "PATCH", "/api/v1/models/claude-sonnet-4-5", { enabled: false });
    expect((await w.call(ADMIN, "PATCH", "/api/v1/models/claude-future-9", { context: 300000 })).status).toBe(200);
    dbl.routes.set("/v1/models", () => [200, { data: [{ id: "claude-sonnet-4-5-20250929" }, { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" }], has_more: false }]);
    const r = await w.call(ADMIN, "POST", "/api/v1/vendors/anthropic-team/discover", {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.discovery).toMatchObject({ found: 2, added: 1, kept: 1, missing: 2 });
    const ms = await modelsOf("anthropic-team");
    expect(ms.find((m) => m.id === "claude-sonnet-4-5").enabled).toBe(false);
    expect(ms.find((m) => m.id === "claude-future-9").context).toBe(300000);
    expect(ms.find((m) => m.id === "claude-haiku-4-5")).toMatchObject({ enabled: true, inPrice: 1, outPrice: 5 });
    expect((await w.call(NOBODY, "POST", "/api/v1/vendors/anthropic-team/discover", {})).status).toBe(403);
  });

  it("a discovered model on a template vendor is called through the gateway route with the vendor's URL and the vendor's own id", async () => {
    const wo = "WO-vt-1";
    await q(`insert into work_orders (org_id, id, project_id, title, class, position, state, flow_version, data) values ($1,$2,'payments','T','feature',1,'running',1,'{}'::jsonb)`, [t.orgId, wo]);
    const a = await q(`insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,'at-vt-1',$2,'build',1,'running','{}'::jsonb) returning fencing::text as fencing`, [t.orgId, wo]);
    await q(`insert into runs (org_id, id, attempt_id, wo_id, model_id, data) values ($1,'run-vt-1','at-vt-1',$2,'claude-haiku-4-5','{}'::jsonb)`, [t.orgId, wo]);
    const tk = await withTx(t.db.app, (tx) => issueRunToken(tx, "run-vt-1", "at-vt-1", a[0].fencing));
    const r = (await t.app.inject({ method: "POST", url: `/internal/v1/runs/run-vt-1/authorize`, headers: EDGE, payload: { token: tk.token } })).json();
    expect(r.allow ?? r.ok, JSON.stringify(r)).toBeTruthy();
    expect(r.route).toMatchObject({ vendor: "anthropic-team", baseUrl: "https://api.anthropic.com", upstreamModel: "claude-haiku-4-5-20251001" });
    const k = await t.app.inject({ method: "GET", url: "/internal/v1/vendors/anthropic-team/key", headers: EDGE });
    expect(k.json().key).toBe(ANT_KEY);
  });

  it("a wrong key is a clear 422, stores nothing, and is audited as failed", async () => {
    dbl.routes.set("/v1/models", () => [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }]);
    const r = await fromTemplate({ template: "anthropic", name: "Bad Key", fields: { apiKey: "sk-ant-" + "n".repeat(30) } });
    expect(r.status).toBe(422);
    expect(r.body.msg).toMatch(/rejected the credentials \(HTTP 401\).*invalid x-api-key/);
    expect(await q(`select 1 from vendors where id = 'bad-key'`)).toHaveLength(0);
    expect((await events("vendor.discover")).some((e: any) => e.outcome === "failed")).toBe(true);
  });

  it("validates template fields and refuses an unknown template, a duplicate and a caller without model.edit", async () => {
    expect((await fromTemplate({ template: "anthropic", fields: {} })).body.msg).toMatch(/API key is required/);
    expect((await fromTemplate({ template: "bedrock", fields: { region: "mars-1", accessKeyId: AWS_ID, secretAccessKey: AWS_SECRET } })).body.msg).toMatch(/region must be one of/);
    expect((await fromTemplate({ template: "azure-openai", fields: { endpoint: "ftp://x", apiKey: "k".repeat(10), apiVersion: "2024-10-21" } })).status).toBe(422);
    expect((await fromTemplate({ template: "nope", fields: {} })).status).toBe(404);
    expect((await fromTemplate({ template: "anthropic", name: "Anthropic Team", fields: { apiKey: ANT_KEY } })).status).toBe(409);
    expect((await fromTemplate({ template: "anthropic", name: "Sneaky", fields: { apiKey: ANT_KEY } }, NOBODY)).status).toBe(403);
    expect(await q(`select 1 from vendors where id = 'sneaky'`)).toHaveLength(0);
  });

  it("Bedrock: signs the listing with SigV4 (session token included), packs the credentials, adds models disabled with a reason", async () => {
    dbl.routes.set("/foundation-models", (s) => /^AWS4-HMAC-SHA256 Credential=AKIA.*\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/.test(String(s.headers.authorization))
      ? [200, { modelSummaries: [{ modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0", modelName: "Claude Sonnet 4.5", providerName: "Anthropic", inputModalities: ["TEXT", "IMAGE"], outputModalities: ["TEXT"] }, { modelId: "amazon.titan-embed-text-v2:0", modelName: "Titan Embed", inputModalities: ["TEXT"], outputModalities: ["EMBEDDING"] }] }]
      : [403, { Message: "bad signature" }]);
    dbl.routes.set("/inference-profiles", () => [200, { inferenceProfileSummaries: [{ inferenceProfileId: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", inferenceProfileName: "EU Anthropic Claude Sonnet 4.5", status: "ACTIVE" }] }]);
    const r = await fromTemplate({ template: "bedrock", fields: { region: "eu-west-1", accessKeyId: AWS_ID, secretAccessKey: AWS_SECRET, sessionToken: "tok" + "e".repeat(40) } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.discovery).toMatchObject({ found: 2, added: 2, enabled: 0 });
    expect(dbl.calls("/foundation-models")[0]!.headers["x-original-host"]).toBe("bedrock.eu-west-1.amazonaws.com");
    const ms = await modelsOf("aws-bedrock");
    expect(ms.map((m) => m.canonical)).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-5"]);
    expect(ms.every((m) => !m.enabled && m.inPrice === 3)).toBe(true);
    expect((await w.call(ADMIN, "PATCH", `/api/v1/models/${ms[0].id}`, { enabled: true })).status).toBe(409);
    const stored = decrypt((await q(`select secret_enc from vendors where id = 'aws-bedrock'`))[0].secret_enc, DATA_KEY, "vendor:aws-bedrock");
    expect(stored.ok && JSON.parse(stored.value)).toMatchObject({ accessKeyId: AWS_ID, secretAccessKey: AWS_SECRET });
    expect(JSON.stringify(await events("vendor.add"))).not.toContain(AWS_SECRET);
    // a refresh re-reads the packed credentials
    expect((await w.call(ADMIN, "POST", "/api/v1/vendors/aws-bedrock/discover", {})).status).toBe(200);
    expect(dbl.calls("/foundation-models").length).toBe(2);
  });

  it("an OpenAI-compatible endpoint lists /v1/models; models are enabled only when it also accepts Messages", async () => {
    dbl.routes.set("/llm/v1/models", (s) => (s.headers.authorization === "Bearer lk-1234567890" ? [200, { data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "my-finetune" }] }] : [401, { error: { message: "no" } }]));
    const noMsg = await fromTemplate({ template: "openai-compatible", name: "Gateway A", fields: { endpoint: "https://llm.example.com/llm/v1", apiKey: "lk-1234567890" } });
    expect(noMsg.status, JSON.stringify(noMsg.body)).toBe(200);
    expect(noMsg.body.discovery).toMatchObject({ found: 2, enabled: 0 });
    const yes = await fromTemplate({ template: "openai-compatible", name: "Gateway B", fields: { endpoint: "https://llm.example.com/llm/v1", apiKey: "lk-1234567890", anthropicCompat: "true" } });
    expect(yes.body.discovery).toMatchObject({ found: 2, added: 2, enabled: 1, needPrice: 1 });
    const ms = await modelsOf("gateway-b");
    expect(ms.find((m) => m.id === "gateway-b-gpt-4o")).toMatchObject({ enabled: true, inPrice: 2.5, outPrice: 10 });
    expect(await modelsOf("gateway-a")).toHaveLength(2);
    expect((await modelsOf("gateway-a")).find((m) => m.id === "gpt-4o")).toBeTruthy();
    const v = ((await w.call(ADMIN, "GET", "/api/v1/vendors")).body as any[]).find((x) => x.id === "gateway-b");
    expect(v).toMatchObject({ custom: true, endpoint: "https://llm.example.com/llm/v1", qualified: {} });
  });

  it("OpenAI, Azure and Gemini listings parse and filter", async () => {
    const http = toDouble(dbl);
    const tpl = (id: string) => VENDOR_TEMPLATES.find((x) => x.id === id)!;
    dbl.routes.set("/v1beta/models", (s) => (s.headers["x-goog-api-key"] === "gk" ? [200, { models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }] }] : [403, { error: { message: "API key not valid" } }]));
    const g = await discoverModels(http, tpl("gemini"), { apiKey: "gk" });
    expect(g).toMatchObject({ ok: true, models: [{ upstream: "gemini-2.5-pro", context: 1048576 }] });
    expect(await discoverModels(http, tpl("gemini"), { apiKey: "bad" })).toMatchObject({ ok: false, msg: expect.stringMatching(/rejected the credentials.*API key not valid/) });
    dbl.routes.set("/v1/models", (s) => (s.headers.authorization === "Bearer ok" ? [200, { data: [{ id: "gpt-5" }, { id: "whisper-1" }, { id: "dall-e-3" }, { id: "o3" }] }] : [401, {}]));
    expect(await discoverModels(http, tpl("openai"), { apiKey: "ok" })).toMatchObject({ ok: true, models: [{ upstream: "gpt-5" }, { upstream: "o3" }] });
    dbl.routes.set("/openai/deployments", (s) => (s.headers["api-key"] === "ak" && s.path.includes("api-version=2024-10-21") ? [200, { data: [{ id: "prod-gpt4o", model: "gpt-4o", status: "succeeded" }, { id: "broken", model: "gpt-4o", status: "failed" }] }] : [404, { error: { message: "no" } }]));
    expect(await discoverModels(http, tpl("azure-openai"), { endpoint: "https://r.openai.azure.com", apiKey: "ak", apiVersion: "2024-10-21" })).toMatchObject({ ok: true, models: [{ upstream: "prod-gpt4o", match: "gpt-4o" }] });
    // unreachable, empty and non-JSON answers come back as messages, never as exceptions
    const dead: OutboundHttp = { request: () => Promise.reject(new Error("socket hang up")) };
    expect(await discoverModels(dead, tpl("openai"), { apiKey: "x" })).toMatchObject({ ok: false, msg: expect.stringMatching(/Could not reach OpenAI/) });
    dbl.routes.set("/v1/models", () => [200, "<html>"]);
    expect(await discoverModels(http, tpl("openai"), { apiKey: "x" })).toMatchObject({ ok: false, msg: expect.stringMatching(/not with a model list/) });
  });

  it("the known-model catalogue recognises the same model across vendors", () => {
    expect(canonicalModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5");
    expect(canonicalModelId("models/gemini-2.5-pro")).toBe("gemini-2-5-pro");
    expect(knownModel("claude-opus-5-5")).toMatchObject({ inPrice: 5, outPrice: 25, name: "Claude Opus 5.5" });
    expect(knownModel("claude-sonnet-4-5-20250929")?.canonical).toBe("claude-sonnet-4-5");
    expect(knownModel("my-finetune")).toBeNull();
  });

  it("the egress allow-list for the worker includes a connected template vendor's hosts and a discovery's host for a few minutes", async () => {
    const hosts = (await t.app.inject({ method: "GET", url: "/internal/v1/egress/system", headers: EDGE })).json();
    const list: string[] = hosts.hosts ?? hosts;
    expect(list).toContain("bedrock.eu-west-1.amazonaws.com");
    expect(list).toContain("llm.example.com");
  });

  it("starter-kit agents' pinned models (claude-opus/sonnet/haiku-5-5) resolve to models discovered on Anthropic, and Bedrock's join them under the same canonical id", async () => {
    // A fresh install has no models: remove the dev seed's so the discovered ones take the canonical ids.
    await q(`delete from models where vendor_id in ('anthropic','bedrock')`);
    dbl.routes.set("/v1/models", () => [200, { data: ["opus", "sonnet", "haiku"].map((f) => ({ id: `claude-${f}-5-5-20260301`, display_name: `Claude ${f} 5.5` })), has_more: false }]);
    const a = await fromTemplate({ template: "anthropic", name: "Anthropic Fresh", fields: { apiKey: ANT_KEY } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const am = await modelsOf("anthropic-fresh");
    expect(am.map((m) => m.id).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(am.every((m) => m.enabled)).toBe(true);
    dbl.routes.set("/foundation-models", () => [200, { modelSummaries: ["opus", "sonnet", "haiku"].map((f) => ({ modelId: `anthropic.claude-${f}-5-5-20260301-v1:0`, modelName: `Claude ${f}`, providerName: "Anthropic", inputModalities: ["TEXT"], outputModalities: ["TEXT"] })) }]);
    dbl.routes.set("/inference-profiles", () => [200, { inferenceProfileSummaries: ["opus", "sonnet", "haiku"].map((f) => ({ inferenceProfileId: `us.anthropic.claude-${f}-5-5-20260301-v1:0`, inferenceProfileName: `US ${f}`, status: "ACTIVE" })) }]);
    const b = await fromTemplate({ template: "bedrock", name: "Bedrock Fresh", fields: { region: "us-east-1", accessKeyId: AWS_ID, secretAccessKey: AWS_SECRET } });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const bm = await modelsOf("bedrock-fresh");
    expect(bm).toHaveLength(6);
    expect(new Set(bm.map((m) => m.canonical))).toEqual(new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]));
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
      const r = (await w.call(ADMIN, "GET", `/api/v1/routing/resolve?station=build&model=${id}`)).body as any;
      expect(r.blocked, id).toBeNull();
      expect(r).toMatchObject({ model: id, vendor: "anthropic-fresh" });
    }
    // Bedrock is listed but cannot be called through the gateway yet, so it is not offered as a fallback.
    expect((await w.call(ADMIN, "GET", `/api/v1/routing/resolve?station=build&model=claude-sonnet-5-5`)).body.alternates).toEqual([]);
  });
});
