import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureBootstrapAdmin, startBootstrapAdmin, weakPasswordReason, type KeycloakAdminApi } from "../src/core/auth/bootstrap-admin.js";
import { keycloakAdminClient, keycloakFromIssuer } from "../src/core/auth/idp-admin.js";
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

describe("Keycloak admin client request shape (S-125: the scoped service account, never the master admin)", () => {
  const mk = () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/openid-connect/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 300 }), { status: 200 });
      if (url.includes("/credentials")) return new Response(JSON.stringify([{ id: "c0", type: "password" }, { id: "c1", type: "otp" }, { id: "c2", type: "recovery-authn-codes" }]), { status: 200 });
      if (init?.method === "POST" && url.endsWith("/users")) return new Response(null, { status: 201, headers: { location: "http://kc/idp/admin/realms/gantry/users/kc-id-1" } });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    return { calls, kc: keycloakAdminClient({ baseUrl: "http://kc/idp", realm: "gantry", clientId: "gantry-admin", clientSecret: "svc-secret", fetchImpl }) };
  };

  it("authenticates with client_credentials in the gantry realm: no master realm, no admin-cli, no password grant", async () => {
    const { calls, kc } = mk();
    await kc.secondFactors("u1");
    const tok = calls.find((c) => c.url.includes("/openid-connect/token"))!;
    expect(tok.url).toBe("http://kc/idp/realms/gantry/protocol/openid-connect/token");
    const body = new URLSearchParams(String(tok.init!.body));
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("gantry-admin");
    expect(body.get("password")).toBeNull();
    expect(calls.every((c) => !c.url.includes("/realms/master"))).toBe(true);
  });

  it("creates a user with a temporary password and the enrolment actions", async () => {
    const { calls, kc } = mk();
    expect(await kc.createUser({ username: "owner", password: PW, email: "o@corp.example", requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"] })).toBe("kc-id-1");
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/admin/realms/gantry/users"))!.init!.body));
    expect(body).toMatchObject({ username: "owner", enabled: true, email: "o@corp.example", requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"], credentials: [{ type: "password", value: PW, temporary: true }] });
  });

  it("a reset removes only second factors (never the password), ends provider sessions; a link names the actions and a short lifespan", async () => {
    const { calls, kc } = mk();
    expect(await kc.resetSecondFactors("u1")).toBe(2);
    const del = calls.filter((c) => c.init?.method === "DELETE").map((c) => c.url);
    expect(del).toEqual(["http://kc/idp/admin/realms/gantry/users/u1/credentials/c1", "http://kc/idp/admin/realms/gantry/users/u1/credentials/c2"]);
    expect(calls.some((c) => c.url.endsWith("/users/u1/logout"))).toBe(true);
    await kc.sendEnrolmentLink("u1");
    const link = calls.find((c) => c.url.includes("execute-actions-email"))!;
    expect(new URL(link.url).searchParams.get("lifespan")).toBe("3600");
    expect(JSON.parse(String(link.init!.body))).toEqual(["UPDATE_PASSWORD", "CONFIGURE_TOTP", "CONFIGURE_RECOVERY_AUTHN_CODES"]);
  });
});

const d = TEST_URL ? describe : describe.skip;

function fakeKc(existing: string | null = null) {
  const created: Array<{ username: string; password?: string; email?: string; requiredActions?: string[] }> = [];
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

  it("creates the user once when the org has no Factory Admin, with the enrolment actions, and records its subject", async () => {
    const { api, created } = fakeKc();
    expect(await run({ kc: api })).toBe("created");
    expect(created).toEqual([{ username: "owner", password: PW, requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP", "CONFIGURE_RECOVERY_AUTHN_CODES"] }]);
    expect(await sub()).toEqual({ username: "owner", sub: "kc-sub-1" });
    // a second run, or a changed secret, never creates or resets again
    expect(await run({ kc: api, password: "A-completely-different-1" })).toBe("already_provisioned");
    expect(created).toHaveLength(1);
  });

  it("S-122: the first enrolment is a one-time link to GANTRY_BOOTSTRAP_ADMIN_EMAIL, sent at creation and again on a restart until a second factor exists", async () => {
    const links: string[] = [];
    let factors = 0;
    const api = { ...fakeKc().api, async sendEnrolmentLink(id: string, o?: { lifespanSec?: number }) { links.push(`${id}:${o?.lifespanSec}`); }, async secondFactors() { return Array.from({ length: factors }, (_, i) => ({ id: `c${i}`, type: "otp" })); } };
    const withMail = (kc: typeof api) => ensureBootstrapAdmin({ pool: t.db.admin, orgId: t.orgId, username: "owner", email: "owner@corp.example", readPassword: async () => PW, keycloak: async () => kc, log: logs().log });
    expect(await withMail(api)).toBe("created");
    expect(links).toEqual(["kc-sub-1:3600"]);
    expect(await withMail(api)).toBe("already_provisioned"); // not enrolled yet: a fresh link
    expect(links).toHaveLength(2);
    factors = 1;
    expect(await withMail(api)).toBe("already_provisioned"); // enrolled: nothing more is sent
    expect(links).toHaveLength(2);
  });

  it("without an address no link is sent and the log says what to set", async () => {
    const l = logs();
    expect(await run({ log: l.log })).toBe("created");
    expect(l.lines.join("\n")).toMatch(/GANTRY_BOOTSTRAP_ADMIN_EMAIL/);
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

  it("without the service-account secret it does nothing; with no username it is disabled; a provider outage is retried", async () => {
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
    expect(sameName.cookies.find((c) => c.name === "__Host-gantry_session")).toBeTruthy(); // an ordinary person with no roles
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
