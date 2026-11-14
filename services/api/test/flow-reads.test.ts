import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("flow reads: list, traveler, floor and replay, record, home", () => {
  let t: TestApp;
  let ids: { gate: string; run: string; intake: string; done: string };
  let beforeAll_ms = 0;
  beforeAll(async () => {
    t = await startApp();
    const w = world(() => t);
    beforeAll_ms = Date.now();
    const intake = (await w.submit("p-tomas", { title: "Read me: at intake", priority: "P1", repo: "payouts-worker" })).body.id as string;
    const run = await w.atStation("research", "Read me: running");
    const gate = (await w.submit("p-tomas", { title: "Read me: waiting at a gate" })).body.id as string;
    await w.answerAll(gate);
    await w.confirm(gate);
    await w.walk(gate, (x) => x.state === "waiting" && x.allowed.approve?.gate !== "G0G1" && !!x.allowed.approve);
    const done = (await w.submit("p-meera", { title: "Read me: finished" })).body.id as string;
    await w.answerAll(done, "p-meera");
    await w.confirm(done, "p-meera");
    await w.walk(done, (x) => x.state === "done");
    ids = { gate, run, intake, done };
  }, 120000);
  afterAll(() => t.close());
  const w = world(() => t);

  it("lists a project's work orders with filters, sort and a cursor", async () => {
    const all = await w.call("p-asha", "GET", "/api/v1/projects/payments/work-orders");
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(4);
    expect(all.body.items.map((x: any) => x.id)).toEqual([ids.done, ids.gate, ids.run, ids.intake].sort().reverse());
    const open = await w.call("p-asha", "GET", "/api/v1/projects/payments/work-orders?state=open&sort=id&dir=asc&limit=2");
    expect(open.body.items.length).toBe(2);
    expect(open.body.next).toBeTruthy();
    const next = await w.call("p-asha", "GET", `/api/v1/projects/payments/work-orders?state=open&sort=id&dir=asc&limit=2&cursor=${open.body.next}`);
    expect(next.body.items.length).toBe(1);
    expect(next.body.next).toBeNull();
    expect((await w.call("p-asha", "GET", "/api/v1/projects/payments/work-orders?q=finished")).body.items.map((x: any) => x.id)).toEqual([ids.done]);
    expect((await w.call("p-asha", "GET", "/api/v1/projects/payments/work-orders?prio=P1")).body.items.map((x: any) => x.id)).toEqual([ids.intake]);
    expect((await w.call("p-asha", "GET", "/api/v1/projects/payments/work-orders?repo=payouts-worker")).body.items.map((x: any) => x.id)).toEqual([ids.intake]);
    expect((await w.call("p-asha", "GET", "/api/v1/projects/payments/work-orders?state=done")).body.items.length).toBe(1);
    // a person who cannot see the project does not learn it exists
    expect((await w.call("p-diego", "GET", "/api/v1/projects/payments/work-orders")).status).toBe(404);
    expect((await w.call("p-diego", "GET", `/api/v1/work-orders/${ids.run}`)).status).toBe(404);
  });

  it("the traveler carries gate progress and what the viewer may do", async () => {
    const wo = await w.call("p-priya", "GET", `/api/v1/work-orders/${ids.gate}`);
    expect(wo.status).toBe(200);
    expect(wo.body).toMatchObject({ id: ids.gate, state: "waiting", version: expect.any(Number), route: expect.any(Array) });
    const gate = wo.body.allowed.approve.gate as string;
    expect(wo.body.gateProgress[gate]).toMatchObject({ have: 0, need: expect.any(Number) });
    expect(wo.body.allowed.approve.allowed).toBe(true);
    const rui = (await w.call("p-rui", "GET", `/api/v1/work-orders/${ids.gate}`)).body;
    expect(rui.allowed.approve.allowed).toBe(false);
    expect(rui.allowed.can.sendback.allowed).toBe(false);
    expect(wo.body.allowed.moves).toBeDefined();
    expect((await w.call("p-asha", "GET", "/api/v1/work-orders/WO-0")).status).toBe(404);
    // gate approve and reject: denied and stale
    const v = wo.body.version as number;
    const before = Number((await w.q(`select count(*)::int n from events where outcome = 'denied'`))[0].n);
    const url = `/api/v1/gate-instances/${encodeURIComponent(`${ids.gate}:${gate}`)}`;
    for (const verb of ["approve", "reject"]) {
      expect((await w.call("p-rui", "POST", `${url}/${verb}`, { reason: "Not convinced by the tests" })).status).toBe(403);
      const st = await w.call("p-priya", "POST", `${url}/${verb}`, { reason: "Not convinced by the tests" }, w.ifm(v + 9));
      expect(st.status).toBe(409);
    }
    expect(Number((await w.q(`select count(*)::int n from events where outcome = 'denied'`))[0].n)).toBe(before + 2);
    expect((await w.get(ids.gate)).version).toBe(v);
  });

  it("conversations: the inbox of intake conversations, and the ones waiting on me", async () => {
    const all = await w.call("p-asha", "GET", "/api/v1/conversations?project=payments");
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBe(4);
    expect(all.body.items[0].conv.messages.length).toBeGreaterThan(0);
    const mine = await w.call("p-tomas", "GET", "/api/v1/conversations?awaitingMe=true");
    expect(mine.body.items.map((x: any) => x.id)).toEqual([ids.intake]);
  });

  it("the floor shows positions, gates, slots and stop state; ?at= replays an earlier time", async () => {
    const f = await w.call("p-asha", "GET", "/api/v1/projects/payments/floor");
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ flowVersion: 1, project: { id: "payments" }, stop: null, slots: { total: 2 } });
    expect(f.body.gates.map((g: any) => g.wo)).toContain(ids.gate);
    expect(f.body.workOrders.length).toBe(4);
    // replay: before the first work order there is nothing; right after the first submission only the intake one exists
    const early = await w.call("p-asha", "GET", `/api/v1/projects/payments/floor?at=${beforeAll_ms - 60_000}`);
    expect(early.status).toBe(200);
    expect(early.body.workOrders).toEqual([]);
    const created = Number((await w.q(`select (extract(epoch from created_at) * 1000)::float8 as ms from work_orders where id = $1`, [ids.run]))[0].ms);
    const mid = await w.call("p-asha", "GET", `/api/v1/projects/payments/floor?at=${Math.floor(created) - 1}`);
    expect(mid.body.at).toBeGreaterThan(0);
    expect(mid.body.workOrders.map((x: any) => x.id)).toEqual([ids.intake]);
    expect(mid.body.workOrders[0]).toMatchObject({ station: 0 });
    // the finished work order replays as done now and as running before it finished
    const doneAt = Number((await w.q(`select (extract(epoch from closed_at) * 1000)::float8 as ms from work_orders where id = $1`, [ids.done]))[0].ms);
    const before = await w.call("p-asha", "GET", `/api/v1/projects/payments/floor?at=${Math.floor(doneAt) - 5}`);
    expect(before.body.workOrders.find((x: any) => x.id === ids.done)?.state).not.toBe("done");
    expect((await w.call("p-diego", "GET", "/api/v1/projects/payments/floor")).status).toBe(404);
    // events for the replay marks come from the audit area
    const ev = await w.call("p-asha", "GET", "/api/v1/projects/payments/events?kinds=wo.submit");
    expect(ev.body.length).toBe(4);
  });

  it("the record: request verbatim, classification, gates with pinned versions, markdown and a hashed export", async () => {
    const rec = await w.call("p-asha", "GET", `/api/v1/work-orders/${ids.done}/record`);
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ id: ids.done, state: "done", flowVersion: 1, request: { by: "p-meera" }, classification: { final: expect.any(String) } });
    expect(rec.body.request.text).toContain("Read me: finished");
    expect(rec.body.briefVersions.length).toBe(1);
    expect(rec.body.gates.length).toBeGreaterThan(2);
    const decided = rec.body.gates.find((g: any) => g.decision?.decision === "approved");
    expect(decided.pinned.flowVersion).toBe(1);
    expect(decided.decision.detail.voters.length).toBeGreaterThan(0);
    expect(rec.body.attempts.length).toBeGreaterThan(3);
    expect(rec.body.totals.tokens).toBe(0);
    const md = await w.call("p-asha", "GET", `/api/v1/work-orders/${ids.done}/record.md`);
    expect(md.status).toBe(200);
    expect(md.headers["content-type"]).toMatch(/markdown/);
    expect(md.body.text).toContain(`# ${ids.done}: Read me: finished`);
    const ex = await w.call("p-asha", "GET", `/api/v1/work-orders/${ids.done}/record/export`);
    expect(ex.status).toBe(200);
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const m = ex.body.manifest.files as Array<{ name: string; sha256: string }>;
    expect(m.map((f) => f.name)).toEqual(["record.json", "record.md", "events.json", "gates.json"]);
    expect(m.find((f) => f.name === "record.md")!.sha256).toBe(sha(ex.body.files["record.md"]));
    expect(m.find((f) => f.name === "record.json")!.sha256).toBe(sha(JSON.stringify(ex.body.files["record.json"], null, 2)));
    const ch = await w.call("p-asha", "GET", `/api/v1/work-orders/${ids.done}/changes`);
    expect(ch.body).toMatchObject({ commits: [], files: [], patches: [], pullRequests: [] });
    await t.db.admin.query(`insert into commits (org_id, id, repo_id, sha, wo_id, message) values ($1,'c1','payments-api','aaaabbbbcccc',$2,'Add idempotency')`, [t.orgId, ids.done]);
    expect((await w.call("p-asha", "GET", `/api/v1/work-orders/${ids.done}/changes`)).body.commits[0]).toMatchObject({ sha: "aaaabbbbcccc", message: "Add idempotency" });
  });

  it("home reflects real work orders: my approvals, my conversations, attention and figures", async () => {
    const priya = await w.call("p-priya", "GET", "/api/v1/home");
    expect(priya.status).toBe(200);
    expect(priya.body.approvals.some((a: any) => a.wo === ids.gate)).toBe(true);
    const tomas = await w.call("p-tomas", "GET", "/api/v1/home");
    expect(tomas.body.conversations.some((c: any) => c.wo === ids.intake || c.id === ids.intake)).toBe(true);
    const asha = await w.call("p-asha", "GET", "/api/v1/home");
    expect(asha.body.figures).toMatchObject({ inFlight: expect.any(Number), gatesWaiting: expect.any(Number) });
    expect(asha.body.figures.inFlight).toBeGreaterThanOrEqual(3);
    expect(asha.body.figures.gatesWaiting).toBeGreaterThanOrEqual(1);
    expect(asha.body.figures.shippedWeek).toBe(1);
    // kill one: it shows in the figures and is no longer in flight
    const k = await w.call("p-meera", "POST", "/api/v1/stops", { scope: "workorder", id: ids.run, mode: "kill", reason: "Cancelled by the requester" });
    expect(k.status).toBe(200);
    const { reconcileStop } = await import("../src/areas/stops/enforce.js");
    await w.tx((tx) => reconcileStop(tx, String(k.body.stop)));
    const after = await w.call("p-asha", "GET", "/api/v1/home");
    expect(after.body.figures.killedWorkOrders).toBe(1);
  });
});
