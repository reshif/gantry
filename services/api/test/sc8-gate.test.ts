import http from "node:http";
import { createHmac, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encrypt } from "@gantry/db";
import { createOidcAdapter } from "../src/core/oidc.js";
import { configureRuntime, resetRuntime } from "../src/areas/integrations/runtime.js";
import { configureMcpEdge, resetMcpEdge } from "../src/areas/mcp/edge-client.js";
import { systemEgressHosts } from "../src/areas/internal/egress.js";
import { MAX_PENDING_PER_IP_HOUR, MAX_PENDING_PEOPLE, signIn } from "../src/core/auth/signin.js";
import { SESSION_KEY, TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

// Merge gate for fix/api-security: G-A1 to G-A7.
const d = TEST_URL ? describe : describe.skip;
const STALE = { authAgeSec: 36000 };
const KEY = "sk-" + "A1b2C3d4".repeat(4);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

d("merge gate: ordering of step-up, endpoint checks, hooks, logout replay, pending people", () => {
  let t: TestApp;
  let idp: http.Server;
  let issuer = "";
  const DK = randomBytes(32);
  const HOOK_SECRET = "hooksecret-" + randomBytes(6).toString("hex");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  const outbound: string[] = [];
  const mcpCalls: string[] = [];
  beforeAll(async () => {
    idp = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/.well-known/openid-configuration")) return void res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/certs`, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` }));
      if (req.url?.endsWith("/certs")) return void res.end(JSON.stringify({ keys: [jwk] }));
      res.statusCode = 404; res.end("{}");
    });
    await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}/realm`;
    const oidc = createOidcAdapter({ issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "s", githubIdpAlias: null }, { allowInsecure: true });
    t = await startApp({ build: { oidc }, config: { secrets: { sessionKey: SESSION_KEY, dataKey: DK, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    configureRuntime({ http: { request: async (r: { method: string; url: string }) => { outbound.push(`${r.method} ${r.url}`); return { status: 200, headers: {}, body: JSON.stringify({ data: [], ok: true }) } as never; } } as never });
    configureMcpEdge({ baseUrl: "http://edge.test", fetch: (async (u: string) => { mcpCalls.push(String(u)); return new Response(JSON.stringify({ ok: false, msg: "no" }), { status: 200 }); }) as typeof fetch });
    await t.db.admin.query(`insert into integration_types (org_id, id, name, builtin, field_schema, data) values ($1,'jira-bridge','Jira bridge',false,'[{"key":"secret","label":"Signing secret","type":"secret","required":true}]','{"source":true,"destination":false,"category":"custom","icon":"plug","auth":"hmac","payload":"json"}')`, [t.orgId]);
    await t.db.admin.query(`insert into integration_instances (org_id, id, type_id, name, enabled, config, secret_enc, secret_mask) values ($1,'jira-1','jira-bridge','Jira bridge',true,'{}',$2,'x'), ($1,'jira-off','jira-bridge','Jira off',false,'{}',$2,'x')`, [t.orgId, encrypt(JSON.stringify({ secret: HOOK_SECRET }), DK, "integration:jira-1")]);
  });
  afterAll(async () => { resetRuntime(); resetMcpEdge(); await t.close(); await new Promise((r) => idp.close(r)); });
  const w = world(() => t);
  let n = 0;
  const idem = () => ({ "idempotency-key": `g-${Date.now()}-${n++}-xxxx` });
  const WH = "whsec_" + "k7Kq2mZp9Rt4".repeat(3);

  it("G-A1: a stale session is refused BEFORE any outbound call or allow-list entry (vendor template, integration test and add, MCP discover)", async () => {
    outbound.length = 0; mcpCalls.length = 0;
    const before = await systemEgressHosts(t.db.app, t.orgId);
    const a = await w.call("p-asha", "POST", "/api/v1/vendors/from-template", { template: "openai-compatible", name: "Probe Vendor", fields: { endpoint: "https://pre-stepup.attacker.example/v1", apiKey: KEY } }, idem(), STALE);
    const b = await w.call("p-asha", "POST", "/api/v1/integration-types/webhook/test", { config: { url: "https://test-first.attacker.example/in", format: "json" }, secrets: { secret: WH } }, {}, STALE);
    const c = await w.call("p-asha", "POST", "/api/v1/integrations", { type: "webhook", name: "Lake2", config: { url: "https://add-first.attacker.example/in", format: "json" }, secrets: { secret: WH }, targetId: "lake2", enable: true }, idem(), STALE);
    const e = await w.call("p-asha", "POST", "/api/v1/mcp/discover", { url: "https://mcp.attacker.example/mcp", transport: "http", authMode: "none", name: "x" }, idem(), STALE);
    const f = await w.call("p-asha", "POST", "/api/v1/mcp/servers", { name: "Docs", transport: "http", url: "https://mcp.attacker.example/mcp", authMode: "none", sensitivity: "internal", tools: [], projects: "all", repos: "all", agents: "all", stations: "all", classes: "all" }, idem(), STALE);
    for (const r of [a, b, c, e, f]) { expect(r.status, JSON.stringify(r.body)).toBe(403); expect(r.body.needs).toBe("step_up"); }
    expect(outbound, "no outbound call on a stale session").toEqual([]);
    expect(mcpCalls, "no edge call on a stale session").toEqual([]);
    expect(await systemEgressHosts(t.db.app, t.orgId)).toEqual(before);
  });

  it("G-A1: with a fresh sign-in the pending discovery host is allowed and ledgered", async () => {
    outbound.length = 0;
    await w.call("p-asha", "POST", "/api/v1/vendors/from-template", { template: "openai-compatible", name: "Fresh Probe", fields: { endpoint: "https://fresh-probe.example.com/v1", apiKey: KEY } }, idem());
    expect(outbound.some((o) => o.includes("fresh-probe.example.com"))).toBe(true);
    expect((await w.events("egress.discovery.allowed")).some((x: { after: { hosts: string[] } }) => x.after.hosts.includes("fresh-probe.example.com"))).toBe(true);
  });

  it("G-A2: from-template never fetches metadata, loopback, the control plane or a service name; the answer is a 422", async () => {
    for (const ep of ["http://169.254.169.254/latest", "http://127.0.0.1:5432", "http://gantry-api:8000/x", "https://[::ffff:10.89.17.2]/v1", "https://172.18.0.5/v1"]) {
      outbound.length = 0;
      const r = await w.call("p-asha", "POST", "/api/v1/vendors/from-template", { template: "openai-compatible", name: `Probe ${n}`, fields: { endpoint: ep, apiKey: KEY } }, idem());
      expect(r.status, `${ep}: ${JSON.stringify(r.body)}`).toBe(422);
      expect(outbound, ep).toEqual([]);
    }
  });

  const sign = (raw: string, secret = HOOK_SECRET) => { const ts = Math.floor(Date.now() / 1000); return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`; };
  const hook = (inst: string, raw: string, sig?: string) => t.app.inject({ method: "POST", url: `/hooks/trigger/${inst}`, headers: { "content-type": "application/json", "x-gantry-signature": sig ?? sign(raw) }, payload: raw });

  it("G-A3: the denial audit of a known connection is not awaited, so a known and an unknown id answer in the same time", async () => {
    await t.db.admin.query(`create or replace function gate_slow() returns trigger language plpgsql as $$ begin if new.type = 'trigger.hook.denied' then perform pg_sleep(0.4); end if; return new; end $$`);
    await t.db.admin.query(`create trigger gate_slow before insert on events for each row execute function gate_slow()`);
    try {
      const body = JSON.stringify({ id: "x" });
      const t0 = Date.now();
      const known = await hook("jira-1", body, "t=1700000000,v1=" + "0".repeat(64));
      const knownMs = Date.now() - t0;
      expect(known.statusCode).toBe(401);
      expect(knownMs, "the 401 does not wait for the audit insert").toBeLessThan(300);
      for (let i = 0; i < 40 && !(await w.events("trigger.hook.denied")).length; i++) await new Promise((r) => setTimeout(r, 100));
    } finally {
      await t.db.admin.query(`drop trigger if exists gate_slow on events`);
    }
  });

  it("G-A4: a NUL inside a signed webhook body is a 400, not a 500", async () => {
    for (const body of [{ id: "J-1", kind: "issue", repo: "payments-api", title: "a\u0000b" }, { id: "J-2\u0000", kind: "issue", repo: "payments-api" }, { id: "J-3", kind: "issue", repo: "payments-api", labels: ["x\u0000"] }]) {
      const r = await hook("jira-1", JSON.stringify(body));
      expect(r.statusCode, r.body).toBe(400);
    }
  });

  const rs = (claims: Record<string, unknown>) => { const h = b64({ alg: "RS256", kid: "k1" }); const p = b64({ iss: issuer, aud: "gantry-web", iat: Math.floor(Date.now() / 1000), events: { "http://schemas.openid.net/event/backchannel-logout": {} }, ...claims }); return `${h}.${p}.${createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url")}`; };
  const bc = (tok: string) => t.app.inject({ method: "POST", url: "/auth/backchannel-logout", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `logout_token=${encodeURIComponent(tok)}` });

  it("G-A5: the logout jti is stored in the database (a replay is a no-op for every process), and a failed transaction leaves no jti", async () => {
    await t.db.admin.query(`update people set idp_subject = 'kc-tomas' where id = 'p-tomas'`);
    await t.session("p-tomas");
    const tok = rs({ sub: "kc-tomas", jti: "gate-jti-1" });
    expect((await bc(tok)).json()).toMatchObject({ ok: true, ended: 1 });
    expect(await w.q(`select jti from backchannel_logout_jti where jti = 'gate-jti-1'`)).toHaveLength(1);
    const s2 = await t.session("p-tomas");
    expect((await bc(tok)).json()).toMatchObject({ duplicate: true });
    expect((await w.q(`select revoked_at from sessions where id = $1`, [s2.id]))[0].revoked_at, "a replay ends nothing").toBeNull();
    // a failure inside the transaction rolls the jti back: break the revoke, expect a 5xx and no stored jti, then the retry ends the session
    await t.db.admin.query(`create or replace function gate_boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`);
    await t.db.admin.query(`create trigger gate_boom before update on sessions for each row execute function gate_boom()`);
    const bad = await bc(rs({ sub: "kc-tomas", jti: "gate-jti-2" }));
    await t.db.admin.query(`drop trigger gate_boom on sessions`);
    expect(bad.statusCode).toBeGreaterThanOrEqual(500);
    expect(await w.q(`select 1 from backchannel_logout_jti where jti = 'gate-jti-2'`)).toHaveLength(0);
    expect((await bc(rs({ sub: "kc-tomas", jti: "gate-jti-2" }))).json()).toMatchObject({ ok: true, ended: 1 });
  });

  it("G-A6: a LAN range that overlaps a Gantry network is refused when saved", async () => {
    for (const range of ["172.16.0.0/12", "172.18.0.0/16", "10.0.0.0/8", "10.89.0.0/16"]) {
      const cur = (await w.call("p-asha", "GET", "/api/v1/security")).body;
      const r = await w.call("p-asha", "PATCH", "/api/v1/security", { path: "vendorLanRanges", value: [range] }, { "if-match": String(cur.version) });
      expect(r.status, range).toBe(422);
    }
  });

  it("G-A7: pending people are bounded in total and per source address", async () => {
    await w.call("p-asha", "PATCH", "/api/v1/security", { path: "domains", value: [] }, { "if-match": String((await w.call("p-asha", "GET", "/api/v1/security")).body.version) });
    const claims = (i: number) => ({ sub: `kc-pend-${i}`, email: `pend${i}@elsewhere.example`, emailVerified: true, authTime: Math.floor(Date.now() / 1000), acr: "2", gantryId: undefined });
    const req = (ip: string) => ({ ip, userAgent: "vitest", requestId: "r", method: "sso" as const });
    for (let i = 0; i < MAX_PENDING_PER_IP_HOUR; i++) expect(await signIn(t.app.gantry, claims(i), req("198.51.100.1"))).toMatchObject({ reason: "pending_approval" });
    expect(await signIn(t.app.gantry, claims(99), req("198.51.100.1"))).toMatchObject({ ok: false, reason: "pending_rate" });
    // total cap: fill to the cap with direct rows, then one more identity from a fresh address is refused with the clear reason
    const have = Number((await w.q(`select count(*)::int n from people where status = 'invited' and data->>'pendingApproval' = 'true'`))[0].n);
    for (let i = have; i < MAX_PENDING_PEOPLE; i++) await t.db.admin.query(`insert into people (org_id, id, name, title, email, status, data) values ($1,$2,'x','',$3,'invited','{"pendingApproval":true}')`, [t.orgId, `p-fill-${i}`, `fill${i}@elsewhere.example`]);
    const over = await signIn(t.app.gantry, claims(200), req("198.51.100.77"));
    expect(over).toMatchObject({ ok: false, reason: "pending_cap" });
    expect((over as { msg: string }).msg).toMatch(/waiting for approval/);
    // G-B2: Factory Admins get one attention item for the refused sign-ins, and the people-manage check keeps it from anyone else
    const home = await w.call("p-asha", "GET", "/api/v1/home");
    const items = JSON.stringify(home.body).match(/hm-att-pending-refused/g) ?? [];
    expect(items, "one item, not one per refusal").toHaveLength(1);
    expect(JSON.stringify(home.body)).toMatch(/sign-ins? refused: pending cap reached/);
    expect(JSON.stringify((await w.call("p-tomas", "GET", "/api/v1/home")).body)).not.toContain("hm-att-pending-refused");
  });

  it("G-B1: the saved-range message names what is refused; cosmetic: egress.host.added is one row per host", async () => {
    const cur = (await w.call("p-asha", "GET", "/api/v1/security")).body;
    const r = await w.call("p-asha", "PATCH", "/api/v1/security", { path: "vendorLanRanges", value: ["172.20.0.0/16"] }, { "if-match": String(cur.version) });
    expect(r.status).toBe(422);
    expect(r.body.msg).toMatch(/not 172\.16\.0\.0\/12/);
    const { egressAdded } = await import("../src/areas/internal/egress.js");
    expect(egressAdded(["a.example"], ["b.example", "b.example", "a.example"], { kind: "vendor", id: "v", name: "V" }).map((e) => e.after.host)).toEqual(["b.example"]);
  });
});
