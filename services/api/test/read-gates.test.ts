import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGateFor } from "../src/core/read-gates.js";
import { canonicalPath } from "../src/core/paths.js";
import { signIn } from "../src/core/auth/signin.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

describe("readGateFor", () => {
  it("maps registers to their read action and project paths to the project", () => {
    expect(readGateFor("/api/v1/people")).toEqual({ action: "people.view", project: null });
    expect(readGateFor("/api/v1/people/p-x/effective-permissions")).toEqual({ action: "people.view", project: null });
    expect(readGateFor("/api/v1/policies")).toEqual({ action: "policy.view", project: null });
    expect(readGateFor("/api/v1/agents/ag-1/effective")).toEqual({ action: "project.view", project: null });
    expect(readGateFor("/api/v1/agents")).toEqual({ action: "agents.view", project: null });
    expect(readGateFor("/api/v1/trust/cells")).toEqual({ action: "project.view", project: null });
    expect(readGateFor("/api/v1/vendors")).toEqual({ action: "models.view", project: null });
    expect(readGateFor("/api/v1/integrations")).toEqual({ action: "integrations.view", project: null });
    expect(readGateFor("/api/v1/catalog")).toEqual({ action: "project.view", project: null });
    expect(readGateFor("/api/v1/projects/payments/floor")).toEqual({ action: "project.view", project: "payments" });
  });
  it("leaves own data and the can endpoint open", () => {
    for (const u of ["/api/v1/me", "/api/v1/sessions", "/api/v1/signins", "/api/v1/saved-views", "/api/v1/can", "/api/v1/notifications", "/api/v1/stream"]) expect(readGateFor(u), u).toBeNull();
  });
});

describe("canonicalPath", () => {
  it("decodes each segment once, as the router does, so an encoded character cannot dodge a check", () => {
    expect(canonicalPath("/api/v1/%70eople?x=1")).toBe("/api/v1/people");
    expect(canonicalPath("/%61pi/v1/catalog")).toBe("/api/v1/catalog");
    expect(canonicalPath("/%69nternal/v1/runs")).toBe("/internal/v1/runs");
    expect(readGateFor(canonicalPath("/api/v1/%61ccess/matrix")!)).toEqual({ action: "policy.view", project: null });
  });
  it("keeps an encoded slash or percent inside its segment, and the gate's project id equals the router's parameter", () => {
    expect(canonicalPath("/api/v1/projects/a%2Fb/floor")).toBe("/api/v1/projects/a%2Fb/floor");
    expect(readGateFor(canonicalPath("/api/v1/projects/a%2541/floor")!)).toEqual({ action: "project.view", project: "a%41" });
  });
  it("refuses a path that does not decode", () => {
    expect(canonicalPath("/api/v1/%E0%A4%A")).toBeNull();
  });
});

const d = TEST_URL ? describe : describe.skip;

d("default deny for reads", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const get = async (who: string, url: string) => (await t.app.inject({ method: "GET", url, headers: (await t.session(who)).headers })).statusCode;
  const REGISTERS = { people: "/api/v1/people", teams: "/api/v1/teams", policies: "/api/v1/policies", freezes: "/api/v1/freezes", matrix: "/api/v1/access/matrix", agents: "/api/v1/agents", skills: "/api/v1/skills", vendors: "/api/v1/vendors", integrations: "/api/v1/integrations", catalog: "/api/v1/catalog", templates: "/api/v1/templates", home: "/api/v1/home" };

  it("a person with no grants reads none of the registers, and gets the reason", async () => {
    const r = await signIn(t.app.gantry, { sub: "kc-nobody", email: "nobody@acme.dev", emailVerified: true, name: "No Body" }, { ip: "203.0.113.9", userAgent: "vitest", requestId: "r", method: "sso" });
    if (!r.ok) throw new Error("sign-in");
    for (const url of Object.values(REGISTERS)) expect(await get(r.personId, url), url).toBe(403);
    const s = await t.session(r.personId);
    const res = await t.app.inject({ method: "GET", url: "/api/v1/people", headers: s.headers });
    expect(res.json().msg).toMatch(/No role held by No Body/);
    expect(await get(r.personId, "/api/v1/me")).toBe(200);
    expect(await get(r.personId, "/api/v1/projects/payments/floor")).toBe(404);
    for (const url of ["/api/v1/%70eople", "/api/v1/%61ccess/matrix", "/api/v1/%61gents", "/api/v1/%73kills", "/api/v1/%69ntegrations"]) expect(await get(r.personId, url), url).toBe(403);
  });

  it("a percent-encoded prefix does not skip authentication", async () => {
    const res = await t.app.inject({ method: "GET", url: "/%61pi/v1/catalog" });
    expect(res.statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/%E0%A4%A" })).statusCode).toBe(400);
  });

  it("an Engineer on one project reads the catalogue and their project, not the factory registers (they need a factory-level role)", async () => {
    expect(await get("p-tomas", REGISTERS.catalog)).toBe(200);
    for (const k of ["policies", "freezes", "matrix", "vendors"] as const) expect(await get("p-tomas", REGISTERS[k]), k).toBe(403);
    for (const u of ["/api/v1/people/p-asha/effective-permissions", "/api/v1/agents/suites", "/api/v1/mcp/calls", "/api/v1/instructions/base"]) expect(await get("p-tomas", u), u).toBe(403);
    expect(await get("p-tomas", "/api/v1/projects/payments/floor")).toBe(200);
    expect(await get("p-tomas", "/api/v1/projects/risk/floor")).toBe(404);
  });

  it("the plain lists answer someone on a project with a directory of their own projects: who and what works there, nothing more", async () => {
    const read = async (url: string) => {
      const r = await t.app.inject({ method: "GET", url, headers: (await t.session("p-tomas")).headers });
      expect(r.statusCode, url).toBe(200);
      return r.json();
    };
    const mine = new Set((await read("/api/v1/me")).projects.map((p: { id: string }) => p.id));
    const ok = (scope: string, role: string) => mine.has(scope) || (scope === "factory" && role === "factory_admin");
    const people = await read("/api/v1/people");
    const all = await t.app.inject({ method: "GET", url: "/api/v1/people", headers: (await t.session("p-asha")).headers });
    expect(people.length).toBeGreaterThan(0);
    expect(people.length).toBeLessThan(all.json().length);
    for (const p of people) {
      expect(p.roles.length, p.id).toBeGreaterThan(0);
      for (const g of p.roles) expect(ok(g.scope, g.role), `${p.id} ${g.role}@${g.scope}`).toBe(true);
      expect(p.mfa).toBeUndefined();
      expect(p.invitedBy).toBeUndefined();
    }
    for (const tm of await read("/api/v1/teams")) for (const g of tm.roles ?? []) expect(mine.has(g.scope)).toBe(true);
    for (const a of await read("/api/v1/agents")) {
      expect(a.instructions).toBe("");
      expect(a.versions).toEqual([]);
      expect(a.projects === "all" || a.projects.every((x: string) => mine.has(x))).toBe(true);
    }
    for (const sk of await read("/api/v1/skills")) expect(sk.body).toBe("");
    for (const m of await read("/api/v1/mcp/servers")) {
      expect(m.url).toBe("");
      expect(m.authMask).toBe("");
    }
    await read("/api/v1/integrations");
    await read("/api/v1/integration-types");
  });

  it("an Auditor reads the security settings but cannot change them", async () => {
    expect(await get("p-sam", "/api/v1/security")).toBe(200);
    const r = await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: (await t.session("p-sam")).headers, payload: { path: "domains", value: ["acme.dev"] } });
    expect(r.statusCode).toBe(403);
    expect(await get("p-tomas", "/api/v1/security")).toBe(403);
  });

  it("an Auditor and a Factory Admin read every register", async () => {
    for (const who of ["p-sam", "p-asha"]) for (const [k, url] of Object.entries(REGISTERS)) expect(await get(who, url), `${who} ${k}`).toBe(200);
  });

  it("a team grant of a read role opens the register for its members", async () => {
    await t.db.admin.query(`insert into teams (org_id, id, name, description) values ($1,'readers','Readers','')`, [t.orgId]);
    await t.db.admin.query(`insert into team_members (org_id, team_id, person_id) values ($1,'readers','p-tomas')`, [t.orgId]);
    await t.db.admin.query(`insert into team_role_assignments (org_id, id, team_id, role_id, scope_type, project_id) values ($1,'tra-r','readers','auditor','factory',null)`, [t.orgId]);
    const count = async (who: string) => (await t.app.inject({ method: "GET", url: REGISTERS.people, headers: (await t.session(who)).headers })).json().length as number;
    const everyone = await count("p-asha");
    expect(await count("p-tomas")).toBe(everyone);
    expect(await get("p-tomas", REGISTERS.policies)).toBe(200);
    await t.db.admin.query(`update team_role_assignments set revoked_at = now() where id = 'tra-r'`);
    // back to the directory of their own project, and no factory register
    expect(await count("p-tomas")).toBeLessThan(everyone);
    expect(await get("p-tomas", REGISTERS.policies)).toBe(403);
  });

  it("an existing org gains the new read actions with their defaults on start-up, leaving its other cells alone", async () => {
    const { bootstrapOrg } = await import("../src/core/bootstrap.js");
    await t.db.admin.query(`update orgs set settings = jsonb_set(settings, '{catalog,actions}', (select jsonb_agg(a) from jsonb_array_elements(settings->'catalog'->'actions') a where a->>'id' not like '%.view' or a->>'id' in ('project.view','audit.view')))`);
    await t.db.admin.query(`insert into role_matrix_versions (org_id, version, matrix, published_at, published_by) select org_id, version + 1, (select jsonb_object_agg(r, (m.matrix->r) - 'people.view' - 'policy.view' - 'agents.view' - 'models.view' - 'integrations.view') from jsonb_object_keys(m.matrix) r), now(), 'test' from role_matrix_versions m order by version desc limit 1`);
    await bootstrapOrg(t.db.app, t.config);
    const m = (await t.db.admin.query(`select matrix from role_matrix_versions order by version desc limit 1`)).rows[0].matrix;
    expect(m.auditor["people.view"]).toBe(true);
    expect(m.viewer["people.view"]).toBe(false);
    expect(m.engineer["agents.view"]).toBe(false);
    const cat = (await t.db.admin.query(`select jsonb_array_length(settings->'catalog'->'actions') n from orgs`)).rows[0].n;
    expect(cat).toBeGreaterThan(40);
  });
});
