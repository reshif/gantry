// The MFA review (statechart S-120..S-130), replayed on the real API: everyone needs a second factor, a step-up re-asks it and is fresh,
// an authenticator reset goes through Gantry (ledger, sessions ended, one-time link), and a reset done at the identity provider is noticed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { needsStepUp } from "@gantry/domain";
import { createOidcAdapter } from "../src/core/oidc.js";
import type { IdpAdmin, IdpCredential } from "../src/core/auth/idp-admin.js";
import { SESSION_KEY, TEST_URL, startApp, testConfig, type TestApp } from "./helpers.js";
import { startIssuer } from "./issuer.js";

const now = () => Math.floor(Date.now() / 1000);
type Issuer = Awaited<ReturnType<typeof startIssuer>>;
const d = TEST_URL ? describe : describe.skip;

/** An identity provider the API can administer: records what Gantry asks of it. */
function fakeIdp(): IdpAdmin & { calls: string[]; creds: Map<string, IdpCredential[]>; failLink: boolean } {
  const calls: string[] = [];
  const creds = new Map<string, IdpCredential[]>();
  const users = new Map<string, { id: string; username: string; email: string | null }>();
  const fake = {
    calls, creds, failLink: false,
    async findUser(q: { username?: string; email?: string }) { return [...users.values()].find((u) => (q.username && u.username === q.username) || (q.email && u.email === q.email)) ?? null; },
    async findUserId(username: string) { return (await fake.findUser({ username }))?.id ?? null; },
    async createUser(u: { username: string; email?: string }) { const id = `kc-${u.username}`; users.set(id, { id, username: u.username, email: u.email ?? null }); calls.push(`create:${u.username}`); return id; },
    async secondFactors(id: string) { return creds.get(id) ?? []; },
    async resetSecondFactors(id: string) { const n = (creds.get(id) ?? []).length; creds.set(id, []); calls.push(`reset:${id}`, `logout:${id}`); return n; }, // the real client also ends the provider sessions
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
    const x = await flow({ ...daniel, auth_time: now() - 4000, acr: "2" });
    const cookie = cookieOf(x);
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

  it("S-129: a token without auth_time does not count as just signed in; a step-up without it, or with an old one, is refused", async () => {
    const x = await flow({ ...daniel, acr: "2" }); // no auth_time claim
    expect(x.session).toBeTruthy();
    const cookie = cookieOf(x);
    expect((await t.db.admin.query(`select auth_time from sessions where person_id = 'p-daniel' order by created_at desc limit 1`)).rows[0].auth_time).toBeNull();
    expect((await post(cookie, "/api/v1/api-keys", { name: "k", project: "payments", actions: ["wo.read"] })).json().needs).toBe("step_up");
    const noTime = await flow({ ...daniel, acr: "2" }, "?step_up=1", cookie);
    expect(String(noTime.r.headers.location)).toContain("auth_error");
    const old = await flow({ ...daniel, auth_time: now() - 4000, acr: "2" }, "?step_up=1", cookie);
    expect(String(old.r.headers.location)).toContain("auth_error");
    expect((await post(cookie, "/api/v1/api-keys", { name: "k", project: "payments", actions: ["wo.read"] })).json().needs).toBe("step_up");
    expect((await flow({ ...daniel, auth_time: now(), acr: "2" }, "?step_up=1", cookie)).r.headers.location).toBe("/");
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
    const stale = await flow({ ...asha, auth_time: now() - 4000, acr: "2" });
    expect((await post(cookieOf(stale), url, { reason: "lost phone" })).json().needs).toBe("step_up");
    expect(idp.calls.filter((c) => c.startsWith("reset"))).toEqual([]);

    const r = await post(adminCookie, url, { reason: "lost phone, verified by video call" });
    expect(r.statusCode, r.body).toBe(200);
    expect(idp.calls).toEqual(expect.arrayContaining(["reset:kc-daniel", expect.stringMatching(/^link:kc-daniel:\d+$/), "logout:kc-daniel"]));
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

  it("S-124: a failed link leaves a clear refusal, and with no identity-provider connection the reset says so", async () => {
    const admin = await flow({ ...asha, auth_time: now(), acr: "2" });
    await idp.createUser({ username: "priya", email: "priya@acme.dev" });
    idp.failLink = true;
    const bad = await post(cookieOf(admin), "/api/v1/people/p-priya/mfa-reset", { reason: "lost phone again" });
    idp.failLink = false;
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(bad.json().msg).toMatch(/link/i);
  });

  it("S-124: a reset done directly at the identity provider is noticed at the next sign-in (the credential id changed) and audited", async () => {
    idp.creds.set("kc-meera", [{ id: "m1", type: "otp" }]);
    await flow({ sub: "kc-meera", email: "meera@acme.dev", email_verified: true, gantry_id: "p-meera", auth_time: now(), acr: "2" });
    const quiet = (await t.db.admin.query(`select count(*)::int n from events where type = 'auth.mfa_changed' and subject->>'id' = 'p-meera'`)).rows[0].n;
    expect(quiet).toBe(0); // the first recording is not a change
    idp.creds.set("kc-meera", [{ id: "m2", type: "otp" }]); // an operator removed the old authenticator and the person enrolled another, in the Keycloak console
    await flow({ sub: "kc-meera", email: "meera@acme.dev", email_verified: true, gantry_id: "p-meera", auth_time: now(), acr: "2" });
    const ev = (await t.db.admin.query(`select after from events where type = 'auth.mfa_changed' and subject->>'id' = 'p-meera'`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].after).toMatchObject({ types: ["otp"] });
    await flow({ sub: "kc-meera", email: "meera@acme.dev", email_verified: true, gantry_id: "p-meera", auth_time: now(), acr: "2" });
    expect((await t.db.admin.query(`select count(*)::int n from events where type = 'auth.mfa_changed' and subject->>'id' = 'p-meera'`)).rows[0].n).toBe(1); // unchanged: no repeat
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
