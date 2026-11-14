import { verifyChain } from "@gantry/db";
import { routeGates } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { withVersion } from "./versions.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";
const pAdmin = "p-daniel"; // project_admin on payments and storefront
const engineer = "p-tomas"; // engineer on payments: no project.config, flow.edit, project.members, project.archive
const owner = "p-hana"; // owner of checkout-next: project_admin there
const viewer = "p-rui"; // viewer on payments

d("projects", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const call = async (who: string, method: M, url: string, payload?: unknown, extra: Record<string, string> = {}) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method, url, headers: { ...s.headers, ...(await withVersion(t.db.admin, method, url, extra)) }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.json() as Record<string, any>, headers: r.headers };
  };
  const proj = async (id: string, who = admin) => (await call(who, "GET", `/api/v1/projects/${id}`)).body as Record<string, any>;
  const events = async (type: string) => (await t.db.admin.query(`select * from events where type = $1 order by seq`, [type])).rows;
  const ifm = (v: number) => ({ "if-match": String(v) });
  const create = (name: string, extra: Record<string, unknown> = {}, who = admin) => call(who, "POST", "/api/v1/projects", { name, templateId: "tpl-backend", teams: ["payments"], ...extra });
  const insertWo = (project: string, id: string, position: string, cls = "feature", state = "running") =>
    t.db.admin.query(
      `insert into work_orders (org_id, id, project_id, title, class, position, state, flow_version) values ($1,$2,$3,'t',$4,$5,$6,(select current_flow_version from projects where org_id = $1 and id = $3))`,
      [t.orgId, id, project, cls, position, state],
    );

  /** Every command refuses a caller without the right (403, audited as <action>.denied) and a stale If-Match (409). */
  const denied = async (who: string, method: M, url: string, action: string, payload?: unknown) => {
    const before = (await events(`${action}.denied`)).length;
    const r = await call(who, method, url, payload);
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
    const after = await events(`${action}.denied`);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1).outcome).toBe("denied");
  };
  const stale = async (who: string, method: M, url: string, payload?: unknown) => {
    const r = await call(who, method, url, payload, ifm(9999));
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(String(r.body.msg)).toMatch(/changed|reload/i);
  };

  describe("If-Match is required on versioned config endpoints", () => {
    it("a config write without If-Match is a 409 'version required', changes nothing, and an unknown project is still a 404", async () => {
      const s = await t.session(admin);
      const send = (method: M, url: string, payload?: unknown) => t.app.inject({ method, url, headers: s.headers, ...(payload === undefined ? {} : { payload: payload as object }) });
      const before = (await proj("payments")).desc;
      const r = await send("PATCH", "/api/v1/projects/payments/config", { path: "desc", value: "changed blind" });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ ok: false, msg: expect.stringMatching(/version required/i) });
      expect((await proj("payments")).desc).toBe(before);
      expect((await send("POST", "/api/v1/projects/payments/archive", { confirmText: "x" })).statusCode).toBe(409);
      expect((await send("PATCH", "/api/v1/projects/nope/config", { path: "desc", value: "x" })).statusCode).toBe(404);
      // with the version it goes through
      const ok = await call(admin, "PATCH", "/api/v1/projects/payments/config", { path: "desc", value: before }, ifm((await proj("payments")).version));
      expect(ok.status).toBe(200);
    });
  });

  describe("reads", () => {
    it("lists every project for a factory admin, with metrics and versions", async () => {
      const r = await call(admin, "GET", "/api/v1/projects");
      expect(r.status).toBe(200);
      const list = r.body as unknown as any[];
      expect(list.map((p) => p.id)).toContain("legacy-checkout");
      const pay = list.find((p) => p.id === "payments");
      expect(pay).toMatchObject({ key: "PAY", status: "active", template: "tpl-backend", flow: { slots: expect.any(Number) } });
      expect(typeof pay.version).toBe("number");
      expect(pay.metrics).toMatchObject({ wip: 0, bays: 0, gates: 0, effN: 0, cov: { total: 0 }, health: { id: "ok" } });
      expect(list.find((p) => p.id === "identity").metrics.health.id).toBe("new");
      expect(list.find((p) => p.id === "legacy-checkout").metrics.health.id).toBe("archived");
    });
    it("shows a project member only their projects", async () => {
      const list = (await call(engineer, "GET", "/api/v1/projects")).body as unknown as any[];
      expect(list.map((p) => p.id)).toEqual(["payments"]);
      expect((await call(engineer, "GET", "/api/v1/projects/risk")).status).toBe(404);
      expect((await call(engineer, "GET", "/api/v1/projects/payments")).status).toBe(200);
    });
    it("needs a signed-in person", async () => {
      expect((await t.app.inject({ method: "GET", url: "/api/v1/projects" })).statusCode).toBe(401);
    });
    it("computes portfolio metrics from the tables: work in flight, bays, blocked work, gates, health", async () => {
      await insertWo("risk", "WO-M1", "build", "bug", "running");
      await insertWo("risk", "WO-M2", "build", "feature", "blocked");
      await insertWo("risk", "WO-M3", "hold", "feature", "parked");
      await t.db.admin.query(`insert into gate_instances (org_id, id, wo_id, gate_id, station, status, flow_version, opened_at) values ($1,'gi-m1','WO-M1','G2','spec','open',1, now() - interval '48 hours')`, [t.orgId]);
      const m = (await proj("risk")).metrics;
      expect(m).toMatchObject({ wip: 2, bays: 1, bad: 1, gates: 1, byClass: { bug: 1, feature: 2 }, byPosition: { build: { n: 2, blocked: 1 }, hold: { n: 1, blocked: 0 } }, byGate: { G2: 1 }, health: { id: "attention" } });
      expect(m.oldest).toBeGreaterThan(47 * 3_600_000);
      await t.db.admin.query(`delete from gate_instances where id = 'gi-m1'`);
      await t.db.admin.query(`update work_orders set state = 'done', closed_at = now() where id in ('WO-M1','WO-M2','WO-M3')`);
      expect((await proj("risk")).metrics).toMatchObject({ wip: 0, bays: 0, effN: 3, health: { id: "ok" } });
    });
    it("serves the approver and notification presets for the wizard", async () => {
      const r = await call(engineer, "GET", "/api/v1/project-presets");
      expect(r.status).toBe(200);
      expect(r.body.approvers.strict.G5.required).toBe(2);
      expect(r.body.approvers.light.G5.roles).toContain("engineer");
      expect(r.body.routes.standard.map((x: any) => x.event)).toContain("kill");
      expect(r.body.routes.light.length).toBeLessThan(r.body.routes.standard.length);
      expect((await t.app.inject({ method: "GET", url: "/api/v1/project-presets" })).statusCode).toBe(401);
    });
    it("lists templates", async () => {
      const list = (await call(engineer, "GET", "/api/v1/templates")).body as unknown as any[];
      expect(list.map((x) => x.id)).toContain("tpl-regulated");
      expect(list[0]).toMatchObject({ builtIn: true, approverPreset: expect.any(String), version: 1 });
    });
  });

  describe("createProject", () => {
    it("creates a project from a template: flow v1, approvers, routes, budget, owner as project admin", async () => {
      const r = await create("Checkout Next", { key: "cnx", desc: "Next checkout", budget: 2500, owner: "p-hana" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, msg: "Checkout Next created.", project: { id: "checkout-next", key: "CNX", status: "new", template: "tpl-backend", owner: "p-hana", desc: "Next checkout" } });
      const p = await proj("checkout-next");
      expect(p.budget).toMatchObject({ monthly: 2500, alertAt: 0.8 });
      expect(p.teams).toEqual(["payments"]);
      expect(p.flow.order.length).toBeGreaterThan(5);
      expect(Object.keys(p.approvers)).toContain("G5");
      expect(p.notifications.length).toBeGreaterThan(5);
      const hana = ((await call(admin, "GET", "/api/v1/people")).body as unknown as any[]).find((x) => x.id === "p-hana");
      expect(hana.roles).toContainEqual({ role: "project_admin", scope: "checkout-next" });
      const e = (await events("project.create")).at(-1);
      expect(e).toMatchObject({ actor: admin, project_id: "checkout-next", outcome: "ok" });
      expect((await events("role.grant")).some((x) => x.project_id === "checkout-next")).toBe(true);
    });
    it("is idempotent with an Idempotency-Key", async () => {
      const k = { "idempotency-key": "create-idem-1" };
      const a = await call(admin, "POST", "/api/v1/projects", { name: "Idem Project", templateId: "tpl-web", teams: ["growth"] }, k);
      const b = await call(admin, "POST", "/api/v1/projects", { name: "Idem Project", templateId: "tpl-web", teams: ["growth"] }, k);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.headers["idempotent-replayed"]).toBe("true");
      const n = (await t.db.admin.query(`select count(*)::int as n from projects where id = 'idem-project'`)).rows[0].n;
      expect(n).toBe(1);
      const c = await call(admin, "POST", "/api/v1/projects", { name: "Idem Other", templateId: "tpl-web", teams: [] }, k);
      expect(c.status).toBe(409);
    });
    it("numbers a derived key that is taken, but refuses a taken key the caller typed", async () => {
      const a = await create("Payroll Core");
      const b = await create("Payroll Edge");
      expect(a.body.project.key).toBe("PAY2");
      expect(b.body.project.key).toBe("PAY3");
    });
    it("refuses a duplicate name, a taken key, a short name, an unknown template or team", async () => {
      expect((await create("Checkout Next")).status).toBe(409);
      const k = await create("Another One", { key: "PAY" });
      expect(k.status).toBe(409);
      expect(k.body.msg).toMatch(/PAY/);
      expect((await create("ab")).status).toBe(422);
      expect((await create("Bad Tpl", { templateId: "nope" })).status).toBe(422);
      expect((await create("Bad Team", { teams: ["nope"] })).status).toBe(422);
      expect((await create("Bad Owner", { owner: "p-nobody" })).status).toBe(422);
    });
    it("takes approver and notification overrides from the wizard, and refuses rules naming unknown roles", async () => {
      const presets = (await call(admin, "GET", "/api/v1/project-presets")).body;
      const rules = { ...presets.approvers.strict };
      const routes = presets.routes.standard.filter((r: any) => r.event !== "released");
      const r = await create("Strict Shop", { approvers: rules, notifications: routes });
      expect(r.status).toBe(200);
      const p = await proj("strict-shop");
      expect(p.approvers.G5.required).toBe(2);
      expect(p.notifications.some((n: any) => n.event === "released")).toBe(false);
      const bad = await create("Odd Shop", { approvers: { ...rules, G5: { ...rules.G5, roles: ["nope_role"] } } });
      expect(bad.status).toBe(422);
    });
    it("is denied without project.create, and audited", async () => {
      await denied(pAdmin, "POST", "/api/v1/projects", "project.create", { name: "Nope Project", templateId: "tpl-backend", teams: [] });
      expect((await t.db.admin.query(`select 1 from projects where id = 'nope-project'`)).rowCount).toBe(0);
    });
    it("carries a template's custom entries into the new project and reports what was added", async () => {
      // a custom bay and class on a source project, saved as a template, then used
      const src = await proj("checkout-next");
      await call(admin, "POST", "/api/v1/projects/checkout-next/flow/bays", { def: { name: "Legal Hold", desc: "Waiting on legal" } }, ifm(src.version));
      const src2 = await proj("checkout-next");
      const cls = await call(admin, "POST", "/api/v1/projects/checkout-next/flow/classes", { def: { name: "Compliance Fix", skips: ["design"], priority: "P1", slaH: 24, est: "M" } }, ifm(src2.version));
      expect(cls.status).toBe(200);
      const tpl = await call(admin, "POST", "/api/v1/templates", { fromProject: "checkout-next", name: "Checkout kit" });
      expect(tpl.status).toBe(200);
      expect(tpl.body.msg).toMatch(/Carries 2 custom flow entries: bay Legal Hold, class Compliance Fix/);
      const made = await call(admin, "POST", "/api/v1/projects", { name: "Kit Project", templateId: tpl.body.template.id, teams: ["payments"] });
      expect(made.status).toBe(200);
      expect(made.body.custom.done.sort()).toEqual(["Compliance Fix", "Legal Hold"]);
      const p = await proj("kit-project");
      expect(p.flow.bays).toContain("legal-hold");
      expect(p.flow.classes.map((c: any) => c.id)).toContain("compliance-fix");
    });
  });

  describe("config", () => {
    it("sets description, slots, budget and station WIP, each publishing a new version", async () => {
      let p = await proj("checkout-next");
      const url = "/api/v1/projects/checkout-next/config";
      let r = await call(owner, "PATCH", url, { path: "desc", value: "Checkout, v2" }, ifm(p.version));
      expect(r.status).toBe(200);
      expect(r.body.msg).toBe("Saved desc.");
      p = await proj("checkout-next");
      expect(p.desc).toBe("Checkout, v2");
      const v0 = (await t.db.admin.query(`select max(version)::int as v from flow_versions where project_id = 'checkout-next'`)).rows[0].v;
      r = await call(admin, "PATCH", url, { path: "flow.slots", value: 3 }, ifm(p.version));
      expect(r.status).toBe(200);
      expect(r.body.flowVersion).toBe(v0 + 1);
      p = await proj("checkout-next");
      expect(p.flow.slots).toBe(3);
      r = await call(admin, "PATCH", url, { path: "flow.stations.build.wip", value: 2 });
      expect(r.status).toBe(200);
      r = await call(admin, "PATCH", url, { path: "budget.monthly", value: 4000 });
      expect(r.status).toBe(200);
      r = await call(admin, "PATCH", url, { path: "budget.alertAt", value: 0.9 });
      expect(r.status).toBe(200);
      p = await proj("checkout-next");
      expect(p.flow.stations.build.wip).toBe(2);
      expect(p.budget).toMatchObject({ monthly: 4000, alertAt: 0.9 });
      const e = (await events("project.config")).filter((x) => x.project_id === "checkout-next");
      expect(e.length).toBeGreaterThanOrEqual(5);
      expect(e.find((x) => x.subject?.path === "flow.slots")?.after).toBe(3);
    });
    it("replaces notification routes (notify.edit) and the MCP list", async () => {
      const p = await proj("checkout-next");
      const routes = p.notifications.map((n: any) => (n.event === "released" ? { ...n, enabled: false } : n));
      const r = await call(owner, "PATCH", "/api/v1/projects/checkout-next/config", { path: "notifications", value: routes });
      expect(r.status).toBe(200);
      expect((await proj("checkout-next")).notifications.find((n: any) => n.event === "released").enabled).toBe(false);
      expect((await events("notify.edit")).at(-1)?.category).toBe("integrations");
      const bad = await call(admin, "PATCH", "/api/v1/projects/checkout-next/config", { path: "mcp", value: ["no-such-server"] });
      expect(bad.status).toBe(422);
    });
    it("changes a gate mode and keeps the always-human gates human", async () => {
      const url = "/api/v1/projects/checkout-next/config";
      const r = await call(admin, "PATCH", url, { gate: "G3d", mode: "mixed" });
      expect(r.status).toBe(200);
      expect(r.body.msg).toBe("Design review (G3d) is now checks, then a person on Checkout Next.");
      expect((await proj("checkout-next")).flow.gates.G3d.mode).toBe("mixed");
      expect((await call(admin, "PATCH", url, { gate: "G0G1", mode: "auto" })).status).toBe(422);
      expect((await call(admin, "PATCH", url, { gate: "G6", mode: "auto" })).status).toBe(422);
      expect((await call(admin, "PATCH", url, { gate: "G3d", mode: "bogus" })).status).toBe(422);
      expect((await events("flow.gate")).at(-1)).toMatchObject({ before: expect.anything(), after: "mixed" });
    });
    it("refuses turning a station off while work is at it (spec 14.4)", async () => {
      await insertWo("checkout-next", "WO-T1", "review");
      const r = await call(admin, "PATCH", "/api/v1/projects/checkout-next/config", { path: "flow.stations.review.enabled", value: false });
      expect(r.status).toBe(409);
      expect(r.body.msg).toMatch(/1 work order is at/);
      await t.db.admin.query(`update work_orders set state = 'done' where id = 'WO-T1'`);
      expect((await call(admin, "PATCH", "/api/v1/projects/checkout-next/config", { path: "flow.stations.review.enabled", value: false })).status).toBe(200);
      expect((await call(admin, "PATCH", "/api/v1/projects/checkout-next/config", { path: "flow.stations.intake.enabled", value: false })).status).toBe(409);
    });
    it("saves class routes (flow.classes): a built-in route that already ends early is kept, a new bad skip is refused", async () => {
      const p = await proj("checkout-next");
      const url = "/api/v1/projects/checkout-next/config";
      const classes = p.flow.classes.map((c: any) => (c.id === "bug" ? { ...c, skips: [...c.skips, "plan"] } : c));
      expect(classes.find((c: any) => c.id === "spike").skips).toContain("close");
      const ok = await call(admin, "PATCH", url, { path: "flow.classes", value: classes });
      expect(ok.status).toBe(200);
      expect((await proj("checkout-next")).flow.classes.find((c: any) => c.id === "bug").skips).toContain("plan");
      const bad = classes.map((c: any) => (c.id === "bug" ? { ...c, skips: ["close"] } : c));
      expect((await call(admin, "PATCH", url, { path: "flow.classes", value: bad })).status).toBe(422);
      await insertWo("checkout-next", "WO-T4", "build", "docs");
      const off = classes.map((c: any) => (c.id === "docs" ? { ...c, enabled: false } : c));
      const r = await call(admin, "PATCH", url, { path: "flow.classes", value: off });
      expect(r.status).toBe(409);
      expect(r.body.msg).toMatch(/Open work orders use/);
      await t.db.admin.query(`update work_orders set state = 'done' where id = 'WO-T4'`);
    });
    it("rejects unknown paths and bad values", async () => {
      const url = "/api/v1/projects/checkout-next/config";
      expect((await call(admin, "PATCH", url, { path: "nonsense.path", value: 1 })).status).toBe(422);
      expect((await call(admin, "PATCH", url, { path: "flow.slots", value: 99 })).status).toBe(422);
      expect((await call(admin, "PATCH", url, { path: "owner", value: "p-nobody" })).status).toBe(422);
      expect((await call(admin, "PATCH", url, { path: "approvers.G5", value: {} })).status).toBe(422);
    });
    it("is denied without project.config and without notify.edit, and refuses a stale version", async () => {
      const url = "/api/v1/projects/checkout-next/config";
      await denied(engineer, "PATCH", "/api/v1/projects/payments/config", "project.config", { path: "desc", value: "x" });
      await denied(viewer, "PATCH", "/api/v1/projects/payments/config", "notify.edit", { path: "notifications", value: [] });
      await denied(engineer, "PATCH", "/api/v1/projects/payments/config", "project.config", { gate: "G3d", mode: "human" });
      await stale(admin, "PATCH", url, { path: "desc", value: "stale" });
      await stale(admin, "PATCH", url, { gate: "G3d", mode: "human" });
      expect((await proj("checkout-next")).desc).toBe("Checkout, v2");
    });
    it("refuses in a killed project, with the reason, and audits the refusal", async () => {
      await t.db.admin.query(`insert into stops (org_id, id, scope_type, project_id, mode, reason, set_by) values ($1,'project:kit-project:1','project','kit-project','kill','test kill','p-asha')`, [t.orgId]);
      const before = (await events("project.config.denied")).length;
      const r = await call(admin, "PATCH", "/api/v1/projects/kit-project/config", { path: "desc", value: "nope" });
      expect(r.status).toBe(409);
      expect(r.body.msg).toMatch(/killed/i);
      expect(r.body.msg).toMatch(/test kill/);
      expect((await events("project.config.denied")).length).toBe(before + 1);
      expect((await proj("kit-project")).desc).not.toBe("nope");
      await t.db.admin.query(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = 'project:kit-project:1'`);
    });
  });

  describe("flow", () => {
    const url = "/api/v1/projects/checkout-next/flow";
    it("adds a custom station with its gate in one step, then moves and removes it", async () => {
      const agent = (await t.db.admin.query(`select id from agents limit 1`)).rows[0].id as string;
      const r = await call(admin, "POST", `${url}/stations`, { def: { name: "Perf Test", agent, purpose: "Load tests", wip: 2, gate: { name: "Perf Gate", kind: "human", roles: ["line_lead"], required: 1 } }, after: "review" });
      expect(r.status).toBe(200);
      expect(r.body.msg).toBe("Perf Test added to Checkout Next.");
      expect(r.body.station).toMatchObject({ id: "perf-test", custom: true });
      expect(r.body.gate).toMatchObject({ custom: true, after: "perf-test" });
      let p = await proj("checkout-next");
      expect(p.flow.order.indexOf("perf-test")).toBe(p.flow.order.indexOf("review") + 1);
      expect(Object.keys(p.approvers)).toContain(r.body.gate.id);
      expect((await events("station.add")).at(-1)).toMatchObject({ project_id: "checkout-next" });
      expect((await events("gate.add")).length).toBeGreaterThan(0);
      const idx = p.flow.order.indexOf("perf-test");
      const m = await call(admin, "PATCH", `${url}/stations/perf-test`, { move: -1 });
      expect(m.status).toBe(200);
      p = await proj("checkout-next");
      expect(p.flow.order.indexOf("perf-test")).toBe(idx - 1);
      expect((await events("station.move")).at(-1)?.after).toContain("perf-test");
      // work at the station blocks removal
      await insertWo("checkout-next", "WO-T2", "perf-test");
      const blocked = await call(admin, "DELETE", `${url}/stations/perf-test`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.msg).toMatch(/1 work order is at Perf Test/);
      await t.db.admin.query(`update work_orders set state = 'done' where id = 'WO-T2'`);
      const rm = await call(admin, "DELETE", `${url}/stations/perf-test`);
      expect(rm.status).toBe(200);
      p = await proj("checkout-next");
      expect(p.flow.order).not.toContain("perf-test");
    });
    it("refuses what the flow rules forbid", async () => {
      const agent = (await t.db.admin.query(`select id from agents limit 1`)).rows[0].id as string;
      expect((await call(admin, "POST", `${url}/stations`, { def: { name: "After Close", agent }, after: "close" })).status).toBe(422);
      expect((await call(admin, "POST", `${url}/stations`, { def: { name: "No Agent", agent: "nope" }, after: "review" })).status).toBe(422);
      expect((await call(admin, "DELETE", `${url}/stations/build`)).status).toBe(409); // built in
      expect((await call(admin, "PATCH", `${url}/stations/intake`, { move: 1 })).status).toBe(409);
      expect((await call(admin, "POST", `${url}/gates`, { def: { name: "Dup", after: "design", kind: "human", roles: ["line_lead"] } })).status).toBe(409);
      expect((await call(admin, "POST", `${url}/gates`, { def: { name: "No Roles", after: "release", kind: "human" } })).status).toBe(422);
    });
    it("adds a gate, a bay and a class", async () => {
      const bay = await call(admin, "POST", `${url}/bays`, { def: { name: "Vendor Wait", desc: "Waiting on a vendor" } });
      expect(bay.status).toBe(200);
      expect(bay.body.msg).toBe("Vendor Wait bay added to Checkout Next.");
      expect((await call(admin, "POST", `${url}/bays`, { def: { name: "Vendor Wait" } })).status).toBe(409);
      const cls = await call(pAdmin, "POST", `${url}/classes`.replace("checkout-next", "payments"), { def: { name: "Chargeback Fix", skips: ["design"], priority: "P1", slaH: 12, est: "S" } });
      expect(cls.status).toBe(200);
      expect(cls.body.cls).toMatchObject({ id: "chargeback-fix", custom: true, priority: "P1" });
      expect((await call(pAdmin, "POST", `/api/v1/projects/payments/flow/classes`, { def: { name: "Chargeback Fix" } })).status).toBe(409);
      expect((await call(admin, "POST", `${url}/classes`, { def: { name: "Bad Skip", skips: ["close"] } })).status).toBe(422);
      const g = await call(admin, "POST", `${url}/gates`, { def: { name: "Legal Review", label: "GLR", after: "build", kind: "human", roles: ["line_lead"], required: 1 } });
      expect(g.status).toBe(200);
      expect(g.body.msg).toBe("GLR Legal Review added to Checkout Next.");
      const p = await proj("checkout-next");
      expect(p.flow.gates.GLR).toMatchObject({ enabled: true, mode: "human" });
      expect(p.approvers.GLR.roles).toEqual(["line_lead"]);
    });
    it("edits a class and refuses turning it off while work is in it (spec 14.4)", async () => {
      const u = "/api/v1/projects/checkout-next/flow/classes/bug";
      const r = await call(admin, "PATCH", u, { priority: "P1", slaH: 10 });
      expect(r.status).toBe(200);
      expect(r.body.msg).toMatch(/saved/);
      expect((await proj("checkout-next")).flow.classes.find((c: any) => c.id === "bug")).toMatchObject({ priority: "P1", slaH: 10 });
      await insertWo("checkout-next", "WO-T3", "build", "bug");
      const off = await call(admin, "PATCH", u, { enabled: false });
      expect(off.status).toBe(409);
      expect(off.body.msg).toMatch(/Open work orders use/);
      await t.db.admin.query(`update work_orders set state = 'done' where id = 'WO-T3'`);
      expect((await call(admin, "PATCH", u, { enabled: false })).status).toBe(200);
      expect((await call(admin, "PATCH", u, { skips: ["intake"] })).status).toBe(422);
      expect((await call(admin, "PATCH", "/api/v1/projects/checkout-next/flow/classes/nope", { slaH: 3 })).status).toBe(422);
      expect((await events("class.edit")).length).toBeGreaterThan(1);
    });
    it("is denied without flow.edit or class.edit, and refuses a stale version", async () => {
      const pu = "/api/v1/projects/payments/flow";
      const agent = (await t.db.admin.query(`select id from agents limit 1`)).rows[0].id as string;
      await denied(engineer, "POST", `${pu}/stations`, "flow.edit", { def: { name: "Nope", agent }, after: "review" });
      await denied(engineer, "POST", `${pu}/gates`, "flow.edit", { def: { name: "Nope", after: "review", roles: ["line_lead"] } });
      await denied(engineer, "POST", `${pu}/bays`, "flow.edit", { def: { name: "Nope" } });
      await denied(engineer, "PATCH", `${pu}/stations/intake`, "flow.edit", { move: 1 });
      await denied(engineer, "DELETE", `${pu}/stations/x`, "flow.edit");
      await denied(engineer, "POST", `${pu}/classes`, "class.edit", { def: { name: "Nope" } });
      await denied(engineer, "PATCH", `${pu}/classes/bug`, "class.edit", { slaH: 5 });
      const u = "/api/v1/projects/checkout-next/flow";
      await stale(admin, "POST", `${u}/stations`, { def: { name: "Stale", agent }, after: "review" });
      await stale(admin, "POST", `${u}/gates`, { def: { name: "Stale", after: "review", roles: ["line_lead"] } });
      await stale(admin, "POST", `${u}/bays`, { def: { name: "Stale" } });
      await stale(admin, "POST", `${u}/classes`, { def: { name: "Stale" } });
      await stale(admin, "PATCH", `${u}/classes/bug`, { slaH: 3 });
      await stale(admin, "PATCH", `${u}/stations/design`, { move: 1 });
      await stale(admin, "DELETE", `${u}/stations/perf-test`);
    });
    it("is idempotent when adding", async () => {
      const k = { "idempotency-key": "bay-idem" };
      const a = await call(admin, "POST", `${url}/bays`, { def: { name: "Idem Bay" } }, k);
      const b = await call(admin, "POST", `${url}/bays`, { def: { name: "Idem Bay" } }, k);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.headers["idempotent-replayed"]).toBe("true");
      expect((await proj("checkout-next")).flow.bays.filter((x: string) => x === "idem-bay").length).toBe(1);
    });
  });

  describe("turning gates on and off", () => {
    const toggle = (who: string, id: string, gate: string, on: boolean, extra: Record<string, string> = {}) =>
      call(who, "PATCH", `/api/v1/projects/${id}/config`, { path: `flow.gates.${gate}.enabled`, value: on }, extra);
    let id = "";
    beforeAll(async () => {
      const r = await create("Gate switches");
      expect(r.status).toBe(200);
      id = (r.body.project as { id: string }).id;
    });

    it("refuses the gates that must stay on, with the reason, and changes nothing", async () => {
      const before = (await proj(id)).flow.gates;
      for (const [g, why] of [["G0G1", /confirming the brief/], ["G3G3s", /security checks/], ["G4", /required checks/], ["G5", /No agent merges on its own authority/]] as const) {
        const r = await toggle(admin, id, g, false);
        expect(r.status, g).toBe(409);
        expect(r.body.ok).toBe(false);
        expect(String(r.body.msg)).toMatch(/cannot be turned off/);
        expect(String(r.body.msg)).toMatch(why);
      }
      expect((await proj(id)).flow.gates).toEqual(before);
    });

    it("is denied without project.config, needs If-Match, and a fresh sign-in to turn a gate off", async () => {
      await denied(engineer, "PATCH", `/api/v1/projects/${id}/config`, "project.config", { path: "flow.gates.G3d.enabled", value: false });
      await stale(admin, "PATCH", `/api/v1/projects/${id}/config`, { path: "flow.gates.G3d.enabled", value: false });
      const old = await t.session(admin, { authAgeSec: 3600 });
      const v = (await proj(id)).version;
      const r = await t.app.inject({ method: "PATCH", url: `/api/v1/projects/${id}/config`, headers: { ...old.headers, "if-match": String(v) }, payload: { path: "flow.gates.G3d.enabled", value: false } });
      expect(r.statusCode).toBe(403);
      expect(r.json().needs).toBe("step_up");
      expect((await proj(id)).flow.gates.G3d.enabled).toBe(true);
      // turning a gate back ON does not need the fresh sign-in
      const on = await t.app.inject({ method: "PATCH", url: `/api/v1/projects/${id}/config`, headers: { ...old.headers, "if-match": String(v) }, payload: { path: "flow.gates.G3d.enabled", value: true } });
      expect(on.statusCode).toBe(200);
    });

    it("turns a gate off for new work only, audits before and after, and the route of a new work order skips it", async () => {
      await insertWo(id, "WO-GATE-1", "design", "feature", "running");
      const p0 = await proj(id);
      const cat = (await call(admin, "GET", "/api/v1/catalog")).body as any;
      expect(routeGates(cat, p0 as any, "feature")).toContain("G3d");
      const r = await toggle(admin, id, "G3d", false);
      expect(r.status).toBe(200);
      expect(r.body.msg).toMatch(/Design review \(G3d\) turned off\. New work orders skip it; 1 open work order keeps the flow it started with\./);
      expect(r.body.flowVersion).toBeGreaterThan(1);
      const p1 = await proj(id);
      expect(p1.flow.gates.G3d.enabled).toBe(false);
      expect(routeGates(cat, p1 as any, "feature")).not.toContain("G3d");
      expect(routeGates(cat, p1 as any, "feature")).toEqual(expect.arrayContaining(["G0G1", "G5"]));
      // the work order already in flight stays on the flow version it was submitted under
      const wo = (await t.db.admin.query(`select flow_version, (select current_flow_version from projects where id = $1) as cur from work_orders where id = 'WO-GATE-1'`, [id])).rows[0];
      expect(wo.flow_version).toBeLessThan(wo.cur);
      const e = (await events("project.config")).filter((x) => x.project_id === id && x.subject?.path === "flow.gates.G3d.enabled").at(-1);
      expect(e).toBeTruthy();
      expect(e.before).toBe(true);
      expect(e.after).toBe(false);
      // and back on
      expect((await toggle(admin, id, "G3d", true)).status).toBe(200);
      expect(routeGates(cat, (await proj(id)) as any, "feature")).toContain("G3d");
    });

    it("a regulated project keeps every gate on", async () => {
      await t.db.admin.query(`update projects set regulated = true where id = $1`, [id]);
      const r = await toggle(admin, id, "G2", false);
      expect(r.status).toBe(409);
      expect(String(r.body.msg)).toMatch(/Regulated projects keep every gate on/);
      await t.db.admin.query(`update projects set regulated = false where id = $1`, [id]);
    });

    it("templates and the wizard follow the same rules", async () => {
      const tpl = await call(admin, "POST", "/api/v1/templates", { fromTemplate: "tpl-backend", name: "Gate rules" });
      expect(tpl.status).toBe(200);
      const tid = ((tpl.body as any).template?.id ?? (tpl.body as any).id) as string;
      for (const g of ["G4", "G5", "G3G3s", "G0G1"]) {
        const r = await call(admin, "PATCH", `/api/v1/templates/${tid}`, { gatesOff: [g] });
        expect(r.status, g).toBe(422);
        expect(String(r.body.msg)).toMatch(/is always on/);
      }
      expect((await call(admin, "PATCH", `/api/v1/templates/${tid}`, { gatesOff: ["G3d"] })).status).toBe(200);
      // a regulated (strict) template cannot start a project with a gate off
      await call(admin, "PATCH", `/api/v1/templates/${tid}`, { approverPreset: "strict" });
      const bad = await call(admin, "POST", "/api/v1/projects", { name: "Strict with gate off", templateId: tid, teams: ["payments"] });
      expect(bad.status).toBe(422);
      expect(String(bad.body.msg)).toMatch(/regulated project keeps every gate on/);
    });
  });

  describe("approvers", () => {
    const url = "/api/v1/projects/payments/approvers/G5";
    it("publishes a new approver rule version", async () => {
      const p = await proj("payments");
      const rule = { ...p.approvers.G5, escalateH: 6 };
      const r = await call(pAdmin, "PUT", url, { value: rule });
      expect(r.status).toBe(200);
      expect(r.body.msg).toBe("Saved approvers.G5.");
      expect(r.body.ruleVersion).toBe(2);
      expect((await proj("payments")).approvers.G5.escalateH).toBe(6);
      expect((await events("approvers.edit")).at(-1)).toMatchObject({ project_id: "payments", category: "config" });
      const vs = (await t.db.admin.query(`select count(*)::int as n from approver_rule_versions where project_id = 'payments' and gate_id = 'G5'`)).rows[0].n;
      expect(vs).toBe(2);
    });
    it("refuses rules that cannot work", async () => {
      const p = await proj("payments");
      const base = p.approvers.G5;
      expect((await call(admin, "PUT", url, { value: { ...base, roles: ["nope_role"] } })).status).toBe(422);
      expect((await call(admin, "PUT", url, { value: { ...base, roles: [], people: [] } })).status).toBe(422);
      const many = await call(admin, "PUT", url, { value: { ...base, required: 9 } });
      expect(many.status).toBe(422);
      expect(many.body.msg).toMatch(/eligible/);
      expect((await call(admin, "PUT", url, { value: { ...base, conditions: [{ id: "c", when: { type: "class", value: "unknown" }, needs: { roles: ["approver"], people: [], oncall: false }, text: "x" }] } })).status).toBe(422);
      expect((await call(admin, "PUT", "/api/v1/projects/payments/approvers/NOPE", { value: base })).status).toBe(422);
      expect((await call(admin, "PUT", "/api/v1/projects/payments/approvers/G0G1", { value: { ...p.approvers.G0G1, required: 2 } })).status).toBe(422);
    });
    it("is denied without approvers.edit and refuses a stale version", async () => {
      const p = await proj("payments");
      await denied(engineer, "PUT", url, "approvers.edit", { value: p.approvers.G5 });
      await stale(admin, "PUT", url, { value: p.approvers.G5 });
    });
  });

  describe("members", () => {
    const url = (person: string, role: string) => `/api/v1/projects/payments/members/${person}/roles/${role}`;
    const roles = async (person: string, scope: string) => ((await call(admin, "GET", "/api/v1/people")).body as unknown as any[]).find((x) => x.id === person).roles.filter((r: any) => r.scope === scope).map((r: any) => r.role);
    it("grants and revokes a project role, with audit", async () => {
      const g = await call(pAdmin, "PUT", url("p-hana", "reviewer"));
      expect(g.status).toBe(200);
      expect(g.body.msg).toMatch(/^Granted Reviewer to .+ on Payments Platform\.$/);
      expect(await roles("p-hana", "payments")).toEqual(["reviewer"]);
      expect((await t.db.admin.query(`select 1 from project_members where project_id = 'payments' and person_id = 'p-hana'`)).rowCount).toBe(1);
      expect((await events("role.grant")).at(-1)).toMatchObject({ project_id: "payments", after: "reviewer" });
      const again = await call(pAdmin, "PUT", url("p-hana", "reviewer"));
      expect(again.body.msg).toMatch(/already has/);
      const r = await call(pAdmin, "DELETE", url("p-hana", "reviewer"));
      expect(r.status).toBe(200);
      expect(r.body.msg).toMatch(/^Removed Reviewer from /);
      expect(await roles("p-hana", "payments")).toEqual([]);
      expect((await t.db.admin.query(`select 1 from project_members where project_id = 'payments' and person_id = 'p-hana'`)).rowCount).toBe(0);
      expect((await events("role.revoke")).at(-1)).toMatchObject({ project_id: "payments" });
    });
    it("refuses a factory-level or unknown role, a missing person", async () => {
      expect((await call(admin, "PUT", url("p-hana", "factory_admin"))).status).toBe(422);
      expect((await call(admin, "PUT", url("p-hana", "no_such_role"))).status).toBe(422);
      expect((await call(admin, "PUT", url("p-nobody", "reviewer"))).status).toBe(404);
    });
    it("is denied without project.members and refuses a stale version", async () => {
      await denied(engineer, "PUT", url("p-hana", "reviewer"), "project.members");
      await denied(engineer, "DELETE", url("p-meera", "line_lead"), "project.members");
      await stale(admin, "PUT", url("p-hana", "reviewer"));
      await stale(admin, "DELETE", url("p-meera", "line_lead"));
      expect(await roles("p-meera", "payments")).toEqual(["line_lead"]);
    });
    it("needs a fresh sign-in, like any role operation (spec 14.1)", async () => {
      const s = await t.session(pAdmin, { authAgeSec: 3600 });
      const r = await t.app.inject({ method: "PUT", url: url("p-hana", "reviewer"), headers: s.headers });
      expect(r.statusCode).toBe(403);
      expect(r.json().needs).toBe("step_up");
      expect(await roles("p-hana", "payments")).toEqual([]);
    });
  });

  describe("archive", () => {
    it("archives with the typed name and unarchives into the right status", async () => {
      const u = "/api/v1/projects/kit-project";
      expect((await call(admin, "POST", `${u}/archive`, { confirmText: "wrong" })).status).toBe(422);
      const r = await call(admin, "POST", `${u}/archive`, { confirmText: "Kit Project" });
      expect(r.status).toBe(200);
      expect(r.body.msg).toBe("Kit Project archived.");
      expect((await proj("kit-project")).status).toBe("archived");
      expect((await call(admin, "POST", `${u}/archive`, { confirmText: "Kit Project" })).status).toBe(409);
      // archived projects are read-only
      const w = await call(admin, "PATCH", `${u}/config`, { path: "desc", value: "x" });
      expect([403, 409]).toContain(w.status);
      const un = await call(admin, "POST", `${u}/unarchive`);
      expect(un.status).toBe(200);
      expect(un.body.msg).toBe("Kit Project is back (new).");
      expect((await proj("kit-project")).status).toBe("new");
      expect((await call(admin, "POST", `${u}/unarchive`)).status).toBe(409);
      expect((await events("project.archive")).at(-1)).toMatchObject({ before: "new", after: "archived" });
      expect((await events("project.unarchive")).at(-1)).toMatchObject({ before: "archived", after: "new" });
    });
    it("returns a project with ready repos to active", async () => {
      await t.db.admin.query(`update repos set onboarding_stage = 'ready' where project_id = 'internal-tools'`);
      expect((await call(admin, "POST", "/api/v1/projects/internal-tools/archive", { confirmText: "Internal Tools" })).status).toBe(200);
      expect((await call(admin, "POST", "/api/v1/projects/internal-tools/unarchive")).body.msg).toMatch(/\((active|onboarding)\)/);
    });
    it("is denied without project.archive and refuses a stale version", async () => {
      await denied(engineer, "POST", "/api/v1/projects/payments/archive", "project.archive", { confirmText: "Payments" });
      await denied(engineer, "POST", "/api/v1/projects/legacy-checkout/unarchive", "project.archive");
      await stale(admin, "POST", "/api/v1/projects/payments/archive", { confirmText: "Payments" });
      await stale(admin, "POST", "/api/v1/projects/legacy-checkout/unarchive");
      expect((await proj("payments")).status).toBe("active");
    });
  });

  describe("templates", () => {
    it("duplicates a template and edits the copy; built-ins are read-only", async () => {
      const dup = await call(admin, "POST", "/api/v1/templates", { fromTemplate: "tpl-web" });
      expect(dup.status).toBe(200);
      expect(dup.body.msg).toBe(`Template ${dup.body.template.name} saved.`);
      expect(dup.body.template.name).toMatch(/ \(copy\)$/);
      const id = dup.body.template.id as string;
      expect(dup.body.template).toMatchObject({ builtIn: false, version: 1, slots: expect.any(Number) });
      const r = await call(admin, "PATCH", `/api/v1/templates/${id}`, { name: "My web", slots: 2, stationsOff: ["design"], classesSkip: { bug: ["design"] } }, ifm(1));
      expect(r.status).toBe(200);
      expect(r.body.version).toBe(2);
      const t2 = ((await call(admin, "GET", "/api/v1/templates")).body as unknown as any[]).find((x) => x.id === id);
      expect(t2).toMatchObject({ name: "My web", slots: 2, stationsOff: ["design"], version: 2 });
      expect((await events("template.edit")).at(-1)).toMatchObject({ outcome: "ok" });
      const ro = await call(admin, "PATCH", "/api/v1/templates/tpl-web", { slots: 2 });
      expect(ro.status).toBe(409);
      expect(ro.body.msg).toMatch(/read-only/);
      expect((await call(admin, "PATCH", `/api/v1/templates/${id}`, { stationsOff: ["intake"] })).status).toBe(422);
      expect((await call(admin, "PATCH", `/api/v1/templates/${id}`, { gatesOff: ["G0G1"] })).status).toBe(422);
      expect((await call(admin, "PATCH", `/api/v1/templates/${id}`, { name: "x" })).status).toBe(422);
      expect((await call(admin, "PATCH", "/api/v1/templates/none", { slots: 2 })).status).toBe(404);
    });
    it("is denied without template.edit and refuses a stale version", async () => {
      await denied(pAdmin, "POST", "/api/v1/templates", "template.edit", { fromTemplate: "tpl-web" });
      const custom = ((await call(admin, "GET", "/api/v1/templates")).body as unknown as any[]).find((x) => !x.builtIn)!;
      await denied(pAdmin, "PATCH", `/api/v1/templates/${custom.id}`, "template.edit", { slots: 3 });
      await stale(admin, "PATCH", `/api/v1/templates/${custom.id}`, { slots: 3 });
    });
    it("saves a template from a project; it needs access to that project", async () => {
      const r = await call(admin, "POST", "/api/v1/templates", { fromProject: "payments", name: "Payments flow" });
      expect(r.status).toBe(200);
      expect(r.body.template).toMatchObject({ name: "Payments flow", desc: "Saved from Payments Platform", builtIn: false });
      expect((await call(admin, "POST", "/api/v1/templates", { fromProject: "nope" })).status).toBe(404);
      const k = { "idempotency-key": "tpl-idem" };
      const a = await call(admin, "POST", "/api/v1/templates", { fromTemplate: "tpl-lib" }, k);
      const b = await call(admin, "POST", "/api/v1/templates", { fromTemplate: "tpl-lib" }, k);
      expect(b.body.template.id).toBe(a.body.template.id);
    });
  });

  describe("saved views", () => {
    const s = { group: "team", sort: "name", dir: 1, health: "all", archived: false };
    it("creates, lists (own only), renames, updates and deletes a view", async () => {
      const c = await call(engineer, "POST", "/api/v1/saved-views", { name: "By team", s });
      expect(c.status).toBe(200);
      expect(c.body.view).toMatchObject({ name: "By team", screen: "portfolio", s, version: 1 });
      const id = c.body.view.id as string;
      expect(((await call(engineer, "GET", "/api/v1/saved-views")).body as unknown as any[]).map((v) => v.id)).toEqual([id]);
      expect(((await call(admin, "GET", "/api/v1/saved-views")).body as unknown as any[]).length).toBe(0);
      expect((await call(engineer, "POST", "/api/v1/saved-views", { name: "by TEAM", s })).status).toBe(409);
      const u = await call(engineer, "PATCH", `/api/v1/saved-views/${id}`, { s: { ...s, sort: "spend" } }, ifm(1));
      expect(u.status).toBe(200);
      expect(u.body.view).toMatchObject({ version: 2, s: { sort: "spend" } });
      const rn = await call(engineer, "PATCH", `/api/v1/saved-views/${id}`, { name: "Team view" });
      expect(rn.body.msg).toBe("View renamed to Team view.");
      expect((await call(admin, "PATCH", `/api/v1/saved-views/${id}`, { name: "Hijack" })).status).toBe(404);
      expect((await call(admin, "DELETE", `/api/v1/saved-views/${id}`)).status).toBe(404);
      await stale(engineer, "PATCH", `/api/v1/saved-views/${id}`, { name: "Stale" });
      await stale(engineer, "DELETE", `/api/v1/saved-views/${id}`);
      const del = await call(engineer, "DELETE", `/api/v1/saved-views/${id}`, undefined, ifm(3));
      expect(del.status).toBe(200);
      expect(del.body.msg).toBe("View Team view deleted.");
      expect(((await call(engineer, "GET", "/api/v1/saved-views")).body as unknown as any[]).length).toBe(0);
    });
    it("refuses a view for a project the caller cannot see, bad names and oversized state; is idempotent", async () => {
      expect((await call(engineer, "POST", "/api/v1/saved-views", { name: "Risk", project: "risk", s })).status).toBe(404);
      expect((await call(engineer, "POST", "/api/v1/saved-views", { name: "x", s })).status).toBe(422);
      expect((await call(engineer, "POST", "/api/v1/saved-views", { name: "Deep", s: { a: { b: 1 } } })).status).toBe(422);
      const k = { "idempotency-key": "view-idem" };
      const a = await call(engineer, "POST", "/api/v1/saved-views", { name: "Idem view", s }, k);
      const b = await call(engineer, "POST", "/api/v1/saved-views", { name: "Idem view", s }, k);
      expect(b.body.view.id).toBe(a.body.view.id);
      expect(b.headers["idempotent-replayed"]).toBe("true");
    });
  });

  it("keeps the audit chain intact after all of the above", async () => {
    const v = await verifyChain(t.db.admin, t.orgId);
    expect(v.ok).toBe(true);
  });
});
