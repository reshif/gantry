import { devSeed } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const people = devSeed().state.people;
const admin = people.find((p) => p.roles.some((r) => r.role === "factory_admin"))!;
const plain = people.find((p) => p.id === "p-tomas")!;

d("core: sessions, CSRF, me, can, security", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  it("healthz pings the database", async () => {
    const r = await t.app.inject("/healthz");
    expect(r.statusCode).toBe(200);
  });

  it("signed-out /me is 401 with the public config the sign-in screen reads", async () => {
    const r = await t.app.inject("/api/v1/me");
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ ok: false, config: { demoAccounts: true } });
  });

  it("/me returns person, session, csrf, visible projects and factory state", async () => {
    const s = await t.session(admin.id);
    const r = await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(200);
    const me = r.json();
    expect(me.person).toMatchObject({ id: admin.id, email: admin.email });
    expect(me.person.roles).toEqual(admin.roles);
    expect(me.session).toMatchObject({ id: s.id, current: true, revoked: false });
    expect(me.csrf).toBe(s.csrf);
    expect(me.projects.length).toBe(devSeed().state.projects.length);
    expect(me.factory).toEqual({ killed: null });
  });

  it("a person sees only the projects they hold a role in", async () => {
    const s = await t.session(plain.id);
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie } })).json();
    const mine = new Set(plain.roles.map((r) => r.scope));
    expect(me.projects.map((p: { id: string }) => p.id).sort()).toEqual([...mine].sort());
  });

  it("rejects a state-changing request without or with a wrong CSRF token, accepts the bound one", async () => {
    const s = await t.session(admin.id);
    const call = (headers: Record<string, string>) => t.app.inject({ method: "POST", url: "/api/v1/can", headers: { cookie: s.cookie, ...headers }, payload: { checks: [] } });
    expect((await call({})).statusCode).toBe(403);
    expect((await call({ "x-csrf-token": "nope" })).statusCode).toBe(403);
    const other = await t.session(admin.id);
    expect((await call({ "x-csrf-token": other.csrf })).statusCode).toBe(403); // another session's token
    expect((await call({ "x-csrf-token": s.csrf })).statusCode).toBe(200);
    expect((await call({ "x-csrf-token": s.csrf, origin: "https://evil.example" })).statusCode).toBe(403);
  });

  it("revoked, expired and idle sessions are refused; the cookie is cleared", async () => {
    const s = await t.session(admin.id);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie } })).statusCode).toBe(200);
    await t.db.admin.query(`update sessions set revoked_at = now() where id = $1`, [s.id]);
    const r = await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(401);
    const idle = await t.session(admin.id);
    await t.db.admin.query(`update sessions set last_seen_at = now() - interval '2 hours' where id = $1`, [idle.id]);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: idle.cookie } })).statusCode).toBe(401);
    const old = await t.session(admin.id);
    await t.db.admin.query(`update sessions set expires_at = now() - interval '1 minute' where id = $1`, [old.id]);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: old.cookie } })).statusCode).toBe(401);
  });

  it("deactivating a person ends their sessions at the next request", async () => {
    const s = await t.session(plain.id);
    await t.db.admin.query(`update people set status = 'deactivated' where id = $1`, [plain.id]);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie } })).statusCode).toBe(401);
    await t.db.admin.query(`update people set status = 'active' where id = $1`, [plain.id]);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie } })).statusCode).toBe(401); // revoked, not merely paused
  });

  it("session list, revoke own session, and revoking another person's session needs security.manage", async () => {
    const a = await t.session(admin.id);
    const b = await t.session(plain.id);
    const list = (await t.app.inject({ url: "/api/v1/sessions", headers: { cookie: b.cookie } })).json();
    expect(list.every((x: { person: string }) => x.person === plain.id)).toBe(true);
    expect(list.map((x: { id: string }) => x.id)).toContain(b.id);
    expect(list.map((x: { id: string }) => x.id)).not.toContain(a.id);
    const denied = await t.app.inject({ method: "DELETE", url: `/api/v1/sessions/${a.id}`, headers: b.headers });
    expect(denied.statusCode).toBe(403);
    const own = await t.session(plain.id);
    const ok = await t.app.inject({ method: "DELETE", url: `/api/v1/sessions/${own.id}`, headers: b.headers });
    expect(ok.statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: own.cookie } })).statusCode).toBe(401);
    const byAdmin = await t.app.inject({ method: "DELETE", url: `/api/v1/sessions/${b.id}`, headers: a.headers });
    expect(byAdmin.statusCode).toBe(200);
    const ev = await t.db.admin.query(`select type, actor, outcome from events where type in ('session.revoked','security.manage.denied') order by seq`);
    expect(ev.rows.map((r) => `${r.type}:${r.actor}:${r.outcome}`)).toEqual([`security.manage.denied:${plain.id}:denied`, `session.revoked:${plain.id}:ok`, `session.revoked:${admin.id}:ok`]);
  });

  it("POST /can answers a batch in order, with reasons, from the same engine", async () => {
    const s = await t.session(plain.id);
    const project = plain.roles[0]!.scope;
    const r = await t.app.inject({
      method: "POST", url: "/api/v1/can", headers: s.headers,
      payload: { checks: [{ action: "project.view", project }, { action: "kill.factory" }, { action: "policy.edit" }, { action: "no.such.action" }] },
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().results;
    expect(res).toHaveLength(4);
    expect(res[0]).toMatchObject({ allowed: true });
    expect(res[1].allowed).toBe(false);
    expect(res[1].reason).toBeTruthy();
    expect(res[3].allowed).toBe(false);
    expect((await t.app.inject({ method: "POST", url: "/api/v1/can", headers: s.headers, payload: { checks: [{}] } })).statusCode).toBe(422);
  });

  it("API-key bearer auth: hashed key, scopes, and the principal kind", async () => {
    const { generateApiKey } = await import("../src/core/auth/apikeys.js");
    const k = generateApiKey();
    await t.db.admin.query(`insert into api_keys (org_id, id, name, project_id, key_hash, key_prefix, scopes) values ($1,'key-1','ci','payments',$2,$3,'["wo.submit"]')`, [t.orgId, k.hash, k.prefix]);
    const hdr = { authorization: `Bearer ${k.key}` };
    const ok = await t.app.inject({ method: "POST", url: "/api/v1/can", headers: hdr, payload: { checks: [{ action: "wo.submit", project: "payments" }, { action: "wo.submit", project: "storefront" }, { action: "gate.approve", project: "payments" }] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results.map((x: { allowed: boolean }) => x.allowed)).toEqual([true, false, false]);
    expect(ok.json().results[0].rule.kind).toBe("apikey");
    expect((await t.app.inject({ url: "/api/v1/me", headers: hdr })).statusCode).toBe(403); // keys are not browser sessions
    expect((await t.app.inject({ method: "POST", url: "/api/v1/can", headers: { authorization: "Bearer gk_bogus" }, payload: { checks: [] } })).statusCode).toBe(401);
    const stored = await t.db.admin.query(`select key_hash from api_keys where id = 'key-1'`);
    expect(JSON.stringify(stored.rows)).not.toContain(k.key);
    await t.db.admin.query(`update api_keys set revoked_at = now() where id = 'key-1'`);
    expect((await t.app.inject({ method: "POST", url: "/api/v1/can", headers: hdr, payload: { checks: [] } })).statusCode).toBe(401);
  });

  it("/internal/v1 needs a service token; product auth does not apply", async () => {
    const { internalRoutes } = await import("../src/routes/internal.js");
    expect(internalRoutes).toBeTypeOf("function");
    expect((await t.app.inject({ url: "/internal/v1/anything" })).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/internal/v1/anything", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const r = await t.app.inject({ url: "/internal/v1/anything", headers: { authorization: `Bearer ${t.config.secrets.edgeToken}` } });
    expect(r.statusCode).toBe(404); // authenticated; no such route yet
  });

  it("the IP allow-list is enforced on each request", async () => {
    const s = await t.session(admin.id);
    const sec = (await t.db.admin.query(`select body from security_settings order by version desc limit 1`)).rows[0].body;
    await t.db.admin.query(`insert into security_settings (org_id, version, body, published_at) select org_id, max(version) + 1, $1::jsonb, now() from security_settings group by org_id`, [JSON.stringify({ ...sec, ipAllow: ["198.51.100.0/24"] })]);
    t.app.gantry.security.invalidate();
    const r = await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie }, remoteAddress: "203.0.113.9" });
    expect(r.statusCode).toBe(403);
    const okip = await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie }, remoteAddress: "198.51.100.7" });
    expect(okip.statusCode).toBe(200);
    await t.db.admin.query(`insert into security_settings (org_id, version, body, published_at) select org_id, max(version) + 1, $1::jsonb, now() from security_settings group by org_id`, [JSON.stringify({ ...sec, ipAllow: [] })]);
    t.app.gantry.security.invalidate();
  });

  it("GET/PATCH /security: permission denied, stale version, step-up, success with before/after", async () => {
    const viewer = await t.session(plain.id);
    expect((await t.app.inject({ url: "/api/v1/security", headers: { cookie: viewer.cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: viewer.headers, payload: { path: "idleMin", value: 20 } })).statusCode).toBe(403);

    const old = await t.session(admin.id, { authAgeSec: 3600 });
    const cur = (await t.app.inject({ url: "/api/v1/security", headers: { cookie: old.cookie } })).json();
    expect(cur.version).toBeGreaterThan(0);
    const needStep = await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { ...old.headers, "if-match": String(cur.version) }, payload: { path: "idleMin", value: 20 } });
    expect(needStep.statusCode).toBe(403);
    expect(needStep.json()).toMatchObject({ ok: false, needs: "step_up" });

    const fresh = await t.session(admin.id);
    const stale = await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { ...fresh.headers, "if-match": String(cur.version - 1) }, payload: { path: "idleMin", value: 20 } });
    expect(stale.statusCode).toBe(409);
    const bad = await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { ...fresh.headers, "if-match": String(cur.version) }, payload: { path: "idleMin", value: -5 } });
    expect(bad.statusCode).toBe(422);
    const unknown = await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { ...fresh.headers, "if-match": String(cur.version) }, payload: { path: "nope.nothing", value: 1 } });
    expect(unknown.statusCode).toBe(422);
    const ok = await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { ...fresh.headers, "if-match": String(cur.version) }, payload: { path: "idleMin", value: 20 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, version: cur.version + 1 });
    const after = (await t.app.inject({ url: "/api/v1/security", headers: { cookie: fresh.cookie } })).json();
    expect(after.idleMin).toBe(20);
    const ev = (await t.db.admin.query(`select before, after, rule, session_id, request_id, channel from events where type = 'security.saved'`)).rows[0];
    expect(ev.before).toEqual({ idleMin: cur.idleMin });
    expect(ev.after).toMatchObject({ idleMin: 20 });
    expect(ev.session_id).toBe(fresh.id);
    expect(ev.request_id).toBeTruthy();
    expect(ev.channel).toBe("web");
    // an old version row is immutable: the previous version is intact
    const prev = await t.db.admin.query(`select body from security_settings where version = $1`, [cur.version]);
    expect(prev.rows[0].body.idleMin).toBe(cur.idleMin);
  });

  it("GET /catalog returns built-in and custom stations in stable order", async () => {
    const s = await t.session(admin.id);
    const c = (await t.app.inject({ url: "/api/v1/catalog", headers: { cookie: s.cookie } })).json();
    const seed = devSeed().catalog;
    expect(c.stations.map((x: { id: string }) => x.id)).toEqual(seed.stations.map((x) => x.id));
    expect(c.stations.map((x: { id: string }) => x.id)).toContain("compliance");
    expect(c.roles.map((x: { id: string }) => x.id)).toContain("compliance_officer");
    expect(c.actions.length).toBe(seed.actions.length);
    for (const k of ["gates", "bays", "classes"] as const) expect(c[k].length).toBe(seed[k].length);
  });
});
