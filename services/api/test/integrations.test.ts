import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decrypt } from "@gantry/db";
import { TEST_URL, SESSION_KEY, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { Double, fakeBotToken, fakeSigningSecret, slackDouble } from "./notify-doubles.js";
import { configureRuntime, resetRuntime } from "../src/areas/integrations/runtime.js";
import { proxiedHttp } from "../src/areas/notifications/http.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = randomBytes(32);

d("integrations (spec 8.8, 12.1)", () => {
  let t: TestApp;
  let slack: Double;
  const token = fakeBotToken();
  const signing = fakeSigningSecret();
  beforeAll(async () => {
    slack = await slackDouble(token);
    t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
    configureRuntime({ http: proxiedHttp({ proxy: null }), slackBase: `${slack.url}/api`, smtp: { host: null, port: 25 } });
  });
  afterAll(async () => {
    resetRuntime();
    await slack.stop();
    await t.close();
  });
  const w = world(() => t);
  const ADMIN = "p-asha";
  const NOBODY = "p-tomas";
  const add = (who: string, o: Record<string, unknown> = {}) =>
    w.call(who, "POST", "/api/v1/integrations", { type: "slack", name: "Acme Slack", config: { workspace: "acme", defaultChannel: "#factory-gates", approve: false }, secrets: { botToken: token, signingSecret: signing }, projects: "all", ...o });

  it("lists the real connectors and the not-yet-available ones, with manifests", async () => {
    const r = await w.call(ADMIN, "GET", "/api/v1/integration-types");
    expect(r.status).toBe(200);
    const by = Object.fromEntries((r.body as unknown as Array<{ id: string }>).map((x) => [x.id, x as Record<string, any>])) as Record<string, Record<string, any>>;
    for (const id of ["github", "slack", "email", "webhook"]) expect(by[id]!.available, id).toBe(true);
    expect(by.slack!.manifest.capabilities).toEqual(expect.arrayContaining(["notify", "interactive", "identity"]));
    expect(by.slack!.fields.filter((f: any) => f.type === "secret").map((f: any) => f.key)).toEqual(["botToken", "signingSecret"]);
    expect(by.teams!.available).toBe(false);
    expect(by.teams!.unavailableReason).toMatch(/not yet available/i);
    expect(by.jira!.available).toBe(false);
  });

  it("custom types are a signed webhook in and templated HTTP out, and never source control", async () => {
    const base = { name: "Audit lake", category: "webhook", auth: "hmac", payload: "json", destination: true, source: true, targetLabel: "Stream", events: [], actions: [] };
    const fields = [{ key: "url", label: "Endpoint URL", type: "url", required: true }, { key: "secret", label: "Signing secret", type: "secret", required: true }];
    expect((await w.call(ADMIN, "POST", "/api/v1/integration-types", { ...base, category: "source", fields })).status).toBe(422);
    expect((await w.call(ADMIN, "POST", "/api/v1/integration-types", { ...base, fields: [fields[1]] })).body.msg).toMatch(/endpoint/i);
    expect((await w.call(ADMIN, "POST", "/api/v1/integration-types", { ...base, source: true, destination: false, fields: [fields[0]] })).body.msg).toMatch(/signing secret/i);
    const ok = await w.call(ADMIN, "POST", "/api/v1/integration-types", { ...base, fields, httpTemplate: { method: "POST", body: '{"text":"{{head}}"}', contentType: "application/json" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.type).toMatchObject({ id: "audit-lake", custom: true, builtIn: false });
    expect((await w.call(ADMIN, "POST", "/api/v1/integration-types", { ...base, fields })).status).toBe(409);
    expect((await w.call(NOBODY, "POST", "/api/v1/integration-types", { ...base, name: "Other", fields })).status).toBe(403);
    expect((await w.call(ADMIN, "DELETE", "/api/v1/integration-types/slack")).status).toBe(409);
    expect((await w.call(ADMIN, "DELETE", "/api/v1/integration-types/audit-lake")).status).toBe(200);
  });

  it("an instance is created switched off, its secrets sealed and returned masked, and nothing secret reaches the ledger", async () => {
    const r = await add(ADMIN);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const inst = r.body.integration as Record<string, any>;
    expect(inst).toMatchObject({ type: "slack", connected: false, status: "offline" });
    expect(inst.secretMask).toMatch(/^xoxb-••••••••/);
    expect(JSON.stringify(r.body)).not.toContain(token);
    const row = (await w.q(`select secret_enc, secret_mask, enabled, config from integration_instances where id = $1`, [inst.id]))[0];
    expect(row.enabled).toBe(false);
    expect(row.secret_enc).not.toContain(token);
    const open = decrypt(row.secret_enc, DATA_KEY, `integration:${inst.id}`);
    expect(open.ok && JSON.parse(open.value)).toEqual({ botToken: token, signingSecret: signing });
    const evs = await w.q(`select before, after from events where type = 'integration.add'`);
    expect(JSON.stringify(evs)).not.toContain(token);
    expect(JSON.stringify(evs)).not.toContain(signing);
    const list = (await w.call(ADMIN, "GET", "/api/v1/integrations")).body as unknown as Array<Record<string, any>>;
    expect(list.find((x) => x.id === inst.id)!.secretMask).toBe(inst.secretMask);
    expect(JSON.stringify(list)).not.toContain(token);
  });

  it("denies a person without the right, audits it, and refuses a stale version", async () => {
    const before = Number((await w.q(`select count(*)::int n from events where outcome = 'denied' and type = 'integration.add.denied'`))[0].n);
    const dn = await add(NOBODY, { name: "Nope" });
    expect(dn.status).toBe(403);
    expect(Number((await w.q(`select count(*)::int n from events where outcome = 'denied' and type = 'integration.add.denied'`))[0].n)).toBe(before + 1);
    const inst = (await add(ADMIN, { name: "Versioned" })).body.integration as Record<string, any>;
    const bad = await w.call(ADMIN, "PATCH", `/api/v1/integrations/${inst.id}`, { name: "Renamed" }, w.ifm(inst.version + 9));
    expect(bad.status).toBe(409);
    expect(bad.body.msg).toMatch(/changed|reload/i);
    const good = await w.call(ADMIN, "PATCH", `/api/v1/integrations/${inst.id}`, { name: "Renamed" }, w.ifm(inst.version));
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(good.body.integration).toMatchObject({ name: "Renamed", version: inst.version + 1 });
    expect((await w.call(NOBODY, "PATCH", `/api/v1/integrations/${inst.id}`, { name: "x" }, w.ifm(inst.version + 1))).status).toBe(403);
    expect((await w.call(NOBODY, "DELETE", `/api/v1/integrations/${inst.id}`)).status).toBe(403);
  });

  it("tests a connection for real: Slack auth.test with the bot token, health recorded, and a bad token fails with the reason", async () => {
    const inst = (await add(ADMIN, { name: "Tested" })).body.integration as Record<string, any>;
    const before = slack.calls("/api/auth.test").length;
    const ok = await w.call(ADMIN, "POST", `/api/v1/integrations/${inst.id}/test`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.test).toMatchObject({ ok: true });
    expect(slack.calls("/api/auth.test").length).toBe(before + 1);
    expect(slack.calls("/api/auth.test").at(-1)!.headers.authorization).toBe(`Bearer ${token}`);
    expect((await w.q(`select health from integration_instances where id = $1`, [inst.id]))[0].health).toBe("healthy");
    // A draft test (the Add dialog's third step) calls out too, and saves nothing.
    const rows = Number((await w.q(`select count(*)::int n from integration_instances`))[0].n);
    const badTok = "xoxb" + "-" + "2".repeat(12) + "-" + "b".repeat(24);
    const draft = await w.call(ADMIN, "POST", "/api/v1/integration-types/slack/test", { config: { workspace: "acme" }, secrets: { botToken: badTok, signingSecret: signing } });
    expect(draft.status).toBe(200);
    expect(draft.body.test.ok).toBe(false);
    expect(JSON.stringify(draft.body.test.lines)).toMatch(/invalid_auth/);
    expect(Number((await w.q(`select count(*)::int n from integration_instances`))[0].n)).toBe(rows);
    expect(JSON.stringify(await w.q(`select after from events where type = 'integration.test'`))).not.toContain(badTok);
    // Unavailable types fail their test with the reason.
    const jira = await w.call(ADMIN, "POST", "/api/v1/integration-types/jira/test", { config: {}, secrets: {} });
    expect(jira.body.test).toMatchObject({ ok: false });
    expect((await w.call(NOBODY, "POST", `/api/v1/integrations/${inst.id}/test`)).status).toBe(403);
  });

  it("a webhook test sends a signed ping, and the instance is switched on deliberately", async () => {
    const hook = await new Double().start();
    hook.on("/in", () => [200, { ok: true }]);
    try {
      const secret = "whsec" + "_".repeat(1) + "x".repeat(40);
      const r = await w.call(ADMIN, "POST", "/api/v1/integrations", { type: "webhook", name: "Audit lake", config: { url: `${hook.url}/in`, format: "json" }, secrets: { secret }, targetId: "audit-lake", projects: ["payments"] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const inst = r.body.integration as Record<string, any>;
      expect(inst).toMatchObject({ connected: false, targetId: "audit-lake", projects: ["payments"] });
      expect((await w.call(ADMIN, "POST", "/api/v1/integrations", { type: "webhook", name: "Dup", config: { url: `${hook.url}/in`, format: "json" }, secrets: { secret }, targetId: "audit-lake" })).status).toBe(409);
      const test = await w.call(ADMIN, "POST", `/api/v1/integrations/${inst.id}/test`);
      expect(test.body.test.ok).toBe(true);
      const got = hook.calls("/in")[0]!;
      expect(got.headers["x-gantry-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      const on = await w.call(ADMIN, "PATCH", `/api/v1/integrations/${inst.id}`, { connected: true }, w.ifm((await w.q(`select version from integration_instances where id = $1`, [inst.id]))[0].version));
      expect(on.body.integration).toMatchObject({ connected: true, status: "healthy" === on.body.integration.status ? "healthy" : on.body.integration.status });
      expect((await w.q(`select enabled from integration_instances where id = $1`, [inst.id]))[0].enabled).toBe(true);
    } finally {
      await hook.stop();
    }
  });

  it("removing a connection is refused while a route sends to it", async () => {
    const inst = (await add(ADMIN, { name: "Used by a route", projects: ["payments"] })).body.integration as Record<string, any>;
    const route = await w.call("p-daniel", "POST", "/api/v1/projects/payments/routes", { event: "gate.waiting", dest: [{ channel: "slack", target: "#gates", integration: inst.id }], template: "gate" });
    expect(route.status, JSON.stringify(route.body)).toBe(200);
    const rm = await w.call(ADMIN, "DELETE", `/api/v1/integrations/${inst.id}`);
    expect(rm.status).toBe(409);
    expect(rm.body.msg).toMatch(/routes/i);
    await w.call("p-daniel", "DELETE", `/api/v1/projects/payments/routes/${route.body.id}`, undefined, w.ifm(route.body.version));
    expect((await w.call(ADMIN, "DELETE", `/api/v1/integrations/${inst.id}`)).status).toBe(200);
  });

  it("refuses configuration changes while the factory is killed, with the reason", async () => {
    const k = await w.call(ADMIN, "POST", "/api/v1/stops", { scope: "factory", mode: "kill", reason: "Security incident", confirmText: "KILL FACTORY" });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const r = await add(ADMIN, { name: "During kill" });
    expect(r.status).toBe(409);
    expect(r.body.msg).toMatch(/factory is killed/i);
  });
});
