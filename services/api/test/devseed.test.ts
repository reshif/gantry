import { isOnCall } from "@gantry/domain";
import { devSeed } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapOrg } from "../src/core/bootstrap.js";
import { readCatalog, readFreezes, readMatrix, readPeople, readPolicies, readProjects, readRepos, readRoles, readSecurity, readTeams, readTemplates } from "../src/core/read/index.js";
import { loadFlowState, loadPolicyState } from "../src/core/read/state.js";
import { can } from "@gantry/domain";
import { TEST_URL, startApp, testConfig, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const strip = <T extends object>(o: T, ...keys: string[]): object => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

d("dev seed loader and read mappers (rows -> legacy shapes)", () => {
  let t: TestApp;
  const NOW = 1_800_000_000_000;
  const seed = devSeed(NOW);
  const raw = seed.state as unknown as Record<string, Array<Record<string, any>>>;
  const S = { people: raw.people!, projects: raw.projects!, teams: raw.teams!, templates: raw.templates!, policies: raw.policies!, freezes: raw.freezes!, repos: raw.repos! };
  beforeAll(async () => {
    t = await startApp({ seedNow: NOW, build: { routes: async () => undefined } });
  });
  afterAll(() => t.close());

  it("is idempotent: a second startup changes nothing and loads no second org", async () => {
    const count = async () => (await t.db.admin.query(`select (select count(*) from people) p, (select count(*) from projects) pr, (select count(*) from orgs) o, (select count(*) from events) e`)).rows[0];
    const before = await count();
    const again = await bootstrapOrg(t.db.app, testConfig(), undefined, { seedNow: NOW });
    expect(again).toEqual({ orgId: t.orgId, seeded: false });
    expect(await count()).toEqual(before);
  });

  it("people round-trip, including roles, teams, away, on-call and legacy extras", async () => {
    const got = (await readPeople(t.db.app, t.orgId)) as unknown as Array<Record<string, unknown>>;
    // `mfa` is a boolean column: absent in the seed reads back as false.
    const norm = (ps: Array<Record<string, any>>) => ps.map(({ version: _v, ...p }) => ({ mfa: false, ...p, teams: [...p.teams].sort() }));
    // on call is read back derived (owner decision 7): on call for any project, or a Factory Admin; the seed's global switch is not stored
    const want = S.people.map((p) => ({ ...p, oncall: isOnCall(S as never, p, null) }));
    expect(norm(got)).toEqual(norm(want as never));
    expect(got.map((p) => p.id)).toEqual(S.people.map((p) => p.id)); // seed order kept
  });

  it("teams, templates, matrix, policies, freezes round-trip", async () => {
    expect((await readTeams(t.db.app, t.orgId)).map(({ roles: _r, ...x }) => x)).toEqual(S.teams); // roles: the team grants, none seeded
    expect((await readTemplates(t.db.app, t.orgId)).map((x) => strip(x, "version"))).toEqual(S.templates);
    expect((await readMatrix(t.db.app, t.orgId)).value).toEqual(seed.state.matrix);
    expect((await readPolicies(t.db.app, t.orgId)).map((x) => strip(x, "version"))).toEqual(S.policies);
    expect((await readFreezes(t.db.app, t.orgId)).map((x) => strip(x, "version"))).toEqual(S.freezes);
  });

  it("projects round-trip: flow, approvers, notifications, budget, teams, extras", async () => {
    const got = (await readProjects(t.db.app, t.orgId)).map((p) => strip(p, "version")) as Array<Record<string, any>>;
    const norm = (ps: Array<Record<string, any>>) => ps.map((p) => ({ ...p, teams: [...p.teams].sort() })) as Array<Record<string, any>>;
    expect(norm(got).map((p) => p.id)).toEqual(S.projects.map((p) => p.id));
    for (const [i, p] of norm(S.projects as never).entries()) {
      const g = norm(got)[i]!;
      // created timestamps pass through ms -> timestamptz; compare to the millisecond
      expect(g, p.id).toEqual(p);
    }
  });

  it("repos round-trip: config, onboarding record, notify overrides, triggers, source", async () => {
    const got = (await readRepos(t.db.app, t.orgId)).map((r) => strip(r, "version"));
    expect(got).toEqual(S.repos);
  });

  it("roles, catalogue and security settings round-trip (the demo IP allow-list is not loaded)", async () => {
    const cat = await readCatalog(t.db.app, t.orgId);
    expect(cat.stations).toEqual(seed.catalog.stations);
    expect(cat.gates).toEqual(seed.catalog.gates);
    expect(cat.bays).toEqual(seed.catalog.bays);
    expect(cat.classes).toEqual(seed.catalog.classes);
    expect(cat.actions).toEqual(seed.catalog.actions);
    expect((await readRoles(t.db.app, t.orgId)).map((x) => strip(x, "version"))).toEqual(seed.catalog.roles);
    const sec = await readSecurity(t.db.app, t.orgId);
    expect(sec.value).toEqual({ killNeedsStepUp: true, stepUpWindowMinutes: 15, ...(seed.state.security as object), ipAllow: [], researchHosts: [], chatCapUsdPerDay: null });
  });

  it("the loaded policy state decides exactly like the in-memory seed", async () => {
    const st = await loadPolicyState(t.db.app, t.orgId);
    const now = Date.now();
    let n = 0;
    for (const p of seed.state.people) {
      for (const a of seed.catalog.actions) {
        for (const project of ["payments", "storefront", null]) {
          const real = can(st, p.id, a.id, { project, time: now });
          const ref = can(seed.state as never, p.id, a.id, { project, time: now });
          expect(real.allowed, `${p.id} ${a.id} ${project}`).toBe(ref.allowed);
          expect(real.rule.id).toBe(ref.rule.id);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
    const flow = await loadFlowState(t.db.app, t.orgId);
    expect(flow.projects).toHaveLength(S.projects.length);
    expect(flow.catalog.stations.length).toBe(seed.catalog.stations.length);
  });

  it("loads inside a transaction too (one client, sequential reads)", async () => {
    const c = await t.db.app.connect();
    try {
      await c.query("begin");
      const st = await loadPolicyState(c, t.orgId);
      expect(st.people).toHaveLength(S.people.length);
      await c.query("commit");
    } finally {
      c.release();
    }
  });

  it("a seeded stop becomes an active stops row and shows in the policy state", async () => {
    await t.db.admin.query(`insert into stops (org_id, id, scope_type, project_id, mode, reason, in_flight, set_by) values ($1,'project:risk:1','project','risk','halt','Andon pulled',null,'p-asha')`, [t.orgId]);
    const st = await loadPolicyState(t.db.app, t.orgId);
    expect(st.projects.find((p) => p.id === "risk")?.halted).toMatchObject({ by: "p-asha", reason: "Andon pulled" });
    await t.db.admin.query(`delete from stops where id = 'project:risk:1'`);
  });
});
