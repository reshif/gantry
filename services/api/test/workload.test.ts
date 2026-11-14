import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ASHA = "p-asha";

d("workload figures (spec 8.9, 13.5)", () => {
  let t: TestApp;
  let done = "";
  let waiting = "";
  beforeAll(async () => {
    t = await startApp();
    const w = world(() => t);
    done = (await w.submit("p-tomas", { title: "Workload: finished" })).body.id as string;
    await w.answerAll(done);
    await w.confirm(done);
    await w.walk(done, (x) => x.state === "done");
    waiting = (await w.submit("p-tomas", { title: "Workload: waiting at a gate" })).body.id as string;
    await w.answerAll(waiting);
    await w.confirm(waiting);
    await w.walk(waiting, (x) => x.state === "waiting" && x.allowed.approve?.gate !== "G0G1" && !!x.allowed.approve);
  }, 180000);
  afterAll(() => t.close());
  const w = world(() => t);
  const wl = async (who: string, qs = "") => w.call(who, "GET", `/api/v1/workload${qs}`);

  it("is for signed-in people only", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/v1/workload" })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/workload", headers: { authorization: "Bearer edge-token-for-tests" } })).statusCode).toBeGreaterThanOrEqual(401);
  });

  it("computes people, teams, waits and minutes from the work order records", async () => {
    const r = await wl(ASHA);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = r.body;
    expect(m).toMatchObject({ scope: "all", days: 7, minN: 5, factoryWide: true });
    expect(m.projects.map((p: any) => p.id)).toContain("payments");
    // the finished work order produced confirmations and approvals by real people
    expect(m.totals.acts).toBeGreaterThan(2);
    expect(m.totals.minutes).toBeGreaterThan(0);
    const approvals = m.rows.reduce((s: number, x: any) => s + x.approvals, 0);
    expect(approvals).toBeGreaterThan(1);
    const row = m.rows.find((x: any) => x.approvals > 0);
    expect(row).toMatchObject({ person: expect.stringMatching(/^p-/), name: expect.any(String), perDay: expect.any(Number), recent: expect.any(Array) });
    expect(row.recent[0]).toMatchObject({ kind: expect.stringMatching(/approve|confirm|answer/), wo: expect.any(String) });
    // response time is timed from when each gate opened, also for gates that have since been decided
    expect(m.totals.timedN).toBeGreaterThan(0);
    expect(m.rows.some((x: any) => x.waitN > 0 && x.medianResponseMin >= 1)).toBe(true);
    expect(m.bottlenecks.some((b: any) => b.decisions > 0 && b.medianWaitMin >= 1)).toBe(true);
    expect(m.byCls[0]).toMatchObject({ key: expect.any(String), minutes: expect.any(Number), workOrders: expect.any(Number), perWO: expect.any(Number) });
    expect(m.byProject.map((x: any) => x.key)).toContain("payments");
    // the work order waiting at a gate is listed with who may decide it
    expect(m.totals.gatesWaiting).toBeGreaterThanOrEqual(1);
    const mine = m.rows.flatMap((x: any) => x.waitingGates).filter((g: any) => g.wo.id === waiting);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]).toMatchObject({ wo: { id: waiting, title: "Workload: waiting at a gate", project: "payments" }, eligible: expect.any(Number) });
    expect(m.bottlenecks.some((b: any) => b.project === "payments" && b.open >= 1)).toBe(true);
    // heavy records stay out of the payload
    expect(JSON.stringify(m)).not.toContain('"gates":{');
    expect(Array.isArray(m.suggestions)).toBe(true);
  });

  it("counts the share of waiting gates where one person is the only way through", async () => {
    const m = (await wl(ASHA)).body;
    const soleSum = m.rows.reduce((s: number, x: any) => s + x.sole, 0);
    expect(m.totals.soleGates).toBeGreaterThanOrEqual(0);
    expect(soleSum).toBe(m.rows.flatMap((x: any) => x.waitingGates).filter((g: any) => g.eligible === 1).length);
  });

  it("narrows to one project, and to a window", async () => {
    const r = await wl(ASHA, "?scope=payments&days=1");
    expect(r.body).toMatchObject({ scope: "payments", days: 1, ids: ["payments"] });
    expect(r.body.byProject.every((x: any) => x.key === "payments")).toBe(true);
    const other = await wl(ASHA, "?scope=storefront");
    expect(other.body.totals.acts).toBe(0);
  });

  it("refuses a project the person cannot see, and a bad window", async () => {
    expect((await wl("p-arjun", "?scope=payments")).status).toBe(404);
    expect((await wl(ASHA, "?scope=no-such-project")).status).toBe(404);
    expect((await wl(ASHA, "?days=0")).status).toBe(422);
    expect((await wl(ASHA, "?days=400")).status).toBe(422);
  });

  it("shows a person only the projects they can see", async () => {
    const r = await wl("p-arjun");
    expect(r.status).toBe(200);
    expect(r.body.projects.map((p: any) => p.id)).not.toContain("payments");
    expect(r.body.factoryWide).toBe(false);
    expect(r.body.ids).not.toContain("payments");
    expect(r.body.byProject.map((x: any) => x.key)).not.toContain("payments");
  });

  it("suggests a second approver where one person is the only eligible approver, with a link to the rule", async () => {
    const before = (await wl(ASHA)).body;
    const gate = before.rows.flatMap((x: any) => x.waitingGates).find((g: any) => g.wo.id === waiting).gate as string;
    // a rule that names one person leaves them as the only way through the gate
    const put = await w.call(ASHA, "PUT", `/api/v1/projects/payments/approvers/${gate}`, { value: { roles: [], people: ["p-priya"], required: 1, sod: false, conditions: [], escalateH: 0, fallback: null } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const m = (await wl(ASHA)).body;
    const priya = m.rows.find((x: any) => x.person === "p-priya");
    expect(priya.sole).toBeGreaterThanOrEqual(1);
    expect(priya.waitingGates.some((g: any) => g.wo.id === waiting && g.eligible === 1)).toBe(true);
    expect(m.totals.soleGates).toBeGreaterThanOrEqual(1);
    const s = m.suggestions.find((x: any) => x.key === "sole:p-priya");
    expect(s).toMatchObject({ kind: "approver", text: expect.stringContaining("only eligible approver"), action: { type: "config", project: "payments", gate, id: "wl-sg-sole-p-priya" } });
    expect(s.text).toContain(waiting);
  });
});
