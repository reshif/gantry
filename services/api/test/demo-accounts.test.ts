import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoAccountList, summariseRoles } from "../src/areas/access/demo.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;

type Acc = { id: string; name: string; email: string; role: string; note: string };
const sign = async (t: TestApp): Promise<{ demoAccounts: boolean; demoAccountList?: Acc[] }> => {
  const r = await t.app.inject({ method: "GET", url: "/api/v1/me" });
  expect(r.statusCode).toBe(401);
  return r.json().config;
};

describe("demoAccountList (pure)", () => {
  const st = {
    projects: [{ id: "pay", name: "Payments", status: "active" as const }],
    teams: [{ id: "t1", name: "Payments Team" }],
    matrix: { engineer: { "wo.submit": true }, factory_admin: { "policy.edit": true } },
    catalog: { roles: [{ id: "engineer", name: "Engineer", level: "project" as const }, { id: "factory_admin", name: "Factory Admin", level: "factory" as const }] },
    people: [
      { id: "p-a", name: "A", email: "a@x.dev", title: "", teams: ["t1"], roles: [{ role: "engineer", scope: "pay" }, { role: "engineer", scope: "pay", via: "t1" }], status: "active", oncall: true, github: "", away: null },
      { id: "p-b", name: "B", email: "b@x.dev", title: "", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null },
      { id: "p-c", name: "C", email: "c@x.dev", title: "", teams: [], roles: [], status: "deactivated", oncall: false, github: "", away: null },
      { id: "p-d", name: "D", email: "d@x.dev", title: "", teams: [], roles: [], status: "invited", oncall: false, github: "", away: null },
    ],
  } as unknown as Parameters<typeof demoAccountList>[0];
  const logins = ["a", "b", "c", "d", "e", "f"].map((x) => ({ email: `${x}@x.dev`, name: x.toUpperCase() }));

  it("summarises direct and team roles with their scope and source", () => {
    expect(summariseRoles(st.people[0]!, st)).toBe("Engineer on Payments; Engineer on Payments (via Payments Team)");
    expect(summariseRoles(st.people[1]!, st)).toBe("Factory Admin");
  });
  it("shows actual roles, hides deactivated, labels unknown and invited, and never claims MFA", () => {
    const l = demoAccountList(st, { logins, bootstrapEmail: "f@x.dev" });
    expect(l.map((x) => x.email)).toEqual(["a@x.dev", "b@x.dev", "d@x.dev", "e@x.dev", "f@x.dev"]);
    expect(l[0]!.note).toMatch(/Teams: Payments Team\. On call\./);
    expect(l[1]!.note).toMatch(/fresh sign-in/);
    expect(l[0]!.note).not.toMatch(/fresh sign-in/);
    expect(l[2]).toMatchObject({ role: "No roles yet" });
    expect(l[2]!.note).toMatch(/Invited/);
    expect(l[3]).toMatchObject({ role: "No roles yet" });
    expect(l[4]!.role).toMatch(/Factory Admin/);
    expect(JSON.stringify(l)).not.toMatch(/MFA/);
  });
});

d("publicConfig demo list", () => {
  describe("seeded org", () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await startApp();
    });
    afterAll(() => t.close());
    it("describes each demo user from real grants, including team-inherited ones", async () => {
      let list = (await sign(t)).demoAccountList!;
      expect(list.length).toBeGreaterThan(10);
      expect(list.find((x) => x.email === "asha@acme.dev")).toMatchObject({ id: "p-asha", role: "Factory Admin" });
      expect(list.find((x) => x.email === "tomas@acme.dev")!.role).toBe("Engineer on Payments Platform");
      expect(JSON.stringify(list)).not.toMatch(/MFA/);
      await t.db.admin.query(`insert into teams (org_id, id, name, description) values ($1,'qa','QA','')`, [t.orgId]);
      await t.db.admin.query(`insert into team_members (org_id, team_id, person_id) values ($1,'qa','p-tomas')`, [t.orgId]);
      await t.db.admin.query(`insert into team_role_assignments (org_id, id, team_id, role_id, scope_type, project_id) values ($1,'tra-x','qa','reviewer','project','storefront')`, [t.orgId]);
      list = (await sign(t)).demoAccountList!;
      expect(list.find((x) => x.email === "tomas@acme.dev")!.role).toBe("Engineer on Payments Platform; Reviewer on Storefront (via QA)");
      await t.db.admin.query(`update people set status = 'deactivated' where id = 'p-sam'`);
      expect((await sign(t)).demoAccountList!.some((x) => x.email === "sam@acme.dev")).toBe(false);
    });
  });

  describe("empty org", () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await startApp({ seed: false, config: { bootstrapAdminEmail: "asha@acme.dev" } });
    });
    afterAll(() => t.close());
    it("lists demo users as having no roles, except the bootstrap admin", async () => {
      const list = (await sign(t)).demoAccountList!;
      expect(list.find((x) => x.email === "tomas@acme.dev")).toMatchObject({ role: "No roles yet" });
      expect(list.find((x) => x.email === "asha@acme.dev")!.role).toMatch(/Factory Admin \(first sign-in\)/);
    });
  });

  it("sends no list when demo sign-in is off", async () => {
    const t = await startApp({ config: { demoAccounts: false } });
    try {
      const c = await sign(t);
      expect(c.demoAccounts).toBe(false);
      expect(c.demoAccountList).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});
