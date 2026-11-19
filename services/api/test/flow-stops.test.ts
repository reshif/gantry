import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { pendingStops, reconcileStop } from "../src/areas/stops/enforce.js";

const d = TEST_URL ? describe : describe.skip;

d("stop controls", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const stop = (who: string, body: object, o: { authAgeSec?: number } = {}) => w.call(who, "POST", "/api/v1/stops", body, {}, o);
  const lift = (who: string, id: string) => w.call(who, "DELETE", `/api/v1/stops/${encodeURIComponent(id)}`);
  const restore = (who: string, id: string, reason = "The incident is over") => w.call(who, "POST", `/api/v1/stops/${encodeURIComponent(id)}/restore`, { reason });
  const reconcile = (stopRow: string) => w.tx((tx) => reconcileStop(tx, stopRow));
  const active = async () => w.q(`select id, scope_type, mode from stops where lifted_at is null order by set_at`);

  it("denies a caller without the right, and audits it", async () => {
    const before = (await w.events("line.halt.denied")).length;
    const r = await stop("p-rui", { scope: "project", id: "payments", mode: "halt", reason: "Too noisy today" });
    expect(r.status).toBe(403);
    expect((await w.events("line.halt.denied")).length).toBe(before + 1);
    await w.insertWo("WO-9001", { position: "build", state: "running" });
    const k = await stop("p-rui", { scope: "workorder", id: "WO-9001", mode: "kill", reason: "No longer wanted" });
    expect(k.status).toBe(403);
    expect((await w.events("kill.workorder.denied")).length).toBe(1);
    expect((await active()).length).toBe(0);
  });

  it("a project-level andon right halts its own project, never the whole factory; a Factory Admin halts and resumes the factory", async () => {
    const r = await stop("p-tomas", { scope: "factory", mode: "halt", reason: "Engineer tries the factory" });
    expect(r.status).toBe(403);
    expect((await w.events("halt.factory.denied")).length).toBe(1);
    expect((await active()).length).toBe(0);
    const h = await stop("p-asha", { scope: "factory", mode: "halt", reason: "Admin halts the factory" });
    expect(h.status).toBe(200);
    expect((await lift("p-tomas", "factory:")).status).toBe(403);
    expect((await w.events("resume.factory.denied")).length).toBe(1);
    expect((await lift("p-asha", "factory:")).status).toBe(200);
    expect((await active()).length).toBe(0);
  });

  it("validates reasons and confirmations, and refuses a stale resume", async () => {
    expect((await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "no" })).status).toBe(422);
    expect((await stop("p-asha", { scope: "project", id: "payments", mode: "kill", reason: "Security incident", confirmText: "payments" })).status).toBe(422);
    expect((await stop("p-asha", { scope: "factory", mode: "kill", reason: "Security incident", confirmText: "kill factory" })).status).toBe(422);
    expect((await stop("p-asha", { scope: "repo", id: "payments-api", mode: "kill", reason: "Security incident" })).status).toBe(422);
    expect((await stop("p-meera", { scope: "project", id: "nope", mode: "halt", reason: "Because I said so" })).status).toBe(404);
    const stale = await lift("p-meera", "project:payments");
    expect(stale.status).toBe(409);
    expect(stale.body.msg).toMatch(/not halted/);
    expect((await restore("p-asha", "project:payments")).status).toBe(409);
  });

  it("a halt refuses submissions and gate progression with the reason, keeps the slot, and resume lifts only itself", async () => {
    const id = await w.atStation("research", "Halt me");
    const att = (await w.liveAttempt(id))!;
    const h = await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "Flaky integration tests" });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(h.body).toMatchObject({ mode: "halt", apiId: "project:payments" });
    const again = await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "Flaky integration tests" });
    expect(again.status).toBe(409);
    const deniedBefore = (await w.events("wo.submit.denied")).length;
    const sub = await w.submit("p-tomas", { title: "Refused while halted" });
    expect(sub.status).toBe(409);
    expect(sub.body.msg).toMatch(/halted|Submissions are refused/);
    expect((await w.events("wo.submit.denied")).length).toBe(deniedBefore + 1);
    // the stop path wrote the event the floor replay reads
    expect((await w.q(`select after from events where type = 'halt' order by seq desc limit 1`))[0].after).toMatchObject({ scope: "project", text: "Flaky integration tests" });
    // enforce: the attempt is cancelled and its result can no longer be applied (fencing)
    const res = await reconcile(String(h.body.stop));
    expect(res).toMatchObject({ action: "enforced", attemptsCancelled: 1 });
    expect(await w.apply(att)).toMatchObject({ applied: false });
    expect((await reconcile(String(h.body.stop))).action).toBe("noop");
    const floor = await w.call("p-asha", "GET", "/api/v1/projects/payments/floor");
    expect(floor.body.stop).toMatchObject({ mode: "halt", scope: "project" });
    const r = await lift("p-meera", "project:payments");
    expect(r.status).toBe(200);
    expect((await reconcile(String(h.body.stop))).action).toBe("resumed");
    const after = await w.liveAttempt(id);
    expect(after?.station).toBe("research");
    expect(after?.id).not.toBe(att.id);
    expect((await w.liveAttempt(id))!.state).toBe("queued");
    expect((await w.submit("p-tomas", { title: "Accepted after resume" })).status).toBe(200);
  });

  it("a halt lifted before it was enforced still replaces the old attempt with a fresh one on resume", async () => {
    const id = await w.atStation("research", "Lifted before enforcement");
    const att = (await w.liveAttempt(id))!;
    const h = await stop("p-meera", { scope: "workorder", id, mode: "halt", reason: "Quick pause" });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    // resumed before the worker ran stop.enforce for the halt
    expect((await lift("p-meera", `workorder:${id}`)).status).toBe(200);
    expect((await reconcile(String(h.body.stop))).action).toBe("resumed");
    const fresh = (await w.liveAttempt(id))!;
    expect(fresh.id).not.toBe(att.id);
    expect((await w.q(`select state from attempts where id = $1`, [att.id]))[0].state).toBe("superseded");
    expect(await w.apply(att)).toMatchObject({ applied: false });
  });

  it("the most severe scope wins; lifting an outer stop never lifts an inner one; the factory restore needs two admins", async () => {
    expect((await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "Holding the line" })).status).toBe(200);
    const stale = await stop("p-asha", { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY" }, { authAgeSec: 4000 });
    expect(stale.status).toBe(403);
    expect(stale.body.needs).toBe("step_up");
    expect((await w.events("kill.factory.denied")).length).toBeGreaterThanOrEqual(1);
    const k = await stop("p-asha", { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY", inFlight: "hold" });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect(k.body.impact).toBeDefined();
    const floor = await w.call("p-asha", "GET", "/api/v1/projects/payments/floor");
    expect(floor.body.stop).toMatchObject({ mode: "kill", scope: "factory" });
    expect(floor.body.stops.length).toBe(2);
    // resume the project halt: the factory kill still refuses submissions
    expect((await lift("p-meera", "project:payments")).status).toBe(200);
    const sub = await w.submit("p-tomas", { title: "Refused by the factory kill" });
    expect(sub.status).toBe(409);
    expect(sub.body.msg).toMatch(/killed|refused/i);
    // an inner halt set under the kill survives restoring the outer one
    expect((await stop("p-meera", { scope: "repo", id: "payments-api", mode: "halt", reason: "Repo needs a look" })).status).toBe(200);
    const first = await restore("p-asha", "factory:");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.pending).toBe(true);
    expect((await active()).some((s) => s.scope_type === "factory")).toBe(true);
    expect((await restore("p-asha", "factory:")).status).toBe(409);
    const second = await restore("p-omar", "factory:");
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.pending).toBe(false);
    const left = await active();
    expect(left.map((s) => `${s.scope_type}:${s.mode}`)).toEqual(["repo:halt"]);
    expect((await w.submit("p-tomas", { title: "Still refused by the repo halt" })).status).toBe(409);
    expect((await lift("p-meera", "repo:payments-api")).status).toBe(200);
    for (const row of (await w.q(`select id from stops`)).map((r) => r.id)) await reconcile(row);
    expect((await w.submit("p-tomas", { title: "Accepted again" })).status).toBe(200);
  });

  it("kill (hold) at project scope: attempts cancelled, slots released, work held; restore re-validates and re-queues", async () => {
    const id = await w.atStation("research", "Held by a kill");
    const att = (await w.liveAttempt(id))!;
    const wrong = await stop("p-asha", { scope: "project", id: "payments", mode: "kill", reason: "Bad release suspected", confirmText: "payments" });
    expect(wrong.status).toBe(422);
    const name = (await w.q(`select name from projects where id = 'payments'`))[0].name as string;
    const k = await stop("p-asha", { scope: "project", id: "payments", mode: "kill", reason: "Bad release suspected", confirmText: name, inFlight: "hold" });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect(await reconcile(String(k.body.stop))).toMatchObject({ action: "enforced" });
    const held = await w.q(`select data, state from work_orders where id = $1`, [id]);
    expect(held[0].data.heldByKill).toBe("project");
    expect(held[0].state).toBe("running");
    expect(await w.liveAttempt(id)).toBeUndefined();
    expect(await w.apply(att)).toMatchObject({ applied: false });
    // every command on the work order is refused with the reason (409, audited)
    const refused = await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/park`, { bay: "hold", reason: "Parking while killed" });
    expect(refused.status).toBe(409);
    expect(refused.body.msg).toMatch(/killed/);
    expect((await w.q(`select count(*)::int n from slots where wo_id = $1 and state = 'held'`, [id]))[0].n).toBe(0);
    expect((await restore("p-asha", "project:payments")).status).toBe(200);
    expect(await reconcile(String(k.body.stop))).toMatchObject({ action: "restored" });
    const back = await w.liveAttempt(id);
    expect(back?.station).toBe("research");
    expect((await w.q(`select data from work_orders where id = $1`, [id]))[0].data.heldByKill).toBeUndefined();
  });

  it("kill (cancel) of one work order moves it to Killed; restore returns it to a fresh attempt at its last station; a parent's stop covers its children", async () => {
    const id = await w.atStation("research", "Killed alone");
    const k = await stop("p-meera", { scope: "workorder", id, mode: "kill", reason: "Requested by mistake" });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect(k.body.inFlight).toBe("cancel");
    await reconcile(String(k.body.stop));
    const wo = await w.get(id);
    expect(wo.state).toBe("killed");
    expect(wo.killed).toMatchObject({ reason: "Requested by mistake", prev: { state: "running" } });
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/${id}/retry`, {})).status).toBe(409);
    expect((await restore("p-meera", `workorder:${id}`)).status).toBe(403);
    expect((await w.events("restore.workorder.denied")).length).toBe(1);
    const r = await restore("p-daniel", `workorder:${id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await reconcile(String(k.body.stop))).action).toBe("restored");
    const back = await w.get(id);
    expect(back.state).toBe("running");
    expect((await w.liveAttempt(id))?.station).toBe("research");
    // a child is covered by its parent's stop
    await w.insertWo("WO-9201", { position: "build", state: "running" });
    await w.insertWo("WO-9202", { position: "build", state: "running" });
    await t.db.admin.query(`update work_orders set parent_id = 'WO-9201' where id = 'WO-9202'`);
    expect((await stop("p-meera", { scope: "workorder", id: "WO-9201", mode: "halt", reason: "Epic on hold" })).status).toBe(200);
    // a halt blocks gate progression and moves, not parking
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9202/move`, { target: "hold", reason: "Moving the child" })).status).toBe(409);
    expect((await lift("p-meera", "workorder:WO-9201")).status).toBe(200);
    const pk = await stop("p-meera", { scope: "workorder", id: "WO-9201", mode: "kill", reason: "Epic cancelled" });
    expect(pk.status, JSON.stringify(pk.body)).toBe(200);
    const child = await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9202/park`, { bay: "hold", reason: "Parking the child" });
    expect(child.status).toBe(409);
    expect(child.body.msg).toMatch(/killed/);
    const rr = await restore("p-daniel", "workorder:WO-9201");
    expect(rr.status, JSON.stringify(rr.body)).toBe(200);
    expect((await w.call("p-meera", "POST", `/api/v1/work-orders/WO-9202/park`, { bay: "hold", reason: "Parking the child" })).status).toBe(200);
  });

  it("a stop still succeeds when the jobs table is unhealthy; the reaper finds the unenforced stop", async () => {
    await t.db.admin.query(`alter table jobs rename to jobs_broken`);
    let res;
    try {
      res = await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "Jobs table is down" });
    } finally {
      await t.db.admin.query(`alter table jobs_broken rename to jobs`);
    }
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.enforcement).toBe("pending");
    expect((await active()).some((s) => s.scope_type === "project")).toBe(true);
    const pend = await pendingStops(t.db.app, { olderThanMs: 0 });
    expect(pend.map((p) => p.id)).toContain(String(res.body.stop));
    expect((await reconcile(String(res.body.stop))).action).toBe("enforced");
    expect((await pendingStops(t.db.app, { olderThanMs: 0 })).map((p) => p.id)).not.toContain(String(res.body.stop));
    expect((await lift("p-meera", "project:payments")).status).toBe(200);
    // the enforce job is enqueued once the table is back
    const ok = await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "Jobs table is back" });
    expect(ok.body.enforcement).toBe("queued");
    expect((await w.q(`select kind, queue, payload from jobs where kind = 'stop.enforce' and payload->>'stopId' = $1`, [String(ok.body.stop)]))[0]).toMatchObject({ queue: "stop", payload: { mode: "halt", scope: "project", targetId: "payments" } });
    await lift("p-meera", "project:payments");
  });

  it("I7 / spec 8.5: halt and kill still work when the flow engine's tables are unavailable", async () => {
    const broken = ["work_orders", "attempts", "runs", "slots", "gate_instances", "gate_votes", "conversations", "station_results", "flow_versions", "approver_rules", "notification_routes", "budgets", "repo_config", "jobs", "timers", "outbox"];
    for (const tb of broken) await t.db.admin.query(`alter table ${tb} rename to ${tb}_broken`);
    const name = (await w.q(`select name from projects where id = 'payments'`))[0].name as string;
    let h, k, r;
    try {
      h = await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "Flow engine is down" });
      k = await stop("p-asha", { scope: "project", id: "payments", mode: "kill", reason: "Flow engine is down", inFlight: "hold", confirmText: name });
      r = await lift("p-meera", "project:payments");
    } finally {
      for (const tb of broken) await t.db.admin.query(`alter table ${tb}_broken rename to ${tb}`);
    }
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await restore("p-asha", "project:payments")).status).toBe(200);
  });

  it("I7 / spec 8.5 break-glass: stops decide from the last-known-good snapshot when policy tables are unreadable, and say so", async () => {
    // any successful policy load refreshes the snapshot
    expect((await w.call("p-asha", "GET", "/api/v1/stops")).status).toBe(200);
    expect((await w.q(`select count(*)::int as n from stop_policy_snapshot`))[0].n).toBe(1);
    const broken = ["role_assignments", "role_matrix_versions", "policies", "freezes", "roles", "team_members", "projects", "repos"];
    const name = (await w.q(`select name from projects where id = 'payments'`))[0].name as string;
    for (const tb of broken) await t.db.admin.query(`alter table ${tb} rename to ${tb}_broken`);
    let h, k, denied, r, wo;
    try {
      h = await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "Policy store is down" });
      denied = await stop("p-rui", { scope: "project", id: "payments", mode: "kill", reason: "Policy store is down", confirmText: name });
      k = await stop("p-asha", { scope: "project", id: "payments", mode: "kill", reason: "Policy store is down", inFlight: "hold", confirmText: name });
      wo = await stop("p-asha", { scope: "workorder", id: "WO-9001", mode: "kill", reason: "Policy store is down" });
      r = await lift("p-meera", "project:payments");
    } finally {
      for (const tb of broken) await t.db.admin.query(`alter table ${tb}_broken rename to ${tb}`);
    }
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(h.body.policyFallback).toBe(true);
    expect(denied.status).toBe(403);
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect(wo.status, JSON.stringify(wo.body)).toBe(200);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.policyFallback).toBe(true);
    const ev = (await w.q(`select rule, after from events where type = 'halt' order by seq desc limit 1`))[0];
    expect(ev.rule).toBe("I7-SNAPSHOT");
    expect(ev.after.policyFallback).toMatchObject({ snapshotAt: expect.any(String) });
    expect((await w.events("kill.project.denied")).length).toBeGreaterThan(0);
    // healthy again: normal decisions, no fallback marker
    expect((await restore("p-asha", "project:payments")).status).toBe(200);
    expect((await restore("p-asha", "workorder:WO-9001")).status).toBe(200);
    const ok = await stop("p-meera", { scope: "project", id: "payments", mode: "halt", reason: "Back to normal now" });
    expect(ok.status).toBe(200);
    expect(ok.body.policyFallback).toBeUndefined();
    expect((await lift("p-meera", "project:payments")).status).toBe(200);
  });

  it("impact counts what a kill would touch", async () => {
    const r = await w.call("p-asha", "GET", "/api/v1/stops/impact?scope=project&id=payments");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ workOrders: expect.any(Number), running: expect.any(Number), slots: expect.any(Number), prs: 0 });
    expect(r.body.workOrders).toBeGreaterThan(0);
    expect((await w.call("p-tomas", "GET", "/api/v1/stops/impact?scope=project&id=payments")).status).toBe(403);
    const list = await w.call("p-asha", "GET", "/api/v1/stops");
    expect(list.status).toBe(200);
  });
});
