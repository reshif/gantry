import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapOrg } from "../src/core/bootstrap.js";
import { teamIdFrom } from "../src/areas/people/teams.js";
import { TEST_URL, createTestDb, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";
const engineer = "p-tomas"; // no people.manage

describe("teamIdFrom", () => {
  it("makes a lower-case hyphenated id", () => {
    expect(teamIdFrom("Internal Tools")).toBe("internal-tools");
    expect(teamIdFrom("  Data & ML!! ")).toBe("data-ml");
    expect(teamIdFrom("***")).toBe("");
  });
});

d("teams", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  type M = "GET" | "POST" | "PATCH" | "DELETE";
  const call = async (who: string, method: M, url: string, payload?: unknown) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url, headers: s.headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };
  const teams = async () => (await call(admin, "GET", "/api/v1/teams")).body as unknown as Array<{ id: string; name: string; desc: string }>;
  const ev = async (type: string) => (await t.db.admin.query(`select * from events where type = $1 order by seq`, [type])).rows;

  it("creates a team with an id from its name, and audits it", async () => {
    const r = await call(admin, "POST", "/api/v1/teams", { name: "Developer Experience", desc: "Tooling and CI." });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, team: { id: "developer-experience", name: "Developer Experience", desc: "Tooling and CI." } });
    expect((await teams()).some((x) => x.id === "developer-experience")).toBe(true);
    expect((await ev("teams.create")).length).toBe(1);
  });

  it("refuses a duplicate name or id", async () => {
    expect((await call(admin, "POST", "/api/v1/teams", { name: "developer experience" })).status).toBe(409);
    expect((await call(admin, "POST", "/api/v1/teams", { name: "Platform Two", id: "platform" })).status).toBe(409);
  });

  it("refuses a name with no letters or digits, and a too-short name", async () => {
    expect((await call(admin, "POST", "/api/v1/teams", { name: "***" })).status).toBe(422);
    expect((await call(admin, "POST", "/api/v1/teams", { name: "x" })).status).toBe(422);
  });

  it("needs people.manage", async () => {
    expect((await call(engineer, "POST", "/api/v1/teams", { name: "Shadow Team" })).status).toBe(403);
    expect((await call(engineer, "PATCH", "/api/v1/teams/developer-experience", { name: "Hijacked" })).status).toBe(403);
    expect((await call(engineer, "DELETE", "/api/v1/teams/developer-experience")).status).toBe(403);
  });

  it("renames a team, keeping its id, and refuses a clash", async () => {
    const r = await call(admin, "PATCH", "/api/v1/teams/developer-experience", { name: "DevEx" });
    expect(r.status).toBe(200);
    expect((await teams()).find((x) => x.id === "developer-experience")).toMatchObject({ name: "DevEx", desc: "Tooling and CI." });
    expect((await call(admin, "PATCH", "/api/v1/teams/developer-experience", { name: "Platform" })).status).toBe(409);
    expect((await call(admin, "PATCH", "/api/v1/teams/nope", { name: "Nope" })).status).toBe(404);
    expect((await ev("teams.update")).length).toBe(1);
  });

  it("refuses to delete a team that owns projects", async () => {
    const r = await call(admin, "DELETE", "/api/v1/teams/platform");
    expect(r.status).toBe(409);
    expect(r.body.msg).toMatch(/owns .*project/);
  });

  it("deletes a team, removing its memberships only", async () => {
    await t.db.admin.query(`insert into team_members (org_id, team_id, person_id) values ($1, 'developer-experience', $2)`, [t.orgId, admin]);
    const r = await call(admin, "DELETE", "/api/v1/teams/developer-experience");
    expect(r.status).toBe(200);
    expect(r.body.msg).toMatch(/1 member was removed/);
    expect((await teams()).some((x) => x.id === "developer-experience")).toBe(false);
    const asha = ((await call(admin, "GET", "/api/v1/people")).body as unknown as Array<{ id: string; teams: string[]; roles: unknown[] }>).find((p) => p.id === admin)!;
    expect(asha.teams).toEqual(["platform"]);
    expect(asha.roles.length).toBeGreaterThan(0);
    expect((await ev("teams.delete"))[0]).toBeTruthy();
  });
});

d("bootstrap of an empty org", () => {
  it("creates one Default team and the built-in templates, once", async () => {
    const db = await createTestDb();
    try {
      const cfg = { orgSlug: "empty", orgName: "Empty", devSeed: false };
      const { orgId } = await bootstrapOrg(db.admin, cfg);
      await bootstrapOrg(db.admin, cfg);
      const tm = await db.admin.query(`select id, name from teams where org_id = $1`, [orgId]);
      expect(tm.rows).toEqual([{ id: "default", name: "Default" }]);
      const tp = await db.admin.query(`select count(*)::int as n from templates where org_id = $1 and builtin`, [orgId]);
      expect(tp.rows[0].n).toBeGreaterThan(0);
    } finally {
      await db.drop();
    }
  });
});
