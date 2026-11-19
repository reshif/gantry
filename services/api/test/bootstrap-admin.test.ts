import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureBootstrapAdmin, keycloakAdminClient, keycloakFromIssuer, startBootstrapAdmin, weakPasswordReason, type KeycloakAdminApi } from "../src/core/auth/bootstrap-admin.js";
import { createOidcAdapter } from "../src/core/oidc.js";
import { TEST_URL, startApp, testConfig, type TestApp } from "./helpers.js";
import { startIssuer } from "./issuer.js";

const now = () => Math.floor(Date.now() / 1000);
const PW = "Correct-horse-battery-9";

describe("initial password rules", () => {
  it("refuses missing, short and well-known passwords, and accepts a strong one", () => {
    expect(weakPasswordReason(null, "owner")).toMatch(/missing or empty/);
    expect(weakPasswordReason("short", "owner")).toMatch(/shorter than 12/);
    for (const d of ["gantry-dev", "admin", "password", "Password1234", "PASSWORD", "administrator", "aaaaaaaaaaaaaa"]) expect(weakPasswordReason(d.padEnd(12, d.slice(-1)), "owner") ?? weakPasswordReason(d, "owner")).not.toBeNull();
    expect(weakPasswordReason("owner-owner-owner", "owner-owner-owner")).toMatch(/username/);
    expect(weakPasswordReason(PW, "owner")).toBeNull();
  });

  it("the Keycloak admin location comes from the issuer URL", () => {
    expect(keycloakFromIssuer("http://keycloak:8081/idp/realms/gantry")).toEqual({ baseUrl: "http://keycloak:8081/idp", realm: "gantry" });
    expect(keycloakFromIssuer("nonsense")).toBeNull();
  });
});

describe("Keycloak admin client request shape", () => {
  it("creates a user with a temporary password, both required actions and no email", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/openid-connect/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(null, { status: 201, headers: { location: "http://kc/idp/admin/realms/gantry/users/kc-id-1" } });
    }) as unknown as typeof fetch;
    const kc = keycloakAdminClient({ baseUrl: "http://kc/idp", realm: "gantry", adminUser: "admin", adminPassword: "adminpw", fetchImpl });
    expect(await kc.createUser({ username: "owner", password: PW, temporary: true, requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"] })).toBe("kc-id-1");
    const post = calls.find((c) => c.url.endsWith("/admin/realms/gantry/users"))!;
    const body = JSON.parse(String(post.init!.body));
    expect(body).toMatchObject({ username: "owner", enabled: true, requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"], credentials: [{ type: "password", value: PW, temporary: true }] });
    expect(body.email).toBeUndefined();
  });
});

const d = TEST_URL ? describe : describe.skip;

function fakeKc(existing: string | null = null) {
  const created: Array<{ username: string; password: string; temporary: boolean; requiredActions: string[] }> = [];
  const api: KeycloakAdminApi = {
    async findUserId() { return existing; },
    async createUser(u) { created.push(u); return "kc-sub-1"; },
  };
  return { api, created };
}
function logs() {
  const lines: string[] = [];
  return { lines, log: { info: (o: object, m?: string) => lines.push(JSON.stringify({ m, ...o })), warn: (o: object, m?: string) => lines.push(JSON.stringify({ m, ...o })) } };
}

d("bootstrap admin from a username and an initial password", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ seed: false, config: { devSeed: false } }); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await t.db.admin.query(`update role_assignments set revoked_at = now() where role_id = 'factory_admin' and revoked_at is null`);
    await t.db.admin.query(`update orgs set settings = settings - 'bootstrapAdmin'`);
  });
  const run = (o: { username?: string | null; password?: string | null; kc?: KeycloakAdminApi | null; log?: ReturnType<typeof logs>["log"] }) =>
    ensureBootstrapAdmin({ pool: t.db.admin, orgId: t.orgId, username: o.username === undefined ? "owner" : o.username, readPassword: async () => (o.password === undefined ? PW : o.password), keycloak: async () => (o.kc === undefined ? fakeKc().api : o.kc), log: o.log ?? logs().log });
  const sub = async () => (await t.db.admin.query(`select settings->'bootstrapAdmin' as b from orgs where id = $1`, [t.orgId])).rows[0]?.b;

  it("creates the user once when the org has no Factory Admin, temporary password and both required actions, and records its subject", async () => {
    const { api, created } = fakeKc();
    expect(await run({ kc: api })).toBe("created");
    expect(created).toEqual([{ username: "owner", password: PW, temporary: true, requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"] }]);
    expect(await sub()).toEqual({ username: "owner", sub: "kc-sub-1" });
    // a second run, or a changed secret, never creates or resets again
    expect(await run({ kc: api, password: "A-completely-different-1" })).toBe("already_provisioned");
    expect(created).toHaveLength(1);
  });

  it("never creates anything once a Factory Admin exists, and does not even read the secret", async () => {
    await t.db.admin.query(`insert into people (org_id, id, name, title, email, status) values ($1,'p-existing','Existing','','e@x.example','active')`, [t.orgId]);
    await t.db.admin.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, granted_by) values ($1,'ra-ex','p-existing','factory_admin','factory','system')`, [t.orgId]);
    const { api, created } = fakeKc();
    let read = false;
    const out = await ensureBootstrapAdmin({ pool: t.db.admin, orgId: t.orgId, username: "owner", readPassword: async () => { read = true; return PW; }, keycloak: async () => api, log: logs().log });
    expect(out).toBe("has_admin");
    expect(created).toHaveLength(0);
    expect(read).toBe(false);
    expect(await sub()).toBeNull();
  });

  it("refuses a missing, short or default password: no user created, the reason is logged, the password is not", async () => {
    for (const pw of [null, "", "short-pw", "gantry-dev", "password", "admin"]) {
      const { api, created } = fakeKc();
      const l = logs();
      expect(await run({ kc: api, password: pw, log: l.log })).toBe("refused");
      expect(created).toHaveLength(0);
      expect(l.lines.join("\n")).toMatch(/refused the initial password/);
      if (pw && pw.length > 8) expect(l.lines.join("\n")).not.toContain(pw);
    }
    expect(await sub()).toBeNull();
  });

  it("does not adopt a user that already exists at the identity provider", async () => {
    const { api, created } = fakeKc("someone-elses-id");
    expect(await run({ kc: api })).toBe("exists_not_ours");
    expect(created).toHaveLength(0);
    expect(await sub()).toBeNull();
  });

  it("without Keycloak admin credentials it does nothing; with no username it is disabled; a provider outage is retried", async () => {
    expect(await run({ kc: null })).toBe("unavailable");
    expect(await run({ username: null })).toBe("disabled");
    let n = 0;
    const flaky: KeycloakAdminApi = { async findUserId() { if (n++ < 2) throw new Error("connect ECONNREFUSED"); return null; }, async createUser() { return "kc-sub-1"; } };
    const out = await startBootstrapAdmin({ pool: t.db.admin, orgId: t.orgId, username: "owner", readPassword: async () => PW, keycloak: async () => flaky, log: logs().log }, { sleep: async () => {} });
    expect(out).toBe("created");
    expect(n).toBe(3);
  });

  it("never logs the password, including when the provider fails", async () => {
    const l = logs();
    const boom: KeycloakAdminApi = { async findUserId() { return null; }, async createUser(u) { throw new Error(`HTTP 500 for ${u.username}`); } };
    expect(await run({ kc: boom, log: l.log })).toBe("failed");
    expect(l.lines.join("\n")).not.toContain(PW);
    const ok = logs();
    await run({ log: ok.log });
    expect(ok.lines.join("\n")).not.toContain(PW);
  });
});

d("the first sign-in by the bootstrap user becomes Factory Admin", () => {
  let issuer: Awaited<ReturnType<typeof startIssuer>>;
  let t: TestApp;
  beforeAll(async () => {
    issuer = await startIssuer("gantry-web", "client-secret");
    const config = testConfig({ adminMfaOptional: false, devSeed: false, bootstrapAdminEmail: null, bootstrapAdminUsername: "owner", oidc: { issuer: issuer.issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "client-secret", githubIdpAlias: null } });
    t = await startApp({ seed: false, config, build: { oidc: createOidcAdapter(config.oidc) } });
    await ensureBootstrapAdmin({ pool: t.db.admin, orgId: t.orgId, username: "owner", readPassword: async () => PW, keycloak: async () => fakeKc().api, log: logs().log });
  });
  afterAll(async () => { await t.close(); await issuer.close(); });

  const signIn = async (claims: Parameters<typeof issuer.authorize>[1]) => {
    const login = await t.app.inject("/auth/login");
    const cb = issuer.authorize(String(login.headers.location), claims);
    return t.app.inject({ url: cb, headers: { cookie: `gantry_oidc=${login.cookies.find((c) => c.name === "gantry_oidc")!.value}` } });
  };
  const admins = async () => (await t.db.admin.query(`select person_id from role_assignments where role_id = 'factory_admin' and revoked_at is null`)).rows;

  it("is matched by the provider subject and username, not by email: an impostor with the owner's email or username but another subject gets nothing", async () => {
    const claimsAddress = await signIn({ sub: "other-sub", preferred_username: "x", email: "owner@bootstrap.invalid", email_verified: true, name: "Impostor", auth_time: now(), acr: "2" });
    expect(claimsAddress.cookies.find((c) => c.name === "__Host-gantry_session")).toBeUndefined();
    const sameName = await signIn({ sub: "other-sub-2", preferred_username: "owner", email: "imp@x.example", email_verified: true, name: "Impostor", auth_time: now(), acr: "2" });
    // S-71: with no sign-in domain list an ordinary stranger is created pending approval, with no session and no roles.
    expect(sameName.cookies.find((c) => c.name === "__Host-gantry_session")).toBeUndefined();
    expect((await t.db.admin.query(`select status from people where email = 'imp@x.example'`)).rows[0].status).toBe("invited");
    expect(await admins()).toHaveLength(0);
  });

  it("needs the second factor exactly as every Factory Admin does (no waiver), then is granted with an audit event", async () => {
    const owner = { sub: "kc-sub-1", preferred_username: "owner", name: "Owner", auth_time: now() }; // no email claim at all
    const weak = await signIn({ ...owner, acr: "1" });
    expect(weak.cookies.find((c) => c.name === "__Host-gantry_session")).toBeUndefined();
    expect(String(weak.headers.location)).toContain("auth_needs=mfa_setup");
    expect(await admins()).toHaveLength(0);
    const strong = await signIn({ ...owner, acr: "2" });
    expect(strong.cookies.find((c) => c.name === "__Host-gantry_session")).toBeTruthy();
    const rows = await admins();
    expect(rows).toHaveLength(1);
    const ev = (await t.db.admin.query(`select after from events where type = 'people.role_granted' and subject->>'id' = $1`, [rows[0].person_id])).rows;
    expect(ev.map((e) => e.after.reason)).toContain("bootstrap admin (username)");
    // and joins the Default team created with the organisation
    const teams = (await t.db.admin.query(`select team_id from team_members where person_id = $1`, [rows[0].person_id])).rows;
    expect(teams.map((r) => r.team_id)).toEqual(["default"]);
    // the next sign-in still works with no email, and a later different sub is never granted anything
    expect((await signIn({ ...owner, acr: "2" })).cookies.find((c) => c.name === "__Host-gantry_session")).toBeTruthy();
    await signIn({ sub: "late-sub", preferred_username: "owner", name: "Late", auth_time: now(), acr: "2", email: "late@x.example", email_verified: true });
    expect(await admins()).toHaveLength(1);
  });
});
