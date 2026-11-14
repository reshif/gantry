/**
 * Demo sign-in: every demo Keycloak user exists and maps to its seed person, local Keycloak has no second factor (so the cards'
 * "MFA step" is a fresh password sign-in only), and a person who signs in with no grants gets nothing but their own profile.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACTIONS, devSeed } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../../../apps/web/src/lib/demo.js";
import { signIn } from "../src/core/auth/signin.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const realm = JSON.parse(readFileSync(fileURLToPath(new URL("../../../deploy/keycloak/realm-gantry.json", import.meta.url)), "utf8")) as {
  users: Array<{ username: string; email: string; enabled: boolean; emailVerified: boolean; requiredActions?: string[]; attributes: Record<string, string[]>; credentials: Array<{ type: string; temporary: boolean }> }>;
  [k: string]: unknown;
};
const seed = devSeed().state;
const IDS = ["p-asha", "p-daniel", "p-meera", "p-tomas", "p-fatima", "p-kenji", "p-sam", "p-priya", "p-lena", "p-omar"];

describe("demo cards, Keycloak realm and seed agree", () => {
  it("the sign-in fallback list covers the ten personas (and the rest of the realm), with ids and emails that exist in the seed", () => {
    expect(DEMO_ACCOUNTS.map((a) => a.id)).toEqual(expect.arrayContaining(IDS));
    for (const a of DEMO_ACCOUNTS) {
      const p = seed.people.find((x) => x.id === a.id);
      expect(p, a.id).toBeTruthy();
      expect(p!.email, a.id).toBe(a.email);
      expect(p!.name, a.id).toBe(a.name);
    }
  });
  it("every persona has an enabled, verified Keycloak user whose gantry_id and email map to the seed person, with a non-temporary password", () => {
    for (const id of IDS) {
      const u = realm.users.find((x) => x.attributes?.gantry_id?.[0] === id);
      expect(u, `${id} in realm-gantry.json`).toBeTruthy();
      const p = seed.people.find((x) => x.id === id)!;
      expect(u!.email).toBe(p.email);
      expect(u!.username).toBe(id.slice(2));
      expect(u!.enabled).toBe(true);
      expect(u!.emailVerified).toBe(true);
      expect(u!.credentials.some((c) => c.type === "password" && !c.temporary)).toBe(true);
    }
  });
  it("realm users that are not in the cards still map to real seed people (no orphan identity)", () => {
    for (const u of realm.users) expect(seed.people.some((p) => p.id === u.attributes.gantry_id?.[0] && p.email === u.email), u.username).toBe(true);
  });
  it("FINDING: local Keycloak has no second factor, so the cards' 'MFA step' is only a fresh password sign-in", () => {
    // no OTP policy, no required actions on any user, no custom browser flow, no authenticationFlows, only password credentials
    expect(realm.otpPolicyType).toBeUndefined();
    expect(realm.authenticationFlows).toBeUndefined();
    expect(realm.browserFlow).toBeUndefined();
    expect(realm.requiredActions).toBeUndefined();
    for (const u of realm.users) {
      expect(u.requiredActions ?? [], u.username).toEqual([]);
      expect(u.credentials.map((c) => c.type), u.username).toEqual(["password"]);
    }
    // no card may promise an MFA step the realm cannot deliver (the old static cards did for Asha, Daniel, Lena and Omar)
    expect(DEMO_ACCOUNTS.filter((a) => /MFA/i.test(a.note + a.role)).map((a) => a.id)).toEqual([]);
    // the seed still flags these four as mfa:true although no second factor exists
    for (const id of ["p-asha", "p-daniel", "p-lena", "p-omar"]) expect((seed.people.find((p) => p.id === id) as { mfa?: boolean }).mfa).toBe(true);
    // the API never reads mfa/acr to decide anything; step-up is the age of the sign-in only (services/api/src/core/decide.ts stepUpSatisfied)
  });
});

const d = TEST_URL ? describe : describe.skip;

d("sign-in resolves each demo user to the right person", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const g = () => t.app.gantry;
  const req = { ip: "203.0.113.9", userAgent: "vitest", requestId: "r", method: "sso" as const };
  const claimsOf = (u: (typeof realm.users)[number], sub = `kc-${u.username}`) => ({ sub, email: u.email, emailVerified: true, name: `${u.username}`, gantryId: u.attributes.gantry_id![0], authTime: Math.floor(Date.now() / 1000) });

  it("each of the ten Keycloak identities signs in as exactly its seed person, not provisioned as a new one", async () => {
    for (const id of IDS) {
      const u = realm.users.find((x) => x.attributes.gantry_id![0] === id)!;
      const r = await signIn(g(), claimsOf(u), req);
      expect(r.ok, id).toBe(true);
      if (r.ok) {
        expect(r.personId).toBe(id);
        expect(r.provisioned).toBe(false);
      }
    }
  });
  it("the server's sign-in list (config.demoAccountList, when the server sends one) names the roles each person really holds and no others", async () => {
    const s = await t.session("p-tomas");
    const cfg = (await t.app.inject({ method: "GET", url: "/api/v1/me", headers: s.headers })).json().config as { demoAccountList?: Array<{ id: string; role: string; note: string }> };
    expect(cfg.demoAccountList, "the server sends the demo list built from the live org").toBeTruthy();
    if (!cfg.demoAccountList) return;
    const roleNames: Record<string, string> = { factory_admin: "Factory Admin", auditor: "Auditor", project_admin: "Project Admin", line_lead: "Line Lead", engineer: "Engineer", reviewer: "Reviewer", approver: "Approver", release_manager: "Release Manager", viewer: "Viewer" };
    for (const id of IDS) {
      const entry = cfg.demoAccountList.find((x) => x.id === id);
      expect(entry, id).toBeTruthy();
      const held = new Set(seed.people.find((p) => p.id === id)!.roles.map((g) => roleNames[g.role]));
      for (const name of Object.values(roleNames)) expect(entry!.role.includes(name), `${id} role text "${entry!.role}" vs ${name}`).toBe(held.has(name));
    }
  });
  it("a claimed gantry_id never lends another person's identity: the email decides (no impersonation through the attribute)", async () => {
    const r = await signIn(g(), { sub: "kc-evil", email: "tomas@acme.dev", emailVerified: true, gantryId: "p-asha" }, req);
    // tomas already signed in under another subject, so this is refused rather than becoming Asha
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.personId).not.toBe("p-asha");
  });
  it("a person with no grants (first sign-in) is provisioned with no roles and gets nothing but their own profile", async () => {
    const r = await signIn(g(), { sub: "kc-newbie", email: "newbie@acme.dev", emailVerified: true, name: "New Person", preferredUsername: "newbie" }, req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provisioned).toBe(true);
    const s = await t.session(r.personId);
    const call = async (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => {
      const x = await t.app.inject({ method, url, headers: s.headers, ...(payload === undefined ? {} : { payload: payload as object }) });
      let body: any = {};
      try {
        body = x.json();
      } catch {
        /* empty */
      }
      return { status: x.statusCode, body };
    };
    const me = await call("GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.person).toMatchObject({ id: r.personId, email: "newbie@acme.dev", roles: [] });
    expect(me.body.projects).toEqual([]);
    // every catalogue action, at factory and in every project, is refused
    const projects = seed.projects.map((p) => p.id);
    const checks = ACTIONS.flatMap((a) => (a.scope === "project" ? projects.map((project) => ({ action: a.id, project })) : [{ action: a.id, project: null }]));
    // The batch endpoint takes at most 500 checks; the catalogue grew past that with the Console group, so it is asked in chunks.
    const allowed: unknown[] = [];
    for (let i = 0; i < checks.length; i += 400) {
      const can = await call("POST", "/api/v1/can", { checks: checks.slice(i, i + 400) });
      expect(can.status).toBe(200);
      allowed.push(...can.body.results.filter((x: any) => x.allowed));
    }
    expect(allowed).toEqual([]);
    // real writes are refused
    expect((await call("POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Nothing to see here", description: "A newcomer tries to submit work." })).status).toBeGreaterThanOrEqual(403);
    expect((await call("POST", "/api/v1/stops", { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY" })).status).toBe(403);
    expect([403, 409]).toContain((await call("PUT", "/api/v1/access/matrix/engineer/release", { on: true })).status);
    expect((await call("GET", "/api/v1/projects/payments/floor")).status).toBeGreaterThanOrEqual(403);
    // reads: the ledger shows nothing of the factory, only what they did themselves
    const audit = await call("GET", "/api/v1/audit?limit=200");
    expect(audit.status).toBe(200);
    expect(audit.body.items.every((e: any) => e.actor === r.personId || /New Person/.test(String(e.actor)) || e.project == null)).toBe(true);
    expect((await call("GET", "/api/v1/audit/verify")).status).toBe(403);
  });
  it("FINDING: what else a person with no grants can read (own profile and own sign-ins only; default deny)", async () => {
    const r = await signIn(g(), { sub: "kc-newbie2", email: "newbie2@acme.dev", emailVerified: true, name: "Second Newcomer" }, req);
    if (!r.ok) throw new Error("sign-in failed");
    const s = await t.session(r.personId);
    const get = async (url: string) => (await t.app.inject({ method: "GET", url, headers: s.headers })).statusCode;
    const open: string[] = [];
    for (const url of ["/api/v1/people", "/api/v1/policies", "/api/v1/freezes", "/api/v1/access/matrix", "/api/v1/agents", "/api/v1/skills", "/api/v1/models", "/api/v1/integrations", "/api/v1/signins", "/api/v1/security", "/api/v1/catalog", "/api/v1/templates"]) {
      if ((await get(url)) === 200) open.push(url);
    }
    // Record the actual surface so a change (fix or regression) is noticed.
    console.log("no-grant person can read:", open.join(", ") || "(none)");
    // Default deny (user decision): everything but their own sign-in history needs a role. This pinned list used to be ten endpoints long.
    expect(open.sort()).toEqual(["/api/v1/signins"]);
    // the sign-in history a newcomer can read is their own
    const signins = await t.app.inject({ method: "GET", url: "/api/v1/signins", headers: s.headers });
    const rows = (signins.json().items ?? signins.json()) as Array<{ person?: string }>;
    expect(rows.every((x) => !x.person || x.person === r.personId)).toBe(true);
  });
});

d("an empty organisation (no seed)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seed: false, config: { bootstrapAdminEmail: "boss@acme.dev" } });
  });
  afterAll(() => t.close());
  const req = { ip: "203.0.113.9", userAgent: "vitest", requestId: "r", method: "sso" as const };
  it("the first ordinary sign-in is an account with no access; only the configured bootstrap email becomes Factory Admin", async () => {
    const plain = await signIn(t.app.gantry, { sub: "kc-a", email: "asha@acme.dev", emailVerified: true, name: "Asha Raman", gantryId: "p-asha" }, req);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const s = await t.session(plain.personId);
    const me = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: s.headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().person.roles).toEqual([]);
    const can = await t.app.inject({ method: "POST", url: "/api/v1/can", headers: s.headers, payload: { checks: ACTIONS.filter((a) => a.scope !== "project").map((a) => ({ action: a.id })) } });
    expect(can.json().results.filter((x: { allowed: boolean }) => x.allowed)).toEqual([]);
    const boss = await signIn(t.app.gantry, { sub: "kc-b", email: "boss@acme.dev", emailVerified: true, name: "The Boss" }, req);
    expect(boss.ok).toBe(true);
    if (!boss.ok) return;
    const bs = await t.session(boss.personId);
    const bme = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: bs.headers });
    expect(bme.json().person.roles).toEqual([expect.objectContaining({ role: "factory_admin", scope: "factory" })]);
  });
});
