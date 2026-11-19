import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminMfaOptionalAllowed } from "../src/core/config.js";
import { createOidcAdapter, hasSecondFactor } from "../src/core/oidc.js";
import { TEST_URL, startApp, testConfig, type TestApp } from "./helpers.js";
import { startIssuer } from "./issuer.js";

const now = () => Math.floor(Date.now() / 1000);
type Issuer = Awaited<ReturnType<typeof startIssuer>>;

describe("second-factor evidence in an ID token", () => {
  it("accepts an amr that names a factor or an acr at the realm's second level, and nothing else", () => {
    expect(hasSecondFactor({ acr: "2" })).toBe(true);
    expect(hasSecondFactor({ acr: "3" })).toBe(true);
    expect(hasSecondFactor({ acr: "1" })).toBe(false);
    expect(hasSecondFactor({ acr: "0" })).toBe(false);
    expect(hasSecondFactor({})).toBe(false);
    expect(hasSecondFactor({ amr: ["pwd"] })).toBe(false);
    expect(hasSecondFactor({ amr: ["pwd", "otp"] })).toBe(true);
    expect(hasSecondFactor({ amr: ["MFA"] })).toBe(true);
    expect(hasSecondFactor({ acr: "gold" }, ["gold"])).toBe(true);
    expect(hasSecondFactor({ acr: "2" }, ["gold"])).toBe(false); // the configured list replaces the default
  });

  it("the dev waiver is refused unless the public URL is this machine", () => {
    expect(adminMfaOptionalAllowed(false, "https://gantry.example.com")).toBe(false);
    expect(adminMfaOptionalAllowed(true, "https://localhost")).toBe(true);
    expect(() => adminMfaOptionalAllowed(true, "https://gantry.example.com")).toThrow(/local development only/);
  });
});

const d = TEST_URL ? describe : describe.skip;

d("everyone needs a second factor (server-enforced)", () => {
  let issuer: Issuer;
  let t: TestApp;
  beforeAll(async () => {
    issuer = await startIssuer("gantry-web", "client-secret");
    const config = testConfig({ adminMfaOptional: false, oidc: { issuer: issuer.issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "client-secret", githubIdpAlias: null } });
    t = await startApp({ config, build: { oidc: createOidcAdapter(config.oidc) } });
  });
  afterAll(async () => {
    await t.close();
    await issuer.close();
  });

  const asha = { sub: "kc-asha", email: "asha@acme.dev", email_verified: true, name: "Asha Raman", gantry_id: "p-asha" };
  const tomas = { sub: "kc-tomas", email: "tomas@acme.dev", email_verified: true, gantry_id: "p-tomas" };
  async function flow(claims: Parameters<Issuer["authorize"]>[1], query = "", cookie?: string) {
    const login = await t.app.inject({ url: `/auth/login${query}`, ...(cookie ? { headers: { cookie } } : {}) });
    const st = login.cookies.find((c) => c.name === "gantry_oidc")!;
    const cb = issuer.authorize(String(login.headers.location), claims);
    const r = await t.app.inject({ url: cb, headers: { cookie: [`gantry_oidc=${st.value}`, cookie].filter(Boolean).join("; ") } });
    return { login, r, session: r.cookies.find((c) => c.name === "__Host-gantry_session") };
  }

  it("asks the provider for the second-factor level on every sign-in", async () => {
    const plain = await t.app.inject("/auth/login");
    expect(new URL(String(plain.headers.location)).searchParams.get("acr_values")).toBe("2");
    const mfa = await t.app.inject("/auth/login?mfa=1");
    expect(new URL(String(mfa.headers.location)).searchParams.get("acr_values")).toBe("2");
  });

  it("refuses anyone whose token shows only a password, with a clear answer, and records it", async () => {
    const x = await flow({ ...asha, auth_time: now(), acr: "1" });
    expect(x.session).toBeUndefined();
    const loc = String(x.r.headers.location);
    expect(loc).toContain("auth_needs=mfa_setup");
    expect(decodeURIComponent(loc)).toContain("two steps");
    expect((await t.db.admin.query(`select outcome, reason from signins order by id desc limit 1`)).rows[0]).toEqual({ outcome: "denied", reason: "mfa_required" });
    expect((await t.db.admin.query(`select 1 from sessions where person_id = 'p-asha'`)).rowCount).toBe(0);

    const plainUser = await flow({ ...tomas, auth_time: now(), acr: "1" });
    expect(plainUser.session).toBeUndefined(); // S-121: not only Factory Admins
  });

  it("admits an admin with acr 2 or an otp amr, and the step-up (max_age=0) keeps working on that session", async () => {
    const x = await flow({ ...asha, auth_time: now(), acr: "2" });
    expect(x.session).toBeTruthy();
    const cookie = `__Host-gantry_session=${x.session!.value}`;
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(200);
    expect((await t.db.admin.query(`select second_factor from sessions where person_id = 'p-asha' order by created_at desc limit 1`)).rows[0].second_factor).toBe(true);

    const step = await flow({ ...asha, auth_time: now(), acr: "2" }, "?step_up=1", cookie);
    const u = new URL(String(step.login.headers.location));
    expect(u.searchParams.get("max_age")).toBe("0");
    expect(u.searchParams.get("acr_values")).toBe("2"); // the held session has a factor, so the step-up asks for it again
    expect(step.session).toBeUndefined();
    expect(step.r.headers.location).toBe("/");

    const viaAmr = await flow({ ...asha, auth_time: now(), amr: ["pwd", "otp"] });
    expect(viaAmr.session).toBeTruthy();
  });

  it("a step-up whose token lost the factor is refused and leaves the session as it was", async () => {
    const x = await flow({ ...asha, auth_time: now(), acr: "2" });
    const cookie = `__Host-gantry_session=${x.session!.value}`;
    const step = await flow({ ...asha, auth_time: now(), acr: "1" }, "?step_up=1", cookie);
    expect(String(step.r.headers.location)).toContain("auth_needs=mfa_setup");
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(200);
  });

  it("refuses requests on a session without the factor, for any person, and lets them in after a proper sign-in", async () => {
    const weak = await t.session("p-tomas"); // a session made without a second factor
    const r = await t.app.inject({ url: "/api/v1/me", headers: { cookie: weak.cookie } });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ ok: false, needs: "mfa_setup", rule: { id: "MFA" } });
    expect(r.json().msg).toMatch(/two steps/i);
    const x = await flow({ ...tomas, auth_time: now(), acr: "2" });
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie: `__Host-gantry_session=${x.session!.value}` } })).statusCode).toBe(200);
  });

  it("API keys and other non-session callers are not affected", async () => {
    expect((await t.app.inject({ url: "/api/v1/me", headers: { authorization: "Bearer gk_nope" } })).statusCode).toBe(401);
  });
});

d("the bootstrap Factory Admin also needs the factor", () => {
  let issuer: Issuer;
  let t: TestApp;
  beforeAll(async () => {
    issuer = await startIssuer("gantry-web", "client-secret");
    const config = testConfig({ adminMfaOptional: false, devSeed: false, bootstrapAdminEmail: "boss@corp.example", oidc: { issuer: issuer.issuer, internalUrl: null, clientId: "gantry-web", clientSecret: "client-secret", githubIdpAlias: null } });
    t = await startApp({ seed: false, config, build: { oidc: createOidcAdapter(config.oidc) } });
  });
  afterAll(async () => {
    await t.close();
    await issuer.close();
  });

  it("a password-only first sign-in does not become admin; one with a second factor does", async () => {
    const boss = { sub: "boss-1", email: "boss@corp.example", email_verified: true, name: "The Boss", auth_time: now() };
    const run = async (claims: typeof boss & { acr: string }) => {
      const login = await t.app.inject("/auth/login");
      const cb = issuer.authorize(String(login.headers.location), claims);
      return t.app.inject({ url: cb, headers: { cookie: `gantry_oidc=${login.cookies.find((c) => c.name === "gantry_oidc")!.value}` } });
    };
    const weak = await run({ ...boss, acr: "1" });
    expect(weak.cookies.find((c) => c.name === "__Host-gantry_session")).toBeUndefined();
    expect(String(weak.headers.location)).toContain("auth_needs=mfa_setup");
    expect((await t.db.admin.query(`select 1 from role_assignments where role_id = 'factory_admin' and revoked_at is null`)).rowCount).toBe(0);
    const strong = await run({ ...boss, acr: "2" });
    expect(strong.cookies.find((c) => c.name === "__Host-gantry_session")).toBeTruthy();
    expect((await t.db.admin.query(`select 1 from role_assignments where role_id = 'factory_admin' and revoked_at is null`)).rowCount).toBe(1);
  });
});
