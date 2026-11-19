// The MFA review (statechart S-120..S-130), replayed on the real API: everyone needs a second factor, a step-up re-asks it and is fresh,
// an authenticator reset goes through Gantry (ledger, sessions ended, one-time link), and a reset done at the identity provider is noticed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { needsStepUp } from "@gantry/domain";
import { createOidcAdapter } from "../src/core/oidc.js";
import type { IdpAdmin, IdpAdminEvent, IdpCredential } from "../src/core/auth/idp-admin.js";
import { SESSION_KEY, TEST_URL, startApp, testConfig, type TestApp } from "./helpers.js";
import { startIssuer } from "./issuer.js";

const now = () => Math.floor(Date.now() / 1000);
type Issuer = Awaited<ReturnType<typeof startIssuer>>;
const d = TEST_URL ? describe : describe.skip;

/** The id Keycloak gives the gantry-admin service-account user: what `authDetails.userId` of Gantry's own events carries. */
const SVC_USER = "6e206e9b-0fcb-491b-8071-1a2d0d54d827";
/** The client's INTERNAL id: what `authDetails.clientId` really carries in a Keycloak 26.4.7 admin event (probed), never the string "gantry-admin". */
const SVC_CLIENT_UUID = "acb40f19-f82f-4c53-9210-8f34af3d3329";

/** An identity provider the API can administer: records what Gantry asks of it. */
function fakeIdp(): IdpAdmin & { calls: string[]; creds: Map<string, IdpCredential[]>; failLink: boolean; failReset: boolean; events: IdpAdminEvent[]; incomplete: boolean } {
  const calls: string[] = [];
  const creds = new Map<string, IdpCredential[]>();
  const users = new Map<string, { id: string; username: string; email: string | null }>();
  const fake = {
    calls, creds, failLink: false, failReset: false, incomplete: false, events: [] as IdpAdminEvent[],
    async findUser(q: { username?: string; email?: string }) { return [...users.values()].find((u) => (q.username && u.username === q.username) || (q.email && u.email === q.email)) ?? null; },
    async findUserId(username: string) { return (await fake.findUser({ username }))?.id ?? null; },
    async createUser(u: { username: string; email?: string }) { const id = `kc-${u.username}`; users.set(id, { id, username: u.username, email: u.email ?? null }); calls.push(`create:${u.username}`); return id; },
    async secondFactors(id: string) { return creds.get(id) ?? []; },
    async resetSecondFactors(id: string, only?: string[]) { if (fake.failReset) throw new Error("provider refused"); const held = (creds.get(id) ?? []).filter((c) => !only || only.includes(c.id)); creds.set(id, (creds.get(id) ?? []).filter((c) => !held.includes(c))); calls.push(`reset:${id}`, `logout:${id}`); return held.length; }, // the real client also ends the provider sessions
    async credentialEvents(since: number) { return { events: fake.events.filter((e) => e.time > since), complete: !fake.incomplete }; },
    async serviceAccountUserId() { return SVC_USER; },
    async sendEnrolmentLink(id: string, o?: { lifespanSec?: number }) { if (fake.failLink) throw new Error("smtp down"); calls.push(`link:${id}:${o?.lifespanSec}`); },
    async endSessions(id: string) { calls.push(`logout:${id}`); },
  };
  return fake;
}

d("MFA for everyone (S-120..S-130)", () => {
  let issuer: Issuer;
  let t: TestApp;
  let idp: ReturnType<typeof fakeIdp>;
  const oidcCfg = () => ({ issuer: issuer.issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "client-secret", githubIdpAlias: null });
  beforeAll(async () => {
    issuer = await startIssuer("gantry-web", "client-secret");
    idp = fakeIdp();
    const config = testConfig({ adminMfaOptional: false, oidc: oidcCfg(), secrets: { sessionKey: SESSION_KEY, dataKey: Buffer.alloc(32, 7), edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } });
    t = await startApp({ config, build: { oidc: createOidcAdapter(config.oidc), idpAdmin: idp } });
  });
  afterAll(async () => { await t.close(); await issuer.close(); });

  const daniel = { sub: "kc-daniel", email: "daniel@acme.dev", email_verified: true, gantry_id: "p-daniel" };
  const asha = { sub: "kc-asha", email: "asha@acme.dev", email_verified: true, gantry_id: "p-asha" };
  const tomas = { sub: "kc-tomas", email: "tomas@acme.dev", email_verified: true, gantry_id: "p-tomas" };
  async function flow(claims: Parameters<Issuer["authorize"]>[1], query = "", cookie?: string) {
    const login = await t.app.inject({ url: `/auth/login${query}`, ...(cookie ? { headers: { cookie } } : {}) });
    const st = login.cookies.find((c) => c.name === "gantry_oidc")!;
    const cb = issuer.authorize(String(login.headers.location), claims);
    const r = await t.app.inject({ url: cb, headers: { cookie: [`gantry_oidc=${st.value}`, cookie].filter(Boolean).join("; ") } });
    return { login, r, session: r.cookies.find((c) => c.name === "__Host-gantry_session") };
  }
  const post = async (cookie: string, url: string, payload: unknown, method: "POST" | "PATCH" | "PUT" = "POST") => {
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    return t.app.inject({ method, url, payload: payload as object, headers: { cookie, "x-csrf-token": me.csrf, "idempotency-key": `r-${Math.random()}` } });
  };
  const cookieOf = (x: { session?: { value: string } }) => `__Host-gantry_session=${x.session!.value}`;

  /* ---- S-121: everyone, every sign-in, every step-up */

  it("S-121: a person who is not an admin is refused with only a password, and admitted with a second factor", async () => {
    const weak = await flow({ ...daniel, auth_time: now(), acr: "1" });
    expect(weak.session).toBeUndefined();
    expect(String(weak.r.headers.location)).toContain("auth_needs=mfa_setup");
    expect((await t.db.admin.query(`select reason from signins where outcome = 'denied' order by id desc limit 1`)).rows[0].reason).toBe("mfa_required");
    expect((await flow({ ...tomas, auth_time: now(), acr: "1" })).session).toBeUndefined();
    expect((await flow({ ...daniel, auth_time: now(), acr: "2" })).session).toBeTruthy();
    expect((await flow({ ...tomas, auth_time: now(), amr: ["pwd", "otp"] })).session).toBeTruthy();
    expect((await flow({ ...tomas, auth_time: now(), amr: ["pwd", "webauthn"] })).session).toBeTruthy();
  });

  it("S-121: every sign-in and every step-up asks the provider for the second-factor level, and never rides an old provider session", async () => {
    for (const q of ["", "?step_up=1", "?mfa=1", "?login_hint=daniel"]) {
      const u = new URL(String((await t.app.inject(`/auth/login${q}`)).headers.location));
      expect(u.searchParams.get("acr_values"), q).toBe("2");
      expect(u.searchParams.get("prompt"), q).toBe("login"); // S-130: no silent re-login from the provider's own session
    }
    const step = new URL(String((await t.app.inject("/auth/login?step_up=1")).headers.location));
    expect(step.searchParams.get("max_age")).toBe("0");
  });

  it("S-121: a stored session without the factor is refused for a non-admin too (a person admitted before this rule, or one of the waived era)", async () => {
    const s = await t.session("p-tomas"); // createSession without a second factor
    const r = await t.app.inject({ url: "/api/v1/me", headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ ok: false, needs: "mfa_setup", rule: { id: "MFA" } });
    expect(r.json().msg).toMatch(/everyone/i);
  });

  it("S-121: a step-up with only a password is refused, leaves the session as it was, and cannot mint a key", async () => {
    const cookie = (await t.session("p-daniel", { authAgeSec: 4000, secondFactor: true })).cookie; // a two-factor session whose sign-in is old
    const body = { name: "mfa probe", project: "payments", actions: ["wo.read"] };
    expect((await post(cookie, "/api/v1/api-keys", body)).json().needs).toBe("step_up");
    const weak = await flow({ ...daniel, auth_time: now(), acr: "1" }, "?step_up=1", cookie);
    expect(String(weak.r.headers.location)).toContain("auth_needs=mfa_setup");
    expect((await post(cookie, "/api/v1/api-keys", body)).json().needs).toBe("step_up");
    const ok = await flow({ ...daniel, auth_time: now(), acr: "2" }, "?step_up=1", cookie);
    expect(ok.r.headers.location).toBe("/");
    expect((await post(cookie, "/api/v1/api-keys", body)).statusCode).toBe(200);
  });

  it("S-121: API keys are not people: a key works without any session factor", async () => {
    const x = await flow({ ...daniel, auth_time: now(), acr: "2" });
    const made = await post(cookieOf(x), "/api/v1/api-keys", { name: "ci", project: "payments", actions: ["wo.read"] });
    expect(made.statusCode, made.body).toBe(200);
    const key = made.json().secret;
    expect(typeof key).toBe("string");
    const r = await t.app.inject({ url: "/api/v1/can", method: "POST", payload: { checks: [] }, headers: { authorization: `Bearer ${key}` } });
    expect(r.statusCode).toBe(200);
  });

  /* ---- S-129: the sign-in time is never assumed */

  it("S-129: a token without auth_time is refused at sign-in and at step-up; a step-up with an old one is refused", async () => {
    expect((await flow({ ...daniel, acr: "2" })).session).toBeUndefined(); // no auth_time claim: the sign-in time is unknown
    const cookie = (await t.session("p-daniel", { authAgeSec: 4000, secondFactor: true })).cookie;
    const noTime = await flow({ ...daniel, acr: "2" }, "?step_up=1", cookie);
    expect(String(noTime.r.headers.location)).toContain("auth_error");
    const old = await flow({ ...daniel, auth_time: now() - 4000, acr: "2" }, "?step_up=1", cookie);
    expect(String(old.r.headers.location)).toContain("auth_error");
    expect((await post(cookie, "/api/v1/api-keys", { name: "k", project: "payments", actions: ["wo.read"] })).json().needs).toBe("step_up");
    expect((await flow({ ...daniel, auth_time: now(), acr: "2" }, "?step_up=1", cookie)).r.headers.location).toBe("/");
  });

  it("G-M4: a sign-in whose auth_time is older than the authorize request (a silent provider session, prompt=login stripped) creates no session", async () => {
    const old = await flow({ ...daniel, auth_time: now() - 600, acr: "2" });
    expect(old.session).toBeUndefined();
    expect(String(old.r.headers.location)).toContain("auth_error");
    expect((await t.db.admin.query(`select reason from signins where outcome = 'denied' order by id desc limit 1`)).rows[0].reason).toBe("stale_auth");
    expect((await flow({ ...daniel, auth_time: now() - 2, acr: "2" })).session).toBeTruthy(); // a login a moment before the callback is fine
  });

  /* ---- S-123: the step-up list is only what exists (plus another agent's vendor/integration/MCP edits); no gate, budget, trust or merge */

  it("S-123: no step-up was added for gate overrides, budget, trust or merge", () => {
    for (const a of ["gate.approve", "project.config", "trust.grant", "onboarding.merge", "release"]) expect(needsStepUp(a), a).toBe(false);
  });

  /* ---- S-127: the real policy and the real per-person status */

  it("S-127: people.mfa is recorded at sign-in, and the security settings tell the truth (everyone; no dead choices)", async () => {
    await flow({ sub: "kc-newbie", email: "newbie@acme.dev", email_verified: true, name: "New Bie", auth_time: now(), acr: "2" });
    expect((await t.db.admin.query(`select mfa from people where email = 'newbie@acme.dev'`)).rows[0].mfa).toBe(true);
    const x = await flow({ ...asha, auth_time: now(), acr: "2" });
    const sec = (await t.app.inject({ url: "/api/v1/security", headers: { cookie: cookieOf(x) } })).json();
    expect(sec.mfa).toMatchObject({ policy: "everyone", required: true, waived: false });
    expect(sec.mfa.methods).toEqual(["totp", "webauthn", "recovery"]);
    const patch = await post(cookieOf(x), "/api/v1/security", { path: "mfa.policy", value: "nobody" }, "PATCH");
    expect(patch.statusCode).toBeGreaterThanOrEqual(400);
    expect((await t.app.inject({ url: "/api/v1/security", headers: { cookie: cookieOf(x) } })).json().mfa.policy).toBe("everyone");
  });

  /* ---- S-130: sign out of the provider too */

  it("S-130: signing out always goes to the provider's end-session, even when the id-token cookie is gone", async () => {
    const x = await flow({ ...asha, auth_time: now(), acr: "2" });
    const cookie = cookieOf(x);
    const me = (await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).json();
    const out = await t.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, "x-csrf-token": me.csrf } }); // no gantry_idt cookie sent
    const url = new URL(out.json().logoutUrl);
    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("client_id")).toBe("gantry-web");
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(401);
    const anon = await t.app.inject({ method: "POST", url: "/auth/logout" }); // nothing at all: still ends the provider session
    expect(anon.json().logoutUrl).toContain("/logout");
  });

  /* ---- S-124: reset through Gantry, and a reset behind Gantry's back */

  it("S-124: an authenticator reset is a People action: step-up, reason, not for oneself, ledger, sessions ended, one-time link", async () => {
    const admin = await flow({ ...asha, auth_time: now(), acr: "2" });
    const adminCookie = cookieOf(admin);
    const victim = await flow({ ...daniel, auth_time: now(), acr: "2" });
    const victimCookie = cookieOf(victim);
    idp.creds.set("kc-daniel", [{ id: "c1", type: "otp" }, { id: "c2", type: "webauthn" }]);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: victimCookie } })).statusCode).toBe(200);
    await idp.createUser({ username: "daniel", email: "daniel@acme.dev" });
    const url = "/api/v1/people/p-daniel/mfa-reset";

    expect((await post(adminCookie, url, { reason: "x" })).statusCode).toBe(422); // a reason is required
    expect((await post(adminCookie, "/api/v1/people/p-asha/mfa-reset", { reason: "lost phone, myself" })).statusCode).toBeGreaterThanOrEqual(400); // not for oneself
    const stale = await t.session("p-asha", { authAgeSec: 4000, secondFactor: true });
    expect((await post(stale.cookie, url, { reason: "lost phone" })).json().needs).toBe("step_up");
    expect(idp.calls.filter((c) => c.startsWith("reset"))).toEqual([]);

    const r = await post(adminCookie, url, { reason: "lost phone, verified by video call" });
    expect(r.statusCode, r.body).toBe(200);
    expect(idp.calls).toEqual(expect.arrayContaining(["reset:kc-daniel", expect.stringMatching(/^link:kc-daniel:\d+$/), "logout:kc-daniel"]));
    expect(idp.calls.findIndex((c) => c.startsWith("link:kc-daniel"))).toBeLessThan(idp.calls.findIndex((c) => c === "reset:kc-daniel")); // G-M6: the link first
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: victimCookie } })).statusCode).toBe(401); // sessions ended
    const ev = (await t.db.admin.query(`select actor, after from events where type = 'people.mfa_reset' order by id desc limit 1`)).rows[0];
    expect(ev.actor).toBe("p-asha");
    expect(ev.after).toMatchObject({ reason: "lost phone, verified by video call", removed: 2 });
    expect((await t.db.admin.query(`select mfa from people where id = 'p-daniel'`)).rows[0].mfa).toBe(false);
  });

  it("S-122: an invite also sends the person the provider's one-time enrolment link, creating their provider user with no password; a failed link never fails the invite", async () => {
    const admin = await flow({ ...asha, auth_time: now(), acr: "2" });
    const r = await post(cookieOf(admin), "/api/v1/invites", { name: "Nia Okoro", email: "nia@acme.dev" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().enrolment).toEqual({ sent: true });
    expect(idp.calls).toEqual(expect.arrayContaining(["create:nia@acme.dev", expect.stringMatching(/^link:kc-nia@acme.dev:3600$/)]));
    idp.failLink = true;
    const bad = await post(cookieOf(admin), "/api/v1/invites", { name: "Obi Eze", email: "obi@acme.dev" });
    idp.failLink = false;
    expect(bad.statusCode).toBe(200);
    expect(bad.json().enrolment).toMatchObject({ sent: false });
    expect(bad.json().enrolment.reason).toMatch(/Reset authenticator/);
  });

  it("G-M6: when the one-time link cannot be sent the reset changes nothing and answers 409 with the reason; when only the removal fails the sessions still end and the ledger says so", async () => {
    const admin = await flow({ ...asha, auth_time: now(), acr: "2" });
    await idp.createUser({ username: "priya", email: "priya@acme.dev" });
    idp.creds.set("kc-priya", [{ id: "pr1", type: "otp" }]);
    const victim = await flow({ ...tomas, auth_time: now(), acr: "2" }); // a second person, to see the sessions
    await idp.createUser({ username: "tomas", email: "tomas@acme.dev" });
    idp.creds.set("kc-tomas", [{ id: "t1", type: "otp" }]);
    idp.failLink = true;
    const bad = await post(cookieOf(admin), "/api/v1/people/p-tomas/mfa-reset", { reason: "lost phone, link down" });
    idp.failLink = false;
    expect(bad.statusCode).toBe(409);
    expect(bad.json().msg).toMatch(/link could not be sent.*nothing was changed/i);
    expect(idp.creds.get("kc-tomas")).toHaveLength(1); // factors untouched
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: cookieOf(victim) } })).statusCode).toBe(200); // session untouched
    expect((await t.db.admin.query(`select count(*)::int n from events where type = 'people.mfa_reset' and after->>'reason' = 'lost phone, link down'`)).rows[0].n).toBe(0);
    idp.failReset = true;
    const half = await post(cookieOf(admin), "/api/v1/people/p-tomas/mfa-reset", { reason: "lost phone, removal fails" });
    idp.failReset = false;
    expect(half.statusCode, half.body).toBe(200);
    expect(half.json().msg).toMatch(/did not remove/i);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: cookieOf(victim) } })).statusCode).toBe(401); // sessions ended anyway
    const ev = (await t.db.admin.query(`select after from events where type = 'people.mfa_reset' and after->>'reason' = 'lost phone, removal fails'`)).rows[0];
    expect(ev.after).toMatchObject({ linkSent: true, factorRemovalFailed: "provider refused" });
  });

  it("G-M5: only a Factory Admin resets a Factory Admin's authenticator; a people.manage holder who is not one gets 403 and nothing changes", async () => {
    await t.db.admin.query(`insert into role_matrix_versions (org_id, version, matrix, published_at, published_by) select org_id, version + 1, jsonb_set(matrix, '{auditor,people.manage}', 'true'), now(), 'test' from role_matrix_versions order by version desc limit 1`);
    const sam = await flow({ sub: "kc-sam", email: "sam@acme.dev", email_verified: true, gantry_id: "p-sam", auth_time: now(), acr: "2" });
    const omar = await flow({ sub: "kc-omar", email: "omar@acme.dev", email_verified: true, gantry_id: "p-omar", auth_time: now(), acr: "2" });
    await idp.createUser({ username: "omar", email: "omar@acme.dev" });
    idp.creds.set("kc-omar", [{ id: "o1", type: "otp" }]);
    const before = idp.calls.length;
    const r = await post(cookieOf(sam), "/api/v1/people/p-omar/mfa-reset", { reason: "not really lost" });
    expect(r.statusCode).toBe(403);
    expect(r.json().msg).toMatch(/Only a Factory Admin/);
    expect(idp.calls.length).toBe(before);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: cookieOf(omar) } })).statusCode).toBe(200);
    // a Factory Admin may
    const admin = await flow({ ...asha, auth_time: now(), acr: "2" });
    expect((await post(cookieOf(admin), "/api/v1/people/p-omar/mfa-reset", { reason: "lost phone, verified" })).statusCode).toBe(200);
  });

  it("S-124/G-M2: a change at the provider outside Gantry is audited at the next sign-in, including a re-planted factor with a reused id (the creation time differs)", async () => {
    const meera = { sub: "kc-meera", email: "meera@acme.dev", email_verified: true, gantry_id: "p-meera", acr: "2" };
    const count = async () => (await t.db.admin.query(`select count(*)::int n from events where type = 'auth.mfa_changed_outside' and subject->>'id' = 'p-meera'`)).rows[0].n;
    await t.db.admin.query(`update people set mfa_link_at = now() where id = 'p-meera'`); // Gantry sent the enrolment link: the first sighting is expected
    idp.creds.set("kc-meera", [{ id: "m1", type: "otp", createdDate: 1000 }]);
    await flow({ ...meera, auth_time: now() });
    expect(await count()).toBe(0);
    await flow({ ...meera, auth_time: now() });
    expect(await count()).toBe(0); // unchanged: nothing
    idp.creds.set("kc-meera", [{ id: "m1", type: "otp", createdDate: 2000 }]); // deleted and re-created with the same id (a planted secret)
    await flow({ ...meera, auth_time: now() });
    expect(await count()).toBe(1);
    idp.creds.set("kc-meera", [{ id: "m2", type: "otp", createdDate: 3000 }]);
    await flow({ ...meera, auth_time: now() });
    expect(await count()).toBe(2);
    const ev = (await t.db.admin.query(`select after from events where type = 'auth.mfa_changed_outside' and subject->>'id' = 'p-meera' order by id desc limit 1`)).rows[0];
    expect(ev.after).toMatchObject({ why: "credentials_changed", types: ["otp"] });
    // and the Factory Admins are emailed
    const mail = (await t.db.admin.query(`select payload from outbox where destination = 'smtp' and payload->>'subject' like '%second factor changed outside%' order by created_at desc limit 1`)).rows[0];
    expect(mail.payload.to).toEqual(expect.arrayContaining(["asha@acme.dev"]));
  });

  it("G-M2: a factor first seen with no Gantry enrolment link and no baseline is audited, not refused", async () => {
    idp.creds.set("kc-fatima", [{ id: "f1", type: "webauthn", createdDate: 5 }]);
    const x = await flow({ sub: "kc-fatima", email: "fatima@acme.dev", email_verified: true, gantry_id: "p-fatima", auth_time: now(), acr: "2" });
    expect(x.session).toBeTruthy();
    const ev = (await t.db.admin.query(`select after from events where type = 'auth.mfa_changed_outside' and subject->>'id' = 'p-fatima'`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].after).toMatchObject({ why: "first_seen_without_enrolment" });
  });

  const real = (o: Partial<IdpAdminEvent>): IdpAdminEvent => ({ time: Date.now(), operation: "ACTION", resourceType: "USER", resourcePath: "users/u1/reset-password", clientId: SVC_CLIENT_UUID, userId: SVC_USER, realmId: "74d1ab8c", ...o });
  const outsideCount = async () => (await t.db.admin.query(`select count(*)::int n from events where type = 'auth.mfa_changed_outside'`)).rows[0].n as number;
  const logCall = (method: string, path: string, at = new Date()) => t.db.admin.query(`insert into idp_admin_log (org_id, method, path, at) values ($1,$2,$3,$4)`, [t.orgId, method, path, at]);

  it("G-N1: Gantry's own calls are recognised by the service-account USER id with a real-shaped event (client id is a UUID): no alarm for an invite or a reset", async () => {
    const { checkIdpAdminEvents } = await import("../src/core/auth/idp-watch.js");
    const n0 = await outsideCount();
    await logCall("PUT", "/users/u1/reset-password");
    await logCall("DELETE", "/users/u1/credentials/c9");
    await logCall("POST", "/users");
    const t0 = Date.now();
    idp.events = [
      real({ time: t0 + 1, resourcePath: "users/u1/credentials/c9" }),
      real({ time: t0 + 2 }),
      real({ time: t0 + 3, operation: "CREATE", resourcePath: "users/newbie" }),
      real({ time: t0 + 4, resourcePath: "users/u1/execute-actions-email" }), // never an alarm
    ];
    expect(await checkIdpAdminEvents(t.app.gantry, t0 + 10)).toMatchObject({ flagged: 0 });
    expect(await outsideCount()).toBe(n0);
  });

  it("G-N2: a logged call of one kind does not hide a different event; each log row explains at most one event; a few seconds, not two minutes", async () => {
    const { checkIdpAdminEvents } = await import("../src/core/auth/idp-watch.js");
    const t0 = Date.now() + 100_000;
    await t.db.admin.query(`delete from idp_admin_log`);
    await logCall("POST", "/users/someone-else/execute-actions-email", new Date(t0));
    await logCall("PUT", "/users/ok/reset-password", new Date(t0 + 500));
    idp.events = [
      real({ time: t0 + 1000, resourcePath: "users/victim/reset-password" }), // matches the ok row's path? no: another user's path
      real({ time: t0 + 1100, resourcePath: "users/ok/reset-password" }),
      real({ time: t0 + 1200, resourcePath: "users/ok/reset-password" }), // the one row already explained the first: this is a second reset nobody logged
      real({ time: t0 + 60_000, resourcePath: "users/ok/reset-password" }), // a minute later: outside the few-second window
    ];
    const r = await checkIdpAdminEvents(t.app.gantry, t0 + 70_000);
    expect(r.flagged).toBe(3);
  });

  it("G-N2: an UPDATE of a user (how a factor is planted through PUT) is an alarm unless a logged PUT explains it, and so is a console change", async () => {
    const { checkIdpAdminEvents } = await import("../src/core/auth/idp-watch.js");
    const n0 = await outsideCount();
    const t0 = Date.now() + 200_000;
    idp.events = [
      real({ time: t0, operation: "UPDATE", resourcePath: "users/victim", representation: "{\"id\":\"victim\",\"totp\":false}" }),
      real({ time: t0 + 1, operation: "UPDATE", resourcePath: "users/victim", userId: "admin-console-user", clientId: "security-admin-console-uuid", realmId: "master" }),
    ];
    expect((await checkIdpAdminEvents(t.app.gantry, t0 + 10)).flagged).toBe(2);
    expect(await outsideCount()).toBe(n0 + 2);
  });

  it("G-N2: if the events cannot be read to the end (a flood), that is itself an alarm and the check says so", async () => {
    const { checkIdpAdminEvents } = await import("../src/core/auth/idp-watch.js");
    const n0 = await outsideCount();
    idp.incomplete = true; idp.events = [];
    const r = await checkIdpAdminEvents(t.app.gantry, Date.now() + 300_000);
    idp.incomplete = false;
    expect(r.flagged).toBe(1);
    expect((await t.db.admin.query(`select after from events where type = 'auth.mfa_changed_outside' order by seq desc limit 1`)).rows[0].after).toMatchObject({ why: "events_incomplete" });
    expect(await outsideCount()).toBe(n0 + 1);
  });

  it("G-N4: the apply script's test-mail probe user (made by the master admin) raises no alarm; the same event made by the service account does", async () => {
    const { checkIdpAdminEvents } = await import("../src/core/auth/idp-watch.js");
    const t0 = Date.now() + 400_000;
    const probe = { operation: "CREATE", resourcePath: "users/probe1", representation: "{\"username\":\"gantry-smtp-test-123\",\"email\":\"ops@x.dev\"}" };
    idp.events = [real({ time: t0, ...probe, userId: "master-admin", clientId: "admin-cli-uuid", realmId: "master" }), real({ time: t0 + 1, operation: "DELETE", resourcePath: "users/probe1", userId: "master-admin", clientId: "admin-cli-uuid" })];
    expect((await checkIdpAdminEvents(t.app.gantry, t0 + 10)).flagged).toBe(0);
    idp.events = [real({ time: t0 + 20, ...probe })]; // our own account creating that name with no logged call
    expect((await checkIdpAdminEvents(t.app.gantry, t0 + 30)).flagged).toBe(1);
  });

  it("G-M9/G-N3: the backfill fills only a missing baseline; a baseline that differs from the provider is raised, not overwritten; an unreachable provider changes nothing", async () => {
    const { backfillMfa } = await import("../src/core/auth/idp-watch.js");
    await t.db.admin.query(`update people set idp_subject = 'kc-sam', mfa = null, mfa_checked_at = null, mfa_fingerprint = null where id = 'p-sam'`);
    const unknown = (await t.app.inject({ url: "/api/v1/people", headers: { cookie: (await t.session("p-asha", { secondFactor: true })).cookie } })).json().find((p: { id: string }) => p.id === "p-sam");
    expect(unknown.mfa).toBeNull();
    // provider unreachable at start: nothing changes, nothing thrown, still unknown
    const orig = idp.secondFactors; idp.secondFactors = async () => { throw new Error("down"); };
    expect(await backfillMfa(t.app.gantry)).toBe(0); idp.secondFactors = orig;
    expect((await t.db.admin.query(`select mfa from people where id = 'p-sam'`)).rows[0].mfa).toBeNull();
    // missing baseline: filled
    idp.creds.set("kc-sam", [{ id: "s1", type: "otp", createdDate: 1 }]);
    await backfillMfa(t.app.gantry);
    const row = (await t.db.admin.query(`select mfa, mfa_types, mfa_fingerprint from people where id = 'p-sam'`)).rows[0];
    expect(row).toMatchObject({ mfa: true, mfa_types: ["otp"] });
    // a factor planted while the API was down: raised, baseline kept
    const samEvents = async () => (await t.db.admin.query(`select count(*)::int n from events where type = 'auth.mfa_changed_outside' and subject->>'id' = 'p-sam'`)).rows[0].n as number;
    const n0 = await samEvents();
    idp.creds.set("kc-sam", [{ id: "plant", type: "otp", createdDate: 2 }]);
    await backfillMfa(t.app.gantry);
    expect(await samEvents()).toBe(n0 + 1);
    expect((await t.db.admin.query(`select mfa_fingerprint from people where id = 'p-sam'`)).rows[0].mfa_fingerprint).toBe(row.mfa_fingerprint);
  });

  it("G-N2: the real client pages through every admin event (not a fixed 200) and keeps UPDATE events", async () => {
    const { keycloakAdminClient } = await import("../src/core/auth/idp-admin.js");
    const since = Date.now() - 60_000;
    const mk = (i: number, op = "ACTION", path = `users/u${i}/reset-password`) => ({ time: since + 1000 + i, operationType: op, resourceType: "USER", resourcePath: path, authDetails: { clientId: SVC_CLIENT_UUID, userId: SVC_USER, realmId: "r" } });
    const all = [...Array.from({ length: 450 }, (_, i) => mk(450 - i)), mk(1, "UPDATE", "users/victim")]; // newest first, 451 rows: three pages of 200
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(String(url));
      if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 60 }));
      const u = new URL(String(url));
      const first = Number(u.searchParams.get("first")); const max = Number(u.searchParams.get("max"));
      return new Response(JSON.stringify(all.slice(first, first + max)));
    }) as unknown as typeof fetch;
    const c = keycloakAdminClient({ baseUrl: "http://kc/idp", realm: "gantry", clientId: "gantry-admin", clientSecret: "s", fetchImpl });
    const r = await c.credentialEvents(since);
    expect(r.complete).toBe(true);
    expect(r.events).toHaveLength(451);
    expect(r.events.some((e) => e.operation === "UPDATE" && e.resourcePath === "users/victim")).toBe(true);
    expect(asked.filter((u) => u.includes("admin-events"))).toHaveLength(3);
  });
});

d("the dev waiver is only an explicit opt-in", () => {
  it("S-120: with the waiver on (never the default), a password-only sign-in still works, and the security settings say it is waived", async () => {
    const issuer = await startIssuer("gantry-web", "client-secret");
    const config = testConfig({ adminMfaOptional: true, oidc: { issuer: issuer.issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "client-secret", githubIdpAlias: null } });
    const t = await startApp({ config, build: { oidc: createOidcAdapter(config.oidc) } });
    try {
      const login = await t.app.inject("/auth/login");
      const cb = issuer.authorize(String(login.headers.location), { sub: "kc-asha", email: "asha@acme.dev", email_verified: true, gantry_id: "p-asha", auth_time: now(), acr: "1" });
      const r = await t.app.inject({ url: cb, headers: { cookie: `gantry_oidc=${login.cookies.find((c) => c.name === "gantry_oidc")!.value}` } });
      const session = r.cookies.find((c) => c.name === "__Host-gantry_session");
      expect(session).toBeTruthy();
      const sec = (await t.app.inject({ url: "/api/v1/security", headers: { cookie: `__Host-gantry_session=${session!.value}` } })).json();
      expect(sec.mfa).toMatchObject({ policy: "everyone", required: true, waived: true });
    } finally { await t.close(); await issuer.close(); }
  });
});
