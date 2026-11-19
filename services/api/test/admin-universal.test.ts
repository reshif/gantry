import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

/** Owner decision 2026-11-19: the Factory Admin is universal and can override everywhere, never silently. */
d("Factory Admin is universal", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  const rule = (over: Record<string, unknown> = {}) => ({ roles: ["reviewer", "approver", "line_lead", "release_manager", "project_admin"], people: [], required: 2, sod: true, conditions: [], escalateH: 0, fallback: null, ...over });
  const setRule = async (gate: string, value: object) => { const r = await w.call("p-daniel", "PUT", `/api/v1/projects/payments/approvers/${gate}`, { value }); expect(r.status, JSON.stringify(r.body)).toBe(200); }
  const atGate = async (title: string, first: object) => {
    await setRule("G2", first);
    const id = (await w.submit("p-tomas", { title })).body.id as string;
    const g0 = await w.call("p-asha", "GET", `/api/v1/work-orders/${id}`); expect(g0.status, JSON.stringify(g0.body)).toBe(200);
    await w.answerAll(id, "p-tomas");
    expect((await w.confirm(id, "p-tomas")).status).toBe(200);
    await w.walk(id, (x) => x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate === "G2");
    return { id, gate: "G2" };
  };
  const vote = async (who: string, id: string, gate: string, body: object = {}) => w.call(who, "POST", await w.gateUrl(id, gate, "approve"), body);
  const stopProject = (who: string, mode: "halt", reason: string) => w.call(who, "POST", "/api/v1/stops", { scope: "project", id: "payments", mode, reason });
  const lift = (who: string, id: string) => w.call(who, "DELETE", `/api/v1/stops/${encodeURIComponent(id)}`);

  it("A: the matrix refuses to switch off any factory_admin cell", async () => {
    const cur = (await w.call("p-asha", "GET", "/api/v1/access/matrix")).body;
    const r = await w.call("p-asha", "PUT", "/api/v1/access/matrix/factory_admin/audit.view", { on: false }, { "if-match": String(cur.version ?? 1) });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.rule?.id ?? r.body.rule?.kind).toBeTruthy();
  });

  it("C(i): N of M that cannot be reached: the admin passes with a reason, asks for one without, and a non-admin is not let through", async () => {
    // The rule screen refuses a rule nobody can meet when it is set; it becomes unreachable later, when people leave. Suspend all but a few after the work order waits.
    const { id, gate } = await atGate("Unreachable N of M", rule({ required: 5 }));
    const keep = ["p-asha", "p-omar", "p-priya", "p-tomas"];
    const was = await w.q(`select id, status from people where status = 'active' and id <> all($1)`, [keep]);
    await w.q(`update people set status = 'suspended' where status = 'active' and id <> all($1)`, [keep]);
    try {
    const other = await vote("p-priya", id, gate);
    expect(other.body).toMatchObject({ passed: false, need: 5 });
    const bare = await vote("p-asha", id, gate);
    expect(bare.status).toBe(403);
    expect(bare.body.needs).toBe("override_reason");
    expect((await w.q(`select count(*)::int n from gate_votes where gate_instance_id = $1 and voter = 'p-asha'`, [`${id}:${gate}:1`]))[0].n).toBe(0);
    const ok = await vote("p-asha", id, gate, { reason: "Only a few people can ever approve this." });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.passed).toBe(true);
    const dec = (await w.q(`select * from gate_decisions where gate_instance_id = $1`, [`${id}:${gate}:1`]))[0];
    expect(dec.detail).toMatchObject({ override: true, reason: "Only a few people can ever approve this." });
    expect((await w.events("gate.override")).at(-1)?.after).toMatchObject({ gate, unreachable: true });
    } finally {
      for (const r of was) await w.q(`update people set status = $2 where id = $1`, [r.id, r.status]);
    }
  });

  it("C: loosening the rule while votes are open: the screen shows the count the server enforces, and the admin can still pass with a reason", async () => {
    const { id, gate } = await atGate("Loosened while open", rule({ required: 2, sod: false }));
    expect((await vote("p-priya", id, gate)).body).toMatchObject({ passed: false, have: 1, need: 2 });
    await setRule(gate, rule({ required: 1, sod: false }));
    const wo = await w.get(id);
    expect(wo.gateProgress[gate]).toMatchObject({ have: 1, need: 2 }); // the opening keeps its count
    const ga = (await w.call("p-asha", "GET", `/api/v1/work-orders/${id}/gates/${gate}/approvers`)).body;
    expect(ga.progress.need).toBe(2);
    expect(ga.rule.required).toBe(2);
    // the server agrees: a second ordinary approval is needed
    expect((await vote("p-meera", id, gate)).body).toMatchObject({ passed: true, have: 2, need: 2 });
  });

  it("G: a halt blocks gate approval for everyone but the Factory Admin, who passes it with a reason, audited; a kill still blocks", async () => {
    const { id, gate } = await atGate("Approve anyway", rule({ required: 1, sod: false }));
    const h = await stopProject("p-meera", "halt", "Holding the line");
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    const nonAdmin = await vote("p-priya", id, gate, { reason: "I would like to approve anyway" });
    expect(nonAdmin.status).toBe(409);
    const bare = await vote("p-asha", id, gate);
    expect(bare.status).toBe(409);
    expect(bare.body.needs === "override_reason" || bare.body.needs === "Resume first").toBe(true);
    const canNow = await w.call("p-asha", "POST", "/api/v1/can", { checks: [{ action: "gate.approve", project: "payments" }] });
    expect(canNow.body.results[0]).toMatchObject({ allowed: false, override: true, needs: "override_reason" });
    const ok = await vote("p-asha", id, gate, { reason: "Approved while the line is halted." });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.passed).toBe(true);
    expect((await w.events("gate.override")).at(-1)).toMatchObject({ actor: "p-asha" });
    expect((await w.events("gate.override")).at(-1)?.after).toMatchObject({ kind: "halt", gate });
    const dec = (await w.q(`select * from gate_decisions where gate_instance_id = $1`, [`${id}:${gate}:1`]))[0];
    expect(dec.detail).toMatchObject({ override: true, reason: "Approved while the line is halted." });
    // the halt stays in force
    expect((await w.q(`select 1 from stops where mode = 'halt' and lifted_at is null`)).length).toBeGreaterThan(0);
    expect((await w.submit("p-tomas", { title: "Still refused while halted" })).status).toBe(409);
    expect((await lift("p-meera", "project:payments")).status).toBe(200);
  });

  it("G2: during a halt the Factory Admin confirms the brief with a reason (audited); without one it asks; a non-admin is refused", async () => {
    const id = (await w.submit("p-tomas", { title: "Brief confirmed during a halt" })).body.id as string;
    await w.answerAll(id, "p-tomas");
    expect((await stopProject("p-meera", "halt", "Holding the line")).status).toBe(200);
    try {
      expect((await w.confirm(id, "p-tomas")).status).toBe(409);
      const bare = await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/confirm-brief`, {});
      expect(bare.status).toBe(409);
      expect(bare.body.needs).toBe("override_reason");
      const short = await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/confirm-brief`, { reason: "no" });
      expect(short.body.needs).toBe("override_reason");
      const non = await w.call("p-priya", "POST", `/api/v1/work-orders/${id}/confirm-brief`, { reason: "I would like to confirm anyway" });
      expect([403, 409]).toContain(non.status);
      const ok = await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/confirm-brief`, { reason: "Confirmed while the line is halted." });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await w.events("gate.override")).at(-1)).toMatchObject({ actor: "p-asha" });
      expect((await w.events("gate.override")).at(-1)?.after).toMatchObject({ gate: "G0G1", kind: "halt", text: "Confirmed while the line is halted." });
    } finally {
      expect((await lift("p-meera", "project:payments")).status).toBe(200);
    }
  });

  it("C(ii): a release freeze refuses everyone else, and the admin releases with a reason and an audit event", async () => {
    // G2 is made the release gate for this test; the seed's POL-110 denies release on repos under a freeze.
    const gates = DEFAULT_CATALOG.gates.map((g) => (g.id === "G2" ? { ...g, action: "release" } : g));
    const prior = (await w.q(`select settings from orgs limit 1`))[0].settings;
    await w.q(`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{catalog,gates}', $1::jsonb, true)`, [JSON.stringify(gates)]);
    await w.q(`insert into freezes (org_id, id, scope_type, name, starts_at, ends_at, created_by, data) values ($1,'FRZ-T1','factory','Test freeze', now() - interval '1 hour', now() + interval '2 hours','p-asha','{"repos":"all"}'::jsonb)`, [t.orgId]);
    try {
      const { id, gate } = await atGate("Release in a freeze", rule({ required: 1, sod: false, roles: ["release_manager", "line_lead", "project_admin"] }));
      const kenji = await vote("p-kenji", id, gate, { reason: "Please let me through the freeze" });
      expect(kenji.status).toBe(403);
      const bare = await vote("p-asha", id, gate);
      expect(bare.status).toBe(403);
      expect(bare.body.needs).toBe("override_reason");
      const ok = await vote("p-asha", id, gate, { reason: "Critical customer fix during the freeze." });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.passed).toBe(true);
      expect((await w.events("gate.override")).at(-1)?.after).toMatchObject({ kind: "freeze", gate, text: "Critical customer fix during the freeze." });
    } finally {
      await w.q(`delete from freezes where id = 'FRZ-T1'`);
      await w.q(`update orgs set settings = $1::jsonb`, [JSON.stringify(prior)]);
    }
  });
});
