import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { reconcileStop } from "../src/areas/stops/enforce.js";

const d = TEST_URL ? describe : describe.skip;
d("sc6 project archive and templates", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ seedAudit: true }); });
  afterAll(() => t.close());
  const w = world(() => t);

  it("A1: a work order running when the project is archived keeps advancing, starting new attempts, while the project is read-only", async () => {
    const id = await w.atStation("build" , "Archive while running").catch(async () => w.atStation("plan", "Archive while running"));
    const att = await w.liveAttempt(id);
    console.log("A1 live attempt", JSON.stringify(att));
    const wrong = await w.call("p-asha", "POST", "/api/v1/projects/payments/archive", { confirmText: "nope" });
    expect(String(wrong.body.msg), "the confirm says how many live orders will be held").toMatch(/live work order/);
    const a = await w.call("p-asha", "POST", "/api/v1/projects/payments/archive", { confirmText: "Payments Platform" });
    console.log("A1 archive", a.status, a.body.msg);
    expect(a.status).toBe(200);
    // the worker's stop.enforce job, run here
    const stopId = (await w.q(`select id from stops where project_id = 'payments' and cause = 'archive' and lifted_at is null`))[0]?.id;
    if (stopId) await w.tx((tx) => reconcileStop(tx, stopId, { haltGraceMs: 0 }));
    const r = await w.apply(att!, { status: "succeeded", summary: "done" });
    console.log("A1 apply result", JSON.stringify(r).slice(0, 200));
    const after = await w.q(`select position, state from work_orders where id = $1`, [id]);
    const live = await w.q(`select station, state from attempts where wo_id = $1 and state in ('queued','running')`, [id]);
    console.log("A1 after", JSON.stringify(after), JSON.stringify(live));
    expect(live, "no new attempt starts in an archived project").toHaveLength(0);
    expect(String(a.body.msg)).toMatch(/live work order.*held in place/);
    expect(a.body.held).toBeGreaterThan(0);
    const stop = await w.q(`select id from stops where project_id = 'payments' and cause = 'archive' and lifted_at is null`);
    expect(stop).toHaveLength(1);
    const un = await w.call("p-asha", "POST", "/api/v1/projects/payments/unarchive", {});
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    expect(String(un.body.msg)).toMatch(/released/);
    expect(await w.q(`select id from stops where project_id = 'payments' and cause = 'archive' and lifted_at is null`)).toHaveLength(0);
  });

  it("T1: a template saved from a project with stricter approver rules gives new projects weaker ones", async () => {
    await w.call("p-asha", "POST", "/api/v1/projects/payments/unarchive", {});
    const strict = { roles: ["line_lead", "project_admin"], people: [], required: 2, sod: true, conditions: [], escalateH: 4, fallback: null };
    const put = await w.call("p-asha", "PUT", "/api/v1/projects/payments/approvers/G2", { value: strict });
    console.log("T1 put 3-of rule", put.status, String(put.body.msg).slice(0, 120));
    const tpl = await w.call("p-asha", "POST", "/api/v1/templates", { fromProject: "payments", name: "Payments strict copy" }, { "idempotency-key": "t1-tpl" });
    console.log("T1 template", tpl.status, tpl.body.template?.approverPreset);
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const np = await w.call("p-asha", "POST", "/api/v1/projects", { name: "Copy of Payments", templateId: tpl.body.template.id, teams: [], owner: "p-asha" }, { "idempotency-key": "t1-proj" });
    console.log("T1 create", np.status, String(np.body.msg).slice(0, 100), np.body.id ?? np.body.project?.id);
    expect(np.status, JSON.stringify(np.body)).toBe(200);
    const pid = (np.body.id ?? np.body.project?.id) as string;
    const rules = (await w.q(`select gate_id, rule from approver_rule_versions where project_id = $1 and gate_id = 'G2' order by version desc limit 1`, [pid]).catch(async () => [])) as any[];
    console.log("T1 new project G2 rule", JSON.stringify(rules));
    const src = await w.q(`select gate_id, rule from approver_rule_versions where project_id = 'payments' and gate_id = 'G2' order by version desc limit 1`).catch(() => []);
    console.log("T1 source G2 rule", JSON.stringify(src));
    const req = (r: any[]) => Number(r[0]?.rule?.required ?? 0);
    expect(req(rules), "the template promised the source's rules").toBeGreaterThanOrEqual(req(src as any[]));
    expect(rules[0].rule.escalateH).toBe(4);
    expect(rules[0].rule.roles).toEqual(["line_lead", "project_admin"]);
  });
});
