import { verifyChain } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";
const auditor = "p-sam";
const lead = "p-meera"; // line lead on payments
const engineer = "p-tomas"; // engineer on payments only
const hour = 3_600_000;

d("audit, activity and home", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seedAudit: true });
    // One work order waiting at G2 in payments (line lead or project admin approve; Meera is a line lead), one blocked in storefront, plus an old late gate.
    const q = (sql: string, p: unknown[] = []) => t.db.admin.query(sql, p);
    const ins = (id: string, project: string, state: string, position: string, submitter: string, ageH: number, extra: Record<string, unknown> = {}) =>
      q(
        `insert into work_orders (org_id, id, project_id, title, class, position, state, flow_version, submitter, created_at, data) values ($1,$2,$3,$4,'feature',$5,$6,1,$7, now() - ($8 || ' hours')::interval, $9::jsonb)`,
        [t.orgId, id, project, `Title of ${id}`, position, state, submitter, String(ageH), JSON.stringify(extra)],
      );
    await ins("WO-9001", "payments", "waiting", "spec", "p-tomas", 30);
    await q(`insert into gate_instances (org_id, id, wo_id, gate_id, station, flow_version, opened_at) values ($1,'WO-9001:G2','WO-9001','G2','spec',1, now() - interval '30 hours')`, [t.orgId]);
    await ins("WO-9002", "storefront", "blocked", "build", "p-arjun", 2, { blockReason: "Waiting on API key" });
  });
  afterAll(() => t.close());

  const call = async (who: string, url: string) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method: "GET", url, headers: s.headers });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };

  describe("seeded ledger", () => {
    it("loads the dev seed's history into the hash chain, and the chain verifies", async () => {
      const r = await verifyChain(t.db.app, t.orgId);
      expect(r.ok).toBe(true);
      const n = Number((await t.db.admin.query(`select count(*) as n from events where type = 'role.add'`)).rows[0].n);
      expect(n).toBeGreaterThan(0);
    });
  });

  describe("GET /audit", () => {
    it("gives the whole ledger to an Auditor, newest first, in the legacy entry shape", async () => {
      const r = await call(auditor, "/api/v1/audit?limit=5");
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(5);
      const seqs = r.body.items.map((e: any) => e.seq);
      expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
      expect(r.body.items[0]).toMatchObject({ id: seqs[0], at: expect.any(Number), actor: expect.any(String), action: expect.any(String), target: expect.any(String), category: expect.any(String), outcome: expect.any(String), via: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(r.body.next).toBe(String(seqs[4]));
      expect(r.body.summary.entries).toBeGreaterThan(40);
      expect(r.body.summary.head).toMatch(/^[0-9a-f]{64}$/);
      expect(r.body.summary.categories.config).toBeGreaterThan(0);
    });
    it("pages with a cursor without repeating or skipping entries", async () => {
      const a = await call(auditor, "/api/v1/audit?limit=20");
      const b = await call(auditor, `/api/v1/audit?limit=20&cursor=${a.body.next}`);
      const all = [...a.body.items, ...b.body.items].map((e: any) => e.seq);
      expect(new Set(all).size).toBe(40);
      expect(Math.max(...b.body.items.map((e: any) => e.seq))).toBeLessThan(Math.min(...a.body.items.map((e: any) => e.seq)));
    });
    it("filters by category, project, actor kind, outcome, channel and text", async () => {
      const cat = await call(auditor, "/api/v1/audit?category=kill&limit=200");
      expect(cat.body.items.length).toBeGreaterThan(0);
      expect(cat.body.items.every((e: any) => e.category === "kill")).toBe(true);
      const pr = await call(auditor, "/api/v1/audit?project=payments&limit=200");
      expect(pr.body.items.every((e: any) => e.project === "payments")).toBe(true);
      const fac = await call(auditor, "/api/v1/audit?project=factory&limit=200");
      expect(fac.body.items.every((e: any) => e.project === null)).toBe(true);
      const ag = await call(auditor, "/api/v1/audit?actor=agent&limit=200");
      expect(ag.body.items.every((e: any) => e.actorKind === "agent")).toBe(true);
      const one = await call(auditor, "/api/v1/audit?actor=p-asha&limit=200");
      expect(one.body.items.length).toBeGreaterThan(0);
      expect(one.body.items.every((e: any) => e.actor === "p-asha")).toBe(true);
      const ch = await call(auditor, "/api/v1/audit?channel=slack&limit=200");
      expect(ch.body.items.length).toBeGreaterThan(0);
      expect(ch.body.items.every((e: any) => e.via === "slack")).toBe(true);
      const tx = await call(auditor, "/api/v1/audit?q=Compliance&limit=200");
      expect(tx.body.items.length).toBeGreaterThan(0);
      const none = await call(auditor, "/api/v1/audit?q=zzz-no-such-thing");
      expect(none.body.items).toEqual([]);
      expect(none.body.total).toBe(0);
      const topic = await call(auditor, "/api/v1/audit?topic=trust&limit=200");
      expect(topic.body.items.length).toBeGreaterThan(0);
      expect(topic.body.items.every((e: any) => /^trust\.|^gate\.trust$/.test(e.action))).toBe(true);
      const chg = await call(auditor, "/api/v1/audit?changes=true&limit=200");
      expect(chg.body.items.every((e: any) => e.before !== null || e.after !== null)).toBe(true);
    });
    it("rejects bad query values", async () => {
      expect((await call(auditor, "/api/v1/audit?limit=9999")).status).toBe(422);
      expect((await call(auditor, "/api/v1/audit?cursor=abc")).status).toBe(422);
    });
    it("shows an engineer only their projects' entries and their own actions", async () => {
      const r = await call(engineer, "/api/v1/audit?limit=200");
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeGreaterThan(0);
      expect(r.body.items.every((e: any) => e.project === "payments" || e.actor === engineer)).toBe(true);
      const full = await call(auditor, "/api/v1/audit?limit=200");
      expect(r.body.summary.entries).toBeLessThan(full.body.summary.entries);
      // A project the engineer cannot see yields nothing, even when asked for by name.
      const other = await call(engineer, "/api/v1/audit?project=risk&limit=200");
      expect(other.body.items).toEqual([]);
    });
    it("needs a signed-in person", async () => {
      const r = await t.app.inject({ method: "GET", url: "/api/v1/audit" });
      expect(r.statusCode).toBe(401);
    });
  });

  describe("GET /audit/{seq}", () => {
    it("returns the entry with its chain digests, request context and history of the same entity", async () => {
      const seed = (await t.db.admin.query(`select seq from events where type = 'trust.grant' order by seq limit 1`)).rows[0];
      const r = await call(auditor, `/api/v1/audit/${seed.seq}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ seq: Number(seed.seq), action: "trust.grant", before: "L1", after: "L2", entity: { type: "trust" }, rule: null, session: null });
      expect(r.body.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(r.body.prev).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(r.body.history)).toBe(true);
      expect(r.body.topic).toBe("trust");
    });
    it("carries source ip, session, request id and a field diff for a real command", async () => {
      const s = await t.session(admin, { ip: "203.0.113.50" });
      const put = await t.app.inject({ method: "PATCH", url: "/api/v1/security", remoteAddress: "203.0.113.50", headers: { ...s.headers, "if-match": "1", "x-request-id": "req-audit-1" }, payload: { path: "sessionHours", value: 8 } });
      expect(put.statusCode).toBe(200);
      const row = (await t.db.admin.query(`select seq from events where type = 'security.saved' order by seq desc limit 1`)).rows[0];
      const r = await call(auditor, `/api/v1/audit/${row.seq}`);
      expect(r.status).toBe(200);
      expect(r.body.request.id).toBe("req-audit-1");
      expect(r.body.sourceIp).toBe("203.0.113.50");
      expect(r.body.session.id).toBe(s.id);
      expect(r.body.session.method).toBe("sso");
      expect(r.body.rule).toEqual(expect.any(String));
      expect(r.body.actor).toBe(admin);
    });
    it("builds a diff when before and after are both objects", async () => {
      await t.db.admin.query(`select 1`);
      const s = await t.session(admin);
      // role.edit records before and after as objects.
      const res = await t.app.inject({ method: "POST", url: "/api/v1/roles", headers: { ...s.headers, "idempotency-key": "aud-role-1" }, payload: { name: "Release Observer", level: "project", base: "viewer" } });
      expect(res.statusCode).toBe(200);
      const row = (await t.db.admin.query(`select seq from events where type = 'role.add' order by seq desc limit 1`)).rows[0];
      const r = await call(auditor, `/api/v1/audit/${row.seq}`);
      expect(r.status).toBe(200);
      expect(r.body.before).toBeNull();
      expect(JSON.parse(r.body.after)).toMatchObject({ name: "Release Observer" });
      expect(r.body.diff).toBeNull();
      const { appendEvent, withTx } = await import("@gantry/db");
      const ev = await withTx(t.db.app, (tx) => appendEvent(tx, { orgId: t.orgId, type: "project.config", category: "config", actor: admin, channel: "web", subject: { type: "project", id: "payments" }, projectId: "payments", before: { mcp: true, mtd: 5 }, after: { mcp: true, mtd: 7, extra: 1 } }));
      const d = await call(auditor, `/api/v1/audit/${ev.seq}`);
      expect(d.body.diff).toEqual([
        { field: "mcp", before: true, after: true, changed: false },
        { field: "mtd", before: 5, after: 7, changed: true },
        { field: "extra", before: null, after: 1, changed: true },
      ]);
    });
    it("does not reveal entries outside the viewer's projects", async () => {
      const hidden = (await t.db.admin.query(`select seq from events where project_id = 'risk' limit 1`)).rows[0];
      expect((await call(engineer, `/api/v1/audit/${hidden.seq}`)).status).toBe(404);
      expect((await call(auditor, `/api/v1/audit/${hidden.seq}`)).status).toBe(200);
      expect((await call(auditor, "/api/v1/audit/99999999")).status).toBe(404);
      expect((await call(auditor, "/api/v1/audit/abc")).status).toBe(422);
    });
  });

  describe("GET /audit/verify", () => {
    it("lets the Auditor and a Factory Admin verify the chain", async () => {
      for (const who of [auditor, admin]) {
        const r = await call(who, "/api/v1/audit/verify");
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, checked: expect.any(Number) });
        expect(r.body.checked).toBeGreaterThan(40);
        expect(r.body.head).toMatch(/^[0-9a-f]{64}$/);
      }
    });
    it("refuses everyone else with a 403 and records the denial", async () => {
      const before = Number((await t.db.admin.query(`select count(*) as n from events where outcome = 'denied' and type = 'audit.view.denied'`)).rows[0].n);
      const r = await call(lead, "/api/v1/audit/verify");
      expect(r.status).toBe(403);
      expect(r.body.ok).toBe(false);
      expect(r.body.rule).toMatchObject({ id: "AUDIT-VERIFY" });
      const after = await t.db.admin.query(`select actor, subject, rule from events where outcome = 'denied' and type = 'audit.view.denied' order by seq desc`);
      expect(after.rows.length).toBe(before + 1);
      expect(after.rows[0]).toMatchObject({ actor: lead, rule: "AUDIT-VERIFY" });
    });
    it("reports a break in the chain, with where", async () => {
      // Tamper as the database owner (the app role cannot): disable the guard trigger just for this statement.
      await t.db.admin.query(`alter table events disable trigger events_no_update_delete`);
      const row = (await t.db.admin.query(`select seq from events order by seq limit 1 offset 10`)).rows[0];
      await t.db.admin.query(`update events set actor = 'tampered' where seq = $1`, [row.seq]);
      const r = await call(auditor, "/api/v1/audit/verify");
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      expect(r.body.broken).toMatchObject({ kind: "hash_mismatch", seq: Number(row.seq) });
      await t.db.admin.query(`update events set actor = 'p-asha' where seq = $1`, [row.seq]);
      await t.db.admin.query(`alter table events enable trigger events_no_update_delete`);
    });
  });

  describe("GET /projects/{id}/events", () => {
    it("returns flow events in the replay shape, filtered by time and kind", async () => {
      const { appendEvent, withTx } = await import("@gantry/db");
      const base = Date.now() - 5 * hour;
      await withTx(t.db.app, async (tx) => {
        await appendEvent(tx, { orgId: t.orgId, type: "wo.enter", category: "flow", actor: "ag-intake", channel: "system", subject: { type: "wo", id: "WO-9001", station: "intake" }, projectId: "payments", woId: "WO-9001", occurredAt: new Date(base) });
        await appendEvent(tx, { orgId: t.orgId, type: "gate.decision", category: "approvals", actor: lead, channel: "web", subject: { type: "gate", id: "WO-9001:G2" }, after: { gate: "G2", mode: "human", trust: null }, projectId: "payments", woId: "WO-9001", occurredAt: new Date(base + hour) });
        await appendEvent(tx, { orgId: t.orgId, type: "wo.enter", category: "flow", actor: "ag-intake", channel: "system", subject: { type: "wo", id: "WO-7", station: "build" }, projectId: "storefront", woId: "WO-7", occurredAt: new Date(base) });
      });
      const all = await call(engineer, "/api/v1/projects/payments/events");
      expect(all.status).toBe(200);
      const mine = (all.body as unknown as any[]).filter((e) => e.wo === "WO-9001");
      expect(mine.map((e) => e.type)).toEqual(["wo.enter", "gate.decision"]);
      expect(mine[0]).toMatchObject({ id: expect.any(Number), at: base, project: "payments", wo: "WO-9001", by: "ag-intake", station: "intake" });
      expect(mine[1]).toMatchObject({ gate: "G2", mode: "human", trust: null, by: lead });
      const kinds = await call(engineer, "/api/v1/projects/payments/events?kinds=gate.decision");
      expect((kinds.body as unknown as any[]).every((e) => e.type === "gate.decision")).toBe(true);
      const range = await call(engineer, `/api/v1/projects/payments/events?from=${base + 1000}&to=${base + 2 * hour}`);
      expect((range.body as unknown as any[]).filter((e) => e.wo === "WO-9001").map((e) => e.type)).toEqual(["gate.decision"]);
    });
    it("refuses a project the viewer cannot see and an unknown one", async () => {
      expect((await call(engineer, "/api/v1/projects/storefront/events")).status).toBe(404);
      expect((await call(auditor, "/api/v1/projects/storefront/events")).status).toBe(200);
      expect((await call(admin, "/api/v1/projects/nope/events")).status).toBe(404);
    });
  });

  describe("GET /activity", () => {
    it("returns the latest entries the viewer may see", async () => {
      const r = await call(auditor, "/api/v1/activity");
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(14);
      const e = await call(engineer, "/api/v1/activity?limit=50");
      expect(e.body.items.every((x: any) => x.project === "payments" || x.actor === engineer)).toBe(true);
      const p = await call(auditor, "/api/v1/activity?project=risk&limit=5");
      expect(p.body.items.every((x: any) => x.project === "risk")).toBe(true);
    });
  });

  describe("GET /home", () => {
    it("computes my approvals from open gates with the approver rules, not from a list", async () => {
      const r = await call(lead, "/api/v1/home");
      expect(r.status).toBe(200);
      expect(r.body.approvals).toEqual([expect.objectContaining({ wo: "WO-9001", title: "Title of WO-9001", gate: "G2", gateLabel: "G2", project: "payments", projectName: "Payments Platform", have: 0, need: 1 })]);
      // The submitter is an engineer with no G2 right, and the gate has separation of duties.
      const e = await call(engineer, "/api/v1/home");
      expect(e.body.approvals).toEqual([]);
      expect(e.body.sections.motion.mine.map((w: any) => w.id)).toEqual(["WO-9001"]);
      expect(e.body.sections.projects).toEqual([expect.objectContaining({ id: "payments", roles: [{ id: "engineer", name: expect.any(String) }] })]);
      expect(e.body.sections.health).toBeUndefined();
      expect(e.body.projectBadges.payments).toBeUndefined();
      expect(r.body.projectBadges.payments["work-orders"]).toMatchObject({ n: 1 });
    });
    it("gives the factory sections to Factory Admins and the Auditor, with real figures", async () => {
      const r = await call(admin, "/api/v1/home");
      const s = r.body.sections;
      expect(s.motion).toMatchObject({ inFlight: 2, running: 0, shippedToday: 0, shippedWeek: 0 });
      expect(s.projects.length).toBeGreaterThan(5);
      expect(s.attention.map((a: any) => a.id)).toEqual(expect.arrayContaining(["hm-att-wo-WO-9002", "hm-att-sla-WO-9001-G2"]));
      const sevs = s.attention.map((a: any) => a.sev);
      expect([...sevs].sort()).toEqual(sevs);
      expect(s.attention.find((a: any) => a.id === "hm-att-wo-WO-9002")).toMatchObject({ title: "WO-9002 blocked", sub: "Waiting on API key", act: { route: "traveler", wo: "WO-9002" } });
      expect(s.health.spend.projects.length).toBeGreaterThan(0);
      expect(s.waiting).toBeDefined();
      expect(s.approvers).toBeUndefined();
      // The dead fields are gone.
      for (const k of ["human", "onboarding", "control", "figures", "mode", "mine", "spend"]) expect(r.body[k]).toBeUndefined();
      // The Auditor reads the same factory, but only watches the approvers: no Waiting on you, no setup.
      const a = (await call(auditor, "/api/v1/home")).body.sections;
      expect(a.waiting).toBeUndefined();
      expect(a.setup).toBeUndefined();
      expect(a.approvers).toMatchObject({ count: 1, late: 1 });
      expect(a.health).toBeDefined();
    });
    it("reports a killed factory with its restore approvals as an attention item", async () => {
      const row = (await t.db.admin.query(`select id from stops where org_id = $1 and scope_type = 'factory' and lifted_at is null`, [t.orgId])).rows;
      expect(row).toEqual([]);
      await t.db.admin.query(`insert into stops (org_id, id, scope_type, mode, reason, in_flight, set_by, set_at) values ($1,'factory:factory:9','factory','kill','Test kill','hold','p-asha', now())`, [t.orgId]);
      await t.db.admin.query(`insert into restore_approvals (org_id, id, stop_id, approver) values ($1,'ra1','factory:factory:9','p-omar')`, [t.orgId]);
      const r = await call(admin, "/api/v1/home");
      expect(r.body.sections.attention[0]).toMatchObject({ id: "hm-att-factory", sev: 0, title: "Factory killed", restore: { scope: "factory", approvals: [{ by: "p-omar", at: expect.any(Number) }], needs: expect.any(Number) } });
      // Everyone sees that the factory is killed, with no more than the stop itself.
      expect((await call(engineer, "/api/v1/home")).body.sections.attention[0]).toMatchObject({ id: "hm-att-factory" });
      // While killed nobody can approve the gate.
      expect((await call(lead, "/api/v1/home")).body.approvals).toEqual([]);
      await t.db.admin.query(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = 'factory:factory:9'`);
    });
    it("starts empty without the dev seed: no invented work, zero figures", async () => {
      const e = await startApp({ seed: false, config: { bootstrapAdminEmail: "boss@example.com" } });
      try {
        await e.db.admin.query(
          `insert into people (org_id, id, name, email, status) values ($1,'p-boss','Boss','boss@example.com','active')`, [e.orgId]);
        await e.db.admin.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type) values ($1,'ra-boss','p-boss','factory_admin','factory')`, [e.orgId]);
        const s = await e.session("p-boss");
        const r = await e.app.inject({ method: "GET", url: "/api/v1/home", headers: s.headers });
        expect(r.statusCode).toBe(200);
        const b = r.json();
        expect(b).toMatchObject({ approvals: [], conversations: [], badges: {} });
        expect(b.sections).toMatchObject({ attention: [], motion: { inFlight: 0, shippedToday: 0, shippedWeek: 0 }, health: { spend: { spent: 0, budget: 0 }, evals: null } });
        // A new org: the setup checklist is the next step, with nothing done yet but the first step active.
        expect(b.sections.setup.steps.map((x: any) => `${x.id}:${x.state}`)).toEqual(["github:active", "vendor:todo", "project:todo", "repo:todo", "work-order:todo"]);
        const a = await e.app.inject({ method: "GET", url: "/api/v1/audit", headers: s.headers });
        expect(a.json().items.every((x: any) => x.action !== "role.add" || true)).toBe(true);
      } finally {
        await e.close();
      }
    });
    it("needs a signed-in person", async () => {
      expect((await t.app.inject({ method: "GET", url: "/api/v1/home" })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "GET", url: "/api/v1/activity" })).statusCode).toBe(401);
    });
  });
});
