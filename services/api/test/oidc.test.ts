import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOidcAdapter } from "../src/core/oidc.js";
import { TEST_URL, startApp, testConfig, type TestApp } from "./helpers.js";
import { startIssuer } from "./issuer.js";

const d = TEST_URL ? describe : describe.skip;
const now = () => Math.floor(Date.now() / 1000);

type Issuer = Awaited<ReturnType<typeof startIssuer>>;

/** Publishes a new security version: the latest body with `patch` merged in. */
async function setSecurity(t: TestApp, patch: Record<string, unknown>): Promise<void> {
  const cur = (await t.db.admin.query(`select version, body from security_settings order by version desc limit 1`)).rows[0];
  await t.db.admin.query(`insert into security_settings (org_id, version, body, published_at) values ($1, $2, $3::jsonb, now())`, [t.orgId, cur.version + 1, JSON.stringify({ ...cur.body, ...patch })]);
  t.app.gantry.security.invalidate();
}

async function boot(issuer: Issuer, over: Parameters<typeof startApp>[0] = {}): Promise<TestApp> {
  const config = testConfig({ oidc: { issuer: issuer.issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "client-secret", githubIdpAlias: null }, ...over.config });
  return startApp({ ...over, config, build: { oidc: createOidcAdapter(config.oidc), ...over.build } });
}

/** Drives the browser through /auth/login -> provider -> /auth/callback. */
async function signInFlow(t: TestApp, issuer: Issuer, claims: Parameters<Issuer["authorize"]>[1], o: { query?: string; cookie?: string; state?: string } = {}) {
  const login = await t.app.inject(`/auth/login${o.query ?? ""}`);
  expect(login.statusCode).toBe(302);
  const stateCookie = login.cookies.find((c) => c.name === "gantry_oidc");
  expect(stateCookie).toBeTruthy();
  const cb = issuer.authorize(String(login.headers.location), claims, o.state ? { state: o.state } : {});
  const cookies = [`gantry_oidc=${stateCookie!.value}`, o.cookie].filter(Boolean).join("; ");
  const r = await t.app.inject({ url: cb, headers: { cookie: cookies } });
  return { login, cb, r, session: r.cookies.find((c) => c.name === "__Host-gantry_session") };
}

d("OIDC sign-in against a local issuer", () => {
  let issuer: Issuer;
  let t: TestApp;
  beforeAll(async () => {
    issuer = await startIssuer("gantry-web", "client-secret");
    t = await boot(issuer);
  });
  afterAll(async () => {
    await t.close();
    await issuer.close();
  });

  const asha = { sub: "kc-asha", email: "asha@acme.dev", email_verified: true, name: "Asha Raman", gantry_id: "p-asha" };

  it("login builds an auth-code + PKCE request and keeps state in a sealed, HTTP-only cookie", async () => {
    const r = await t.app.inject("/auth/login?login_hint=asha%40acme.dev");
    expect(r.statusCode).toBe(302);
    const u = new URL(String(r.headers.location));
    expect(u.origin).toBe(issuer.issuer);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("nonce")).toBeTruthy();
    expect(u.searchParams.get("login_hint")).toBe("asha@acme.dev");
    expect(u.searchParams.get("client_id")).toBe("gantry-web");
    expect(u.searchParams.get("redirect_uri")).toBe("https://gantry.test/auth/callback");
    // A named account forces the login form, so another person's SSO session at the provider cannot stand in for it.
    expect(u.searchParams.get("prompt")).toBe("login");
    const plain = new URL(String((await t.app.inject("/auth/login")).headers.location));
    expect(plain.searchParams.get("prompt")).toBeNull(); // a plain sign-in may reuse the provider's session
    const c = r.cookies.find((x) => x.name === "gantry_oidc")!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true });
    expect(c.value).not.toContain(u.searchParams.get("state")!); // sealed, not readable
  });

  it("callback links the seeded person by gantry_id, creates a session cookie and an auth.signin event; /me then works", async () => {
    const { r, session } = await signInFlow(t, issuer, { ...asha, auth_time: now() }, { query: "?login_hint=asha%40acme.dev" });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/");
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(session!.expires).toBeTruthy();
    const me = await t.app.inject({ url: "/api/v1/me", headers: { cookie: `__Host-gantry_session=${session!.value}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().person.id).toBe("p-asha");
    expect(me.json().session.method).toBe("sso");
    const p = (await t.db.admin.query(`select idp_subject, status from people where id = 'p-asha'`)).rows[0];
    expect(p).toEqual({ idp_subject: "kc-asha", status: "active" });
    const ev = (await t.db.admin.query(`select actor, category, outcome, session_id, source_ip from events where type = 'auth.signin' order by seq desc limit 1`)).rows[0];
    expect(ev).toMatchObject({ actor: "p-asha", category: "auth", outcome: "ok" });
    expect(ev.session_id).toBeTruthy();
    const si = (await t.db.admin.query(`select person_id, method, outcome from signins order by id desc limit 1`)).rows[0];
    expect(si).toEqual({ person_id: "p-asha", method: "sso", outcome: "ok" });
    // the stored session holds a hash, never the cookie value
    const row = (await t.db.admin.query(`select token_hash from sessions order by created_at desc limit 1`)).rows[0];
    expect(row.token_hash).not.toBe(session!.value);
    // the sign-in appears in GET /signins
    const hist = (await t.app.inject({ url: "/api/v1/signins", headers: { cookie: `__Host-gantry_session=${session!.value}` } })).json();
    expect(hist.items[0]).toMatchObject({ person: "p-asha", outcome: "success", email: "asha@acme.dev" });
  });

  it("a second sign-in with the same subject reuses the person", async () => {
    const before = (await t.db.admin.query(`select count(*)::int n from people`)).rows[0].n;
    const { session } = await signInFlow(t, issuer, { ...asha, auth_time: now() });
    expect(session).toBeTruthy();
    expect((await t.db.admin.query(`select count(*)::int n from people`)).rows[0].n).toBe(before);
  });

  it("first sign-in of an unknown person provisions them from claims, with no roles", async () => {
    const { session } = await signInFlow(t, issuer, { sub: "kc-new", email: "New.Person@acme.dev", email_verified: true, name: "New Person", gantry_title: "Intern" });
    expect(session).toBeTruthy();
    const p = (await t.db.admin.query(`select id, name, title, email, status from people where idp_subject = 'kc-new'`)).rows[0];
    expect(p).toMatchObject({ name: "New Person", title: "Intern", email: "new.person@acme.dev", status: "active" });
    expect(p.id).toMatch(/^p-new-person/);
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie: `__Host-gantry_session=${session!.value}` } })).json();
    expect(me.projects).toEqual([]);
    expect(me.person.roles).toEqual([]);
    expect((await t.db.admin.query(`select 1 from events where type = 'people.provisioned'`)).rowCount).toBe(1);
  });

  it("refuses: unverified email, missing email, unlisted domain, deactivated person, mismatched identity; each is recorded", async () => {
    const outcomes = async () => (await t.db.admin.query(`select outcome, reason from signins order by id desc limit 1`)).rows[0];
    let x = await signInFlow(t, issuer, { sub: "u1", email: "u1@acme.dev", email_verified: false });
    expect(x.session).toBeUndefined();
    expect(x.r.headers.location).toMatch(/^\/\?auth_error=/);
    expect(await outcomes()).toEqual({ outcome: "denied", reason: "email_unverified" });
    x = await signInFlow(t, issuer, { sub: "u2" });
    expect(await outcomes()).toEqual({ outcome: "denied", reason: "no_email" });
    // A provider that omits email_verified does not link or provision by address.
    x = await signInFlow(t, issuer, { sub: "u4", email: "u4@acme.dev" });
    expect(x.session).toBeUndefined();
    expect(await outcomes()).toEqual({ outcome: "denied", reason: "email_unverified" });

    await setSecurity(t, { domains: ["acme.dev"] });
    x = await signInFlow(t, issuer, { sub: "u3", email: "u3@evil.example", email_verified: true });
    expect(x.session).toBeUndefined();
    expect(decodeURIComponent(String(x.r.headers.location))).toContain("domain");
    expect(await outcomes()).toEqual({ outcome: "denied", reason: "domain_not_allowed" });

    await t.db.admin.query(`update people set status = 'deactivated' where id = 'p-tomas'`);
    x = await signInFlow(t, issuer, { sub: "kc-tomas", email: "tomas@acme.dev", email_verified: true, gantry_id: "p-tomas" });
    expect(x.session).toBeUndefined();
    expect(await outcomes()).toEqual({ outcome: "denied", reason: "account_inactive" });
    await t.db.admin.query(`update people set status = 'active' where id = 'p-tomas'`);

    await t.db.admin.query(`update people set idp_subject = 'someone-else' where id = 'p-tomas'`);
    x = await signInFlow(t, issuer, { sub: "kc-tomas", email: "tomas@acme.dev", email_verified: true, gantry_id: "p-tomas" });
    expect(await outcomes()).toEqual({ outcome: "denied", reason: "identity_mismatch" });
    const ev = (await t.db.admin.query(`select count(*)::int n from events where type = 'auth.signin' and outcome = 'denied'`)).rows[0].n;
    expect(ev).toBeGreaterThanOrEqual(5);
  });

  it("enforces the IP allow-list at sign-in", async () => {
    await setSecurity(t, { ipAllow: ["198.51.100.0/24"], domains: [] });
    const login = await t.app.inject("/auth/login");
    const cb = issuer.authorize(String(login.headers.location), { sub: "kc-ip", email: "ip@acme.dev", email_verified: true });
    const r = await t.app.inject({ url: cb, headers: { cookie: `gantry_oidc=${login.cookies[0]!.value}` }, remoteAddress: "203.0.113.50" });
    expect(r.cookies.find((c) => c.name === "__Host-gantry_session")).toBeUndefined();
    expect((await t.db.admin.query(`select reason from signins order by id desc limit 1`)).rows[0].reason).toBe("ip_not_allowed");
    await setSecurity(t, { ipAllow: [] });
  });

  it("rejects a wrong state, a missing state cookie, a replayed code, and a tampered cookie", async () => {
    const wrong = await signInFlow(t, issuer, { ...asha, auth_time: now() }, { state: "attacker-state" });
    expect(wrong.session).toBeUndefined();
    expect(String(wrong.r.headers.location)).toMatch(/auth_error/);

    const login = await t.app.inject("/auth/login");
    const cb = issuer.authorize(String(login.headers.location), { ...asha, auth_time: now() });
    const noCookie = await t.app.inject({ url: cb });
    expect(noCookie.cookies.find((c) => c.name === "__Host-gantry_session")).toBeUndefined();
    expect(String(noCookie.headers.location)).toMatch(/auth_error/);

    const ok = await t.app.inject({ url: cb, headers: { cookie: `gantry_oidc=${login.cookies[0]!.value}` } });
    expect(ok.cookies.find((c) => c.name === "__Host-gantry_session")).toBeTruthy();
    const replay = await t.app.inject({ url: cb, headers: { cookie: `gantry_oidc=${login.cookies[0]!.value}` } });
    expect(replay.cookies.find((c) => c.name === "__Host-gantry_session")).toBeUndefined();

    const l2 = await t.app.inject("/auth/login");
    const cb2 = issuer.authorize(String(l2.headers.location), { ...asha, auth_time: now() });
    const bad = l2.cookies[0]!.value.slice(0, -4) + "AAAA";
    const tampered = await t.app.inject({ url: cb2, headers: { cookie: `gantry_oidc=${bad}` } });
    expect(tampered.cookies.find((c) => c.name === "__Host-gantry_session")).toBeUndefined();
    expect((await t.db.admin.query(`select count(*)::int n from signins where outcome = 'failed'`)).rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it("return_to is honoured for local paths only", async () => {
    const ok = await signInFlow(t, issuer, { ...asha, auth_time: now() }, { query: "?return_to=%2Fapi%2Fx%23record" });
    expect(ok.r.headers.location).toBe("/api/x#record");
    const evil = await signInFlow(t, issuer, { ...asha, auth_time: now() }, { query: "?return_to=%2F%2Fevil.example" });
    expect(evil.r.headers.location).toBe("/");
    // browsers drop tabs and newlines and read "\\" as "/": each of these would land on evil.example
    for (const q of ["%2F%09%2Fevil.example", "%2F%0A%2Fevil.example", "%2F%5Cevil.example", "%2Fok%5C..%5C%5Cevil.example"]) {
      const r = await signInFlow(t, issuer, { ...asha, auth_time: now() }, { query: `?return_to=${q}` });
      expect(r.r.headers.location).toBe("/");
    }
  });

  it("GitHub method: refused with a clear auth_error when not configured; uses kc_idp_hint when configured", async () => {
    const r = await t.app.inject("/auth/login?method=github");
    expect(r.statusCode).toBe(302);
    expect(decodeURIComponent(String(r.headers.location))).toMatch(/^\/\?auth_error=GitHub sign-in is not set up/);
    expect(r.cookies.find((c) => c.name === "gantry_oidc")).toBeUndefined();

    const t2 = await boot(issuer, { config: { oidc: { issuer: issuer.issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "client-secret", githubIdpAlias: "github" } } });
    try {
      // still refused while Security has GitHub sign-in switched off
      await setSecurity(t2, { githubLogin: false });
      const off = await t2.app.inject("/auth/login?method=github");
      expect(String(off.headers.location)).toMatch(/auth_error/);
      await setSecurity(t2, { githubLogin: true });
      const on = await t2.app.inject("/auth/login?method=github");
      expect(new URL(String(on.headers.location)).searchParams.get("kc_idp_hint")).toBe("github");
      const { session } = await signInFlow(t2, issuer, { sub: "gh-1", email: "gh@acme.dev", email_verified: true }, { query: "?method=github" });
      expect(session).toBeTruthy();
      expect((await t2.db.admin.query(`select method from sessions order by created_at desc limit 1`)).rows[0].method).toBe("github");
    } finally {
      await t2.close();
    }
  });

  it("step-up: prompt=login, and the callback refreshes auth_time on the same session so a step-up command passes", async () => {
    const first = await signInFlow(t, issuer, { ...asha, auth_time: now() - 7200 });
    const cookie = `__Host-gantry_session=${first.session!.value}`;
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    const hdr = { cookie, "x-csrf-token": me.csrf };
    const cur = (await t.app.inject({ url: "/api/v1/security", headers: { cookie } })).json();
    const patch = () => t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { ...hdr, "if-match": String(cur.version) }, payload: { path: "idleMin", value: 25 } });
    const denied = await patch();
    expect(denied.statusCode).toBe(403);
    expect(denied.json().needs).toBe("step_up");

    const step = await signInFlow(t, issuer, { ...asha, auth_time: now() }, { query: "?step_up=1", cookie });
    expect(new URL(String(step.login.headers.location)).searchParams.get("prompt")).toBe("login");
    expect(step.session).toBeUndefined(); // same session kept, no new cookie
    expect(step.r.headers.location).toBe("/");
    expect((await t.db.admin.query(`select 1 from events where type = 'auth.stepup'`)).rowCount).toBe(1);
    const ok = await patch();
    expect(ok.statusCode).toBe(200);
  });

  it("step-up window is the security setting: 15 min by default, and a shorter or longer one is honoured with window and age in the refusal", async () => {
    const first = await signInFlow(t, issuer, { ...asha, auth_time: now() - 600 }); // 10 min ago
    const cookie = `__Host-gantry_session=${first.session!.value}`;
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    const hdr = { cookie, "x-csrf-token": me.csrf };
    const patch = async (path: string, value: unknown) => {
      const cur = (await t.app.inject({ url: "/api/v1/security", headers: { cookie } })).json();
      return t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { ...hdr, "if-match": String(cur.version) }, payload: { path, value } });
    };
    expect((await patch("idleMin", 26)).statusCode).toBe(200); // 10 min is inside the default 15
    await setSecurity(t, { stepUpWindowMinutes: 5 });
    const r = await patch("idleMin", 27);
    expect(r.statusCode).toBe(403);
    expect(r.json().rule).toMatchObject({ kind: "step-up", windowSec: 300 });
    expect(r.json().rule.signedInSecAgo).toBeGreaterThanOrEqual(600);
    await setSecurity(t, { stepUpWindowMinutes: 60 });
    expect((await patch("idleMin", 27)).statusCode).toBe(200);
    expect((await patch("stepUpWindowMinutes", 3)).statusCode).toBe(422); // allowed 5 to 60
    expect((await patch("stepUpWindowMinutes", 30)).statusCode).toBe(200);
    await setSecurity(t, { stepUpWindowMinutes: 15 });
  });

  it("popup step-up: the callback sends the popup to the app's result page, keeps the session and refreshes auth_time", async () => {
    const first = await signInFlow(t, issuer, { ...asha, auth_time: now() - 7200 });
    const cookie = `__Host-gantry_session=${first.session!.value}`;
    const step = await signInFlow(t, issuer, { ...asha, auth_time: now() }, { query: "?step_up=1&popup=1", cookie });
    expect(step.r.headers.location).toBe("/?step_up_popup=ok");
    expect(step.session).toBeUndefined();
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    const cur = (await t.app.inject({ url: "/api/v1/security", headers: { cookie } })).json();
    const ok = await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { cookie, "x-csrf-token": me.csrf, "if-match": String(cur.version) }, payload: { path: "idleMin", value: 30 } });
    expect(ok.statusCode).toBe(200);
  });

  it("popup is only honoured for a step-up; a different person's step-up is refused and does not switch the session", async () => {
    const first = await signInFlow(t, issuer, { ...asha, auth_time: now() - 7200 });
    const cookie = `__Host-gantry_session=${first.session!.value}`;
    const other = await signInFlow(t, issuer, { sub: "kc-daniel", email: "daniel@acme.dev", email_verified: true, name: "Daniel", gantry_id: "p-daniel", auth_time: now() }, { query: "?step_up=1&popup=1", cookie });
    expect(String(other.r.headers.location)).toMatch(/^\/\?step_up_popup=error&msg=/);
    expect(decodeURIComponent(String(other.r.headers.location))).toMatch(/different person/);
    expect(other.session).toBeUndefined();
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    expect(me.person.id).toBe("p-asha");
    const plain = await signInFlow(t, issuer, { ...asha, auth_time: now() }, { query: "?popup=1" });
    expect(plain.r.headers.location).toBe("/");
  });

  it("an invited person is claimed only with the invite link's one-time token, which works once", async () => {
    const { createHash } = await import("node:crypto");
    const token = "tok_" + "x".repeat(28);
    await t.db.admin.query(`insert into people (org_id, id, name, title, email, status) values ($1, 'p-nina', 'Nina Park', 'Invited', 'nina@acme.dev', 'invited')`, [t.orgId]);
    await t.db.admin.query(`insert into invites (org_id, id, email, token_hash, expires_at) values ($1, 'p-nina', 'nina@acme.dev', $2, now() + interval '1 day')`, [t.orgId, createHash("sha256").update(token).digest("hex")]);
    const nina = { sub: "kc-nina", email: "nina@acme.dev", email_verified: true, name: "Nina Park" };
    // the right address alone is refused, and the invitee stays unclaimed
    const bare = await signInFlow(t, issuer, { ...nina, auth_time: now() });
    expect(bare.session).toBeUndefined();
    expect(decodeURIComponent(String(bare.r.headers.location))).toContain("Open the invite link from your email");
    expect((await t.db.admin.query(`select idp_subject, status from people where id = 'p-nina'`)).rows[0]).toEqual({ idp_subject: null, status: "invited" });
    // a wrong token is refused too
    const wrong = await signInFlow(t, issuer, { ...nina, auth_time: now() }, { query: `?invite=${"y".repeat(32)}` });
    expect(wrong.session).toBeUndefined();
    // the invite link's token links and activates the person and spends the invite
    const ok = await signInFlow(t, issuer, { ...nina, auth_time: now() }, { query: `?invite=${token}&login_hint=nina%40acme.dev` });
    expect(ok.session).toBeTruthy();
    expect((await t.db.admin.query(`select idp_subject, status from people where id = 'p-nina'`)).rows[0]).toEqual({ idp_subject: "kc-nina", status: "active" });
    expect((await t.db.admin.query(`select status from invites where id = 'p-nina'`)).rows[0].status).toBe("accepted");
    // another identity replaying the same link gets nothing
    const replay = await signInFlow(t, issuer, { sub: "kc-mallory", email: "nina@acme.dev", email_verified: true, auth_time: now() }, { query: `?invite=${token}` });
    expect(replay.session).toBeUndefined();
  });

  it("logout also ends the provider session: it returns the end-session URL with the sealed ID token as the hint", async () => {
    const { r, session } = await signInFlow(t, issuer, { ...asha, auth_time: now() });
    const idt = r.cookies.find((c) => c.name === "gantry_idt");
    expect(idt).toMatchObject({ httpOnly: true, path: "/auth" });
    expect(idt!.value).not.toMatch(/^ey/); // sealed, not the raw JWT
    const cookie = `__Host-gantry_session=${session!.value}; gantry_idt=${idt!.value}`;
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    const out = (await t.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, "x-csrf-token": me.csrf } })).json();
    const u = new URL(out.logoutUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${issuer.issuer}/logout`);
    expect(u.searchParams.get("client_id")).toBe("gantry-web");
    expect(u.searchParams.get("post_logout_redirect_uri")).toMatch(/\/$/);
    expect(u.searchParams.get("id_token_hint")).toMatch(/^ey/);
  });

  it("logout needs the CSRF token, revokes the session, clears the cookie and records the event", async () => {
    const { session } = await signInFlow(t, issuer, { ...asha, auth_time: now() });
    const cookie = `__Host-gantry_session=${session!.value}`;
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    const signouts = async () => (await t.db.admin.query(`select 1 from events where type = 'auth.signout'`)).rowCount;
    const before = await signouts();
    const forged = await t.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(forged.statusCode).toBe(403);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(200); // still signed in
    const out = await t.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, "x-csrf-token": me.csrf } });
    expect(out.statusCode).toBe(200);
    expect(out.cookies.find((c) => c.name === "__Host-gantry_session")?.value).toBe("");
    expect(out.cookies.find((c) => c.name === "gantry_idt")?.value).toBe("");
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(401);
    expect(await signouts()).toBe(before! + 1);
    expect((await t.app.inject({ method: "POST", url: "/auth/logout" })).statusCode).toBe(200); // already signed out
  });
});

d("an empty org: bootstrap admin", () => {
  let issuer: Issuer;
  let t: TestApp;
  beforeAll(async () => {
    issuer = await startIssuer("gantry-web", "client-secret");
    t = await boot(issuer, { seed: false, config: { devSeed: false, bootstrapAdminEmail: "boss@corp.example" } });
  });
  afterAll(async () => {
    await t.close();
    await issuer.close();
  });

  it("starts with no people, projects or work, only built-in roles, the matrix and security settings", async () => {
    const n = async (tbl: string) => (await t.db.admin.query(`select count(*)::int n from ${tbl}`)).rows[0].n;
    expect(await n("people")).toBe(0);
    expect(await n("projects")).toBe(0);
    expect(await n("work_orders")).toBe(0);
    expect(await n("roles")).toBeGreaterThanOrEqual(9);
    expect(await n("role_matrix_versions")).toBe(1);
    expect(await n("security_settings")).toBe(1);
  });

  it("does not make the bootstrap email Factory Admin unless the provider verified it", async () => {
    // An unverified address does not sign in at all, so it can never claim the bootstrap Factory Admin.
    const unverified = await signInFlow(t, issuer, { sub: "boss-1", email: "boss@corp.example", name: "The Boss", auth_time: now() });
    expect(unverified.session).toBeUndefined();
    expect((await t.db.admin.query(`select 1 from role_assignments where role_id = 'factory_admin' and revoked_at is null`)).rowCount).toBe(0);
  });

  it("the first sign-in with the bootstrap email becomes Factory Admin; others get nothing", async () => {
    const boss = await signInFlow(t, issuer, { sub: "boss-1", email: "boss@corp.example", email_verified: true, name: "The Boss", auth_time: now() });
    const cookie = `__Host-gantry_session=${boss.session!.value}`;
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    expect(me.person.roles).toEqual([{ role: "factory_admin", scope: "factory" }]);
    expect(me.person.name).toBe("The Boss");
    const can = await t.app.inject({ method: "POST", url: "/api/v1/can", headers: { cookie, "x-csrf-token": me.csrf }, payload: { checks: [{ action: "project.create" }, { action: "people.manage" }] } });
    expect(can.json().results.map((r: { allowed: boolean }) => r.allowed)).toEqual([true, true]);

    const other = await signInFlow(t, issuer, { sub: "other-1", email: "other@corp.example", email_verified: true, name: "Other", auth_time: now() });
    // S-71: no sign-in domain list here, so a stranger is created as invited (pending approval) and gets no session until an admin approves.
    expect(other.session).toBeUndefined();
    expect((await t.db.admin.query(`select status from people where email = 'other@corp.example'`)).rows[0].status).toBe("invited");
    // a second sign-in of the bootstrap email does not grant again once an admin exists
    await t.db.admin.query(`update role_assignments set revoked_at = now()`);
    await t.db.admin.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type) select org_id, 'ra-x', id, 'factory_admin', 'factory' from people where email = 'other@corp.example'`);
    const again = await signInFlow(t, issuer, { sub: "boss-1", email: "boss@corp.example", email_verified: true, auth_time: now() });
    const me3 = (await t.app.inject({ url: "/api/v1/me", headers: { cookie: `__Host-gantry_session=${again.session!.value}` } })).json();
    expect(me3.person.roles).toEqual([]); // an admin exists (Other), so the bootstrap email is not granted again
  });
});
