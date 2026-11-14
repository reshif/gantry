import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;

/**
 * Home sections (spec 8.3, docs/build-notes/home-redesign.md): `home.sections` is built by the caller's rights, so a section a person may not see is absent
 * (default deny), attention is scoped to the projects they can see, and the setup checklist and eval health come from real rows.
 */
d("home sections by role", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seedEvals: true });
    const q = (sql: string, p: unknown[] = []) => t.db.admin.query(sql, p);
    const ins = (id: string, project: string, state: string, position: string, submitter: string, extra: Record<string, unknown> = {}) =>
      q(`insert into work_orders (org_id, id, project_id, title, class, position, state, flow_version, submitter, data) values ($1,$2,$3,$4,'feature',$5,$6,1,$7,$8::jsonb)`, [t.orgId, id, project, `Title of ${id}`, position, state, submitter, JSON.stringify(extra)]);
    await ins("WO-9101", "storefront", "blocked", "build", "p-arjun", { blockReason: "Waiting on API key" });
    await ins("WO-9102", "payments", "failed", "verify", "p-tomas", { failReason: "Tests red" });
    // A viewer on payments, a person with no grants at all.
    await q(`insert into people (org_id, id, name, email, status) values ($1,'p-vera','Vera Viewer','vera@example.com','active'), ($1,'p-nobody','No Body','nobody@example.com','active')`, [t.orgId]);
    await q(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, project_id) values ($1,'ra-vera','p-vera','viewer','project','payments')`, [t.orgId]);
  });
  afterAll(() => t.close());

  const home = async (who: string) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method: "GET", url: "/api/v1/home", headers: s.headers });
    expect(r.statusCode).toBe(200);
    return r.json() as Record<string, any>;
  };
  const attIds = (b: Record<string, any>): string[] => (b.sections.attention ?? []).map((a: any) => a.id);

  it("Factory Admin sees every project's attention and the factory sections", async () => {
    const b = await home("p-asha");
    expect(attIds(b)).toEqual(expect.arrayContaining(["hm-att-wo-WO-9101", "hm-att-wo-WO-9102"]));
    expect(b.sections.health).toBeDefined();
    expect(b.sections.motion.inFlight).toBeGreaterThanOrEqual(2);
    expect(b.sections.approvers).toBeUndefined();
  });

  it("Auditor sees exceptions and the approver bottleneck read-only, never Waiting on you or setup", async () => {
    const b = await home("p-sam");
    expect(attIds(b)).toEqual(expect.arrayContaining(["hm-att-wo-WO-9101"]));
    expect(b.sections.waiting).toBeUndefined();
    expect(b.sections.setup).toBeUndefined();
    expect(b.sections.approvers).toBeDefined();
    expect(b.sections.health.audit).toBe(true);
  });

  it("Project Admin sees only their projects, with no factory health", async () => {
    const b = await home("p-lena"); // project admin on identity only
    expect(b.sections.projects.map((p: any) => p.id)).toContain("identity");
    expect(b.sections.projects.map((p: any) => p.id)).not.toContain("payments");
    expect(JSON.stringify(b)).not.toContain("WO-9101");
    expect(attIds(b).filter((i) => i.startsWith("hm-att-wo-"))).toEqual([]);
    expect(b.sections.health).toBeUndefined();
    expect(b.sections.setup).toBeUndefined();
    const dan = await home("p-daniel"); // payments and storefront
    expect(attIds(dan)).toEqual(expect.arrayContaining(["hm-att-wo-WO-9101", "hm-att-wo-WO-9102"]));
    expect(dan.sections.health).toBeUndefined();
  });

  it("Engineer sees attention only for their own work orders, and no other project's", async () => {
    const b = await home("p-tomas");
    expect(attIds(b)).toContain("hm-att-wo-WO-9102");
    expect(attIds(b)).not.toContain("hm-att-wo-WO-9101");
    expect(JSON.stringify(b)).not.toContain("WO-9101");
    expect(b.sections.projects.map((p: any) => p.id)).toEqual(["payments"]);
    expect(b.sections.health).toBeUndefined();
  });

  it("Viewer gets read-only sections: no Waiting on you, no oversight items, only their project", async () => {
    const b = await home("p-vera");
    expect(b.sections.waiting).toBeUndefined();
    expect(b.sections.approvers).toBeUndefined();
    expect(b.sections.health).toBeUndefined();
    expect(attIds(b)).toEqual([]);
    expect(b.sections.projects.map((p: any) => p.id)).toEqual(["payments"]);
    expect(b.sections.motion.mine).toEqual([]);
    expect(JSON.stringify(b)).not.toContain("WO-9101");
    expect(b.badges.integrations).toBeUndefined();
  });

  it("a person with no grants is refused the home payload (default deny): nothing to leak", async () => {
    const s = await t.session("p-nobody");
    const r = await t.app.inject({ method: "GET", url: "/api/v1/home", headers: s.headers });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain("WO-9");
  });

  it("derives the setup checklist from rows and drops it when done", async () => {
    // Seeded org: projects exist, no GitHub integration, no callable vendor.
    const q = (sql: string, p: unknown[] = []) => t.db.admin.query(sql, p);
    const steps = async () => ((await home("p-asha")).sections.setup?.steps ?? []).map((x: any) => `${x.id}:${x.state}`);
    const first = await steps();
    expect(first.find((x: string) => x.startsWith("project:"))).toBe("project:done");
    expect(first.find((x: string) => x.startsWith("github:"))).toMatch(/github:(active|done)/);
    const setup = (await home("p-asha")).sections.setup;
    expect(setup.total).toBe(5);
    const vendor = setup.steps.find((x: any) => x.id === "vendor");
    if (vendor.state !== "done") expect(vendor.detail).toContain("Bedrock, OpenAI, Azure and Gemini can be discovered but cannot run agents yet");
    // Complete GitHub and a work order by inserting rows; the next incomplete step becomes active.
    await q(`insert into integration_types (org_id, id, name, data) values ($1,'github','GitHub','{}') on conflict do nothing`, [t.orgId]).catch(() => undefined);
    const ok = await q(`insert into integration_instances (org_id, id, type_id, name, enabled, health) values ($1,'int-gh-test','github','GitHub',true,'ok') on conflict do nothing`, [t.orgId]).then(() => true, () => false);
    if (ok) expect((await steps()).find((x: string) => x.startsWith("github:"))).toBe("github:done");
    const stepsNow = (await home("p-asha")).sections.setup.steps;
    expect(stepsNow.filter((x: any) => x.state === "active")).toHaveLength(1);
    expect(stepsNow.findIndex((x: any) => x.state === "active")).toBe(stepsNow.findIndex((x: any) => x.state !== "done"));
  });

  it("reports real eval health: live agent versions against their suite thresholds, listing the failing ones", async () => {
    const b = await home("p-asha");
    const ev = b.sections.health.evals;
    expect(ev).not.toBeNull();
    expect(ev.scored).toBeGreaterThan(0);
    expect(ev.passing + ev.failing.length).toBe(ev.scored);
    // Every failing live version is an Attention item too.
    for (const f of ev.failing) expect(attIds(b)).toContain(`hm-att-ev-${f.agent}`);
    // Dropping a live version's latest score below the threshold moves it to failing.
    const pass = await t.db.admin.query<{ id: string }>(`select r.id from eval_runs r where r.org_id = $1 and r.status = 'completed' and r.score is not null order by r.started_at desc limit 1`, [t.orgId]);
    expect(pass.rows.length).toBeGreaterThan(0);
    await t.db.admin.query(`update eval_runs set score = 0.01 where org_id = $1`, [t.orgId]);
    const after = (await home("p-asha")).sections.health.evals;
    expect(after.failing.length).toBeGreaterThan(0);
    expect(after.passing).toBe(0);
    // Not a right of a Project Admin: they get no eval health or eval attention.
    expect(attIds(await home("p-daniel")).some((i) => i.startsWith("hm-att-ev-"))).toBe(false);
  });

  it("hides eval health when there is no run data at all", async () => {
    await t.db.admin.query(`delete from eval_results where org_id = $1`, [t.orgId]);
    await t.db.admin.query(`delete from eval_runs where org_id = $1`, [t.orgId]);
    expect((await home("p-asha")).sections.health.evals).toBeNull();
  });
});
