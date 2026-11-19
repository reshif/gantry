import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trustCellId } from "@gantry/domain";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { afterFinish } from "../src/areas/trust/record.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";
const CELL = "ag-spec|feature|payments";
const REPO = trustCellId("ag-spec", "feature", "payments", "payments-api");

d("round 2: probation ends on repo cells (S-38)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seedEvals: true });
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  const cells = async () => (await w.call(ADMIN, "GET", "/api/v1/trust/cells")).body.cells as any[];
  const cell = async (id: string) => (await cells()).find((c) => c.id === id);
  let n = 0;
  const finish = async () => {
    const id = `WO-R2P-${++n}`;
    await w.insertWo(id, { state: "done", position: "done" });
    const inst = `${id}:G2:1`;
    await q(`insert into gate_instances (org_id, id, wo_id, gate_id, status, closed_reason, flow_version) values ($1,$2,$3,'G2','closed','decision',1)`, [t.orgId, inst, id]);
    await q(`insert into gate_decisions (org_id, id, gate_instance_id, wo_id, decision, decided_by, flow_version) values ($1,$2,$3,$4,'approved','p-priya',1)`, [t.orgId, `GD-${id}`, inst, id]);
    await w.tx((tx: any) => afterFinish(tx, t.orgId, id, new Date(), () => undefined));
  };

  it("six clean finishes end probation on the project cell and the repo cell alike", async () => {
    expect((await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true, reason: "Enough evidence on payments" })).status).toBe(200);
    for (const target of [CELL, { agent: "ag-spec", cls: "feature", project: "payments", repo: "payments-api" }]) {
      const r = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target, level: 3, reason: "Specs have been clean for a month" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect(await cell(REPO)).toMatchObject({ level: 3 });
    await w.call(ADMIN, "POST", "/api/v1/agents/ag-spec/versions", { label: "8.8.0" });
    const suite = (await q(`select data->>'suite' as s from agents where id = 'ag-spec'`))[0].s;
    await q(`insert into eval_runs (org_id, id, suite_id, status, score, data) values ($1,'RUN-P38',$2,'completed',0.97,$3::jsonb)`, [t.orgId, suite, JSON.stringify({ agent: "ag-spec", version: "8.8.0" })]);
    expect((await w.call(ADMIN, "POST", "/api/v1/agents/ag-spec/versions/8.8.0/promote")).status).toBe(200);
    expect(await cell(REPO)).toMatchObject({ effective: 2, probation: { runsLeft: 5 } });
    for (let i = 0; i < 6; i++) await finish();
    expect(await cell(CELL)).toMatchObject({ effective: 3, probation: null });
    expect(await cell(REPO)).toMatchObject({ effective: 3, probation: null });
  });
});
