import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("flow: submit, intake, confirm", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  it("submits a work order: classified, flow version pinned, request verbatim, conversation open", async () => {
    const r = await w.submit();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, classification: { cls: expect.any(String) }, route: expect.any(Array) });
    const id = r.body.id as string;
    expect(id).toMatch(/^WO-\d+$/);
    const [row] = await w.q(`select * from work_orders where id = $1`, [id]);
    expect(row).toMatchObject({ position: "intake", state: "waiting", flow_version: 1, submitter: "p-tomas" });
    const [req] = await w.q(`select original_text from requests where wo_id = $1`, [id]);
    expect(req.original_text).toContain("Refunds can be retried");
    const wo = await w.get(id);
    expect(wo.conv.messages.length).toBeGreaterThanOrEqual(3);
    expect(wo.gates.G0G1.status).toBe("waiting");
    expect(wo.allowed.approve).toMatchObject({ gate: "G0G1" });
    expect((await w.events("wo.submit")).length).toBe(1);
  });

  it("denies a viewer and audits the denial", async () => {
    const before = (await w.events("wo.submit.denied")).length;
    const r = await w.submit("p-rui");
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
    const after = await w.events("wo.submit.denied");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1).outcome).toBe("denied");
  });

  it("walks one work order across the whole route to done", async () => {
    const sub = await w.submit("p-tomas", { title: "Walk the whole route" });
    const id = sub.body.id as string;
    await w.answerAll(id);
    const c = await w.confirm(id);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const approvers = ["p-priya", "p-meera", "p-grace", "p-kenji", "p-daniel", "p-asha", "p-omar"];
    const seen: string[] = [];
    for (let i = 0; i < 60; i++) {
      const wo = await w.get(id);
      if (wo.state === "done") break;
      seen.push(`${wo.station}:${wo.state}`);
      const att = await w.liveAttempt(id);
      if (wo.state === "running" && att) {
        const rr = await w.apply(att, { status: "succeeded", summary: `${att.station} done`, usage: { tokens: 1000, costUsd: 0.01 } });
        expect(rr.applied, JSON.stringify(rr)).toBe(true);
        continue;
      }
      if (wo.state === "waiting" && (await w.ciArrives(id))) continue;
      if (wo.state === "waiting" && wo.allowed.approve) {
        let passed = false;
        for (const who of approvers) {
          const r = await w.call(who, "POST", `/api/v1/gate-instances/${encodeURIComponent(`${id}:${wo.allowed.approve.gate}`)}/approve`, {});
          if (r.status === 200 && r.body.passed) {
            passed = true;
            break;
          }
        }
        expect(passed, `could not pass ${wo.allowed.approve.gate}`).toBe(true);
        continue;
      }
      throw new Error(`stuck: ${JSON.stringify({ state: wo.state, station: wo.station, bay: wo.bay, approve: wo.allowed.approve })}`);
    }
    const done = await w.get(id);
    expect(done.state, seen.join(" > ")).toBe("done");
    expect(await w.q(`select count(*)::int n from slots where wo_id = $1 and state = 'held'`, [id])).toEqual([{ n: 0 }]);
    const rec = await w.call("p-asha", "GET", `/api/v1/work-orders/${id}/record`);
    expect(rec.status).toBe(200);
    expect(rec.body.gates.length).toBeGreaterThan(2);
    expect(rec.body.gates.every((g: any) => g.status === "closed")).toBe(true);
  });
});
