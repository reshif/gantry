import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { handleFlowTimer } from "../src/areas/workorders/station.js";

const d = TEST_URL ? describe : describe.skip;
d("sc6 escalation", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ seedAudit: true }); });
  afterAll(() => t.close());
  const w = world(() => t);
  const rule = (over: Record<string, unknown> = {}) => ({ roles: ["line_lead"], people: [], required: 1, sod: true, conditions: [], escalateH: 0, fallback: null, ...over });
  const setRule = async (value: object) => { const r = await w.call("p-daniel", "PUT", `/api/v1/projects/payments/approvers/G2`, { value }); expect(r.status, JSON.stringify(r.body)).toBe(200); };
  const toG2 = async (title: string, who = "p-tomas") => {
    const sub = await w.submit(who, { title });
    const id = sub.body.id as string;
    await w.answerAll(id, who);
    expect((await w.confirm(id, who)).status).toBe(200);
    await w.walk(id, (x) => x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate === "G2");
    return id;
  };
  const timers = (id: string) => w.q(`select kind, status, fire_at, extract(epoch from (fire_at - now()))/3600 as hours from timers where payload->>'woId' = $1 order by id`, [id]);

  it("E1: the escalation limit is read when the gate opens; editing it later changes nothing for the work already waiting", async () => {
    await setRule(rule({ escalateH: 24 }));
    const id = await toG2("Escalation timer edit");
    const before = await timers(id);
    console.log("E1 timers at open (24h)", JSON.stringify(before));
    await setRule(rule({ escalateH: 1 }));
    const after = await timers(id);
    console.log("E1 timers after lowering to 1h", JSON.stringify(after));
    expect(after.some((x: any) => x.status === "pending" && Number(x.hours) <= 1), "a 1 h limit is now in force for the waiting gate").toBe(true);
    expect(after.filter((x: any) => x.status === "pending")).toHaveLength(1);
    await setRule(rule({ escalateH: 0 }));
    expect((await timers(id)).filter((x: any) => x.status === "pending"), "limit 0 cancels the timer").toHaveLength(0);
  });

  it("E2: switching escalation on after the gate opened never arms a timer", async () => {
    await setRule(rule({ escalateH: 0 }));
    const id = await toG2("Escalation switched on late");
    expect(await timers(id)).toHaveLength(0);
    await setRule(rule({ escalateH: 1 }));
    expect((await timers(id)).length, "no timer for the gate already waiting").toBeGreaterThan(0);
    // already overdue: measured from when the gate opened, so a 1 h limit on a gate opened 3 h ago fires at once
    await w.q(`update gate_instances set opened_at = now() - interval '3 hours' where wo_id = $1 and status = 'open'`, [id]);
    const put = await w.call("p-daniel", "PUT", `/api/v1/projects/payments/approvers/G2`, { value: rule({ escalateH: 2 }) });
    expect(String(put.body.msg)).toMatch(/applies to \d+ waiting work order/);
    const t2 = (await timers(id)).filter((x: any) => x.status === "pending");
    expect(t2).toHaveLength(1);
    expect(Number(t2[0].hours), "overdue: due in the past").toBeLessThan(0);
  });

  it("E3: a fallback who cannot approve is refused; one who lost the right before the timer fires is named as not reached", async () => {
    const put = await w.call("p-daniel", "PUT", `/api/v1/projects/payments/approvers/G2`, { value: rule({ escalateH: 1, fallback: "p-rui" }) });
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    expect(String(put.body.msg)).toMatch(/cannot approve/);
    await setRule(rule({ escalateH: 1, fallback: "p-grace" }));
    const id = await toG2("Escalation fallback loses the right");
    const inst = (await w.q(`select id from gate_instances where wo_id = $1 and status = 'open'`, [id]))[0].id;
    await t.db.admin.query(`update role_assignments set revoked_at = now() where person_id = 'p-grace'`);
    await w.tx((tx) => handleFlowTimer(tx, { kind: "escalation", woId: id, gateInstanceId: inst }, { now: new Date(Date.now() + 3 * 3_600_000) }));
    const ev = (await w.q(`select after from events where wo_id = $1 and type = 'gate.escalated'`, [id]))[0];
    expect(ev.after.reached).toBeNull();
    expect(String(ev.after.text)).toMatch(/reached nobody/);
  });

  it("E3b: an escalation names the person it reaches", async () => {
    await setRule(rule({ escalateH: 1, fallback: "p-asha" }));
    const id = await toG2("Escalation reaches the fallback");
    const inst = (await w.q(`select id from gate_instances where wo_id = $1 and status = 'open'`, [id]))[0].id;
    await w.tx((tx) => handleFlowTimer(tx, { kind: "escalation", woId: id, gateInstanceId: inst }, { now: new Date(Date.now() + 3 * 3_600_000) }));
    const ev = (await w.q(`select after from events where wo_id = $1 and type = 'gate.escalated'`, [id]))[0];
    expect(ev.after.reached).toBe("p-asha");
  });

  it("E4: a gate decided before its timer fires leaves no escalation behind (held)", async () => {
    await setRule(rule({ escalateH: 1 }));
    const id = await toG2("Escalation after decision");
    const inst = (await w.q(`select id from gate_instances where wo_id = $1 and status = 'open'`, [id]))[0].id;
    const ok = await w.call("p-asha", "POST", await w.gateUrl(id, "G2"), {});
    console.log("E4 approve", ok.status, ok.body.passed);
    const tm = await timers(id);
    console.log("E4 timers after decision", JSON.stringify(tm.map((x: any) => x.status)));
    const run = await w.tx((tx) => handleFlowTimer(tx, { kind: "escalation", woId: id, gateInstanceId: inst }, { now: new Date(Date.now() + 3 * 3_600_000) }));
    console.log("E4 run", JSON.stringify(run));
    expect((await w.q(`select 1 from events where wo_id = $1 and type = 'gate.escalated'`, [id])).length).toBe(0);
  });
});
