import { enqueue, claim, schedule } from "@gantry/db";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermanentError, TransientError } from "../src/errors.js";
import { JobRunner } from "../src/runner.js";
import { Scheduler } from "../src/scheduler.js";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("job runner", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });
  const add = (kind: string, o: { maxAttempts?: number; queue?: string } = {}) => enqueue(w.db.app, { orgId: w.orgId, queue: o.queue ?? "flow", kind, payload: {}, ...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}) });

  it("retries a failing job with backoff, kills it after its attempts, and never retries a permanent failure", async () => {
    let calls = 0;
    const r = new JobRunner(w.deps, {
      flaky: async () => { calls++; throw new TransientError("down"); },
      bad: async () => { throw new PermanentError("nope"); },
    }, { queues: { flow: 2 } });
    const a = await add("flaky", { maxAttempts: 2 });
    const b = await add("bad");
    await r.drain();
    let rows = await w.q(`select id, status, attempts, run_at > now() as later, last_error from jobs order by kind`);
    expect(rows.find((x) => x.id === b.id)).toMatchObject({ status: "dead", attempts: 1, last_error: "nope" });
    expect(rows.find((x) => x.id === a.id)).toMatchObject({ status: "queued", attempts: 1, later: true });
    await w.q(`update jobs set run_at = now()`);
    await r.drain();
    rows = await w.q(`select id, status, attempts from jobs where id = $1`, [a.id]);
    expect(rows[0]).toMatchObject({ status: "dead", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("honours per-queue concurrency", async () => {
    let live = 0;
    let max = 0;
    const r = new JobRunner(w.deps, { slow: async () => { live++; max = Math.max(max, live); await sleep(80); live--; } }, { queues: { flow: 2, github: 1 } });
    for (let i = 0; i < 6; i++) await add("slow");
    await r.drain();
    expect(max).toBe(2);
    expect((await w.q(`select count(*)::int as n from jobs where status = 'done'`))[0].n).toBe(6);
  });

  it("a job whose worker died is reclaimed once its lease expires, and runs again", async () => {
    const j = await add("once");
    const [claimed] = await claim(w.db.app, { workerId: "dead-worker", leaseMs: 50, queues: ["flow"] });
    expect(claimed!.id).toBe(j.id);
    await sleep(120);
    let ran = 0;
    const r = new JobRunner(w.deps, { once: async () => { ran++; } }, { queues: { flow: 1 } });
    await r.drain();
    expect(ran).toBe(1);
    expect((await w.q(`select status, attempts from jobs where id = $1`, [j.id]))[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  it("shuts down gracefully: it stops claiming and waits for the job in flight", async () => {
    let finished = false;
    const r = new JobRunner(w.deps, { slow: async () => { await sleep(300); finished = true; } }, { queues: { flow: 1 } });
    await add("slow");
    await add("slow");
    r.start();
    for (let i = 0; i < 50 && !(await w.q(`select 1 from jobs where status = 'running'`)).length; i++) await sleep(20);
    await r.stop(5_000);
    expect(finished).toBe(true);
    const rows = await w.q(`select status from jobs order by created_at`);
    expect(rows.map((x) => x.status)).toEqual(["done", "queued"]);
  });

  it("an unknown job kind is dead-lettered, not retried forever", async () => {
    const r = new JobRunner(w.deps, {}, { queues: { flow: 1 } });
    await add("mystery");
    await r.drain();
    expect((await w.q(`select status, last_error from jobs`))[0]).toMatchObject({ status: "dead", last_error: expect.stringContaining("no handler") });
  });
});

d("timers (F7)", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  async function gateWaiting(id: string) {
    await w.q(
      `insert into work_orders (org_id, id, project_id, repo_id, title, class, priority, position, state, flow_version, submitter, risk, sla_due_at, data)
       values ($1,$2,'payments','payments-api','Waiting','feature','P2','review','waiting',(select current_flow_version from projects where org_id = $1 and id = 'payments'),'p-tomas','normal', now() + interval '3 days', '{"history":[],"log":[]}'::jsonb)`, [w.orgId, id]);
    await w.q(`insert into gate_instances (org_id, id, wo_id, gate_id, station, status, flow_version, basis, opened_at) values ($1,$2,$3,'G4','review','open',1,'{"required":1}'::jsonb, now() - interval '3 days')`, [w.orgId, `${id}:G4:1`, id]);
    return `${id}:G4:1`;
  }

  it("a timer that came due while the worker was down fires on recovery, exactly once, even with two workers", async () => {
    const inst = await gateWaiting("WO-9501");
    await schedule(w.db.app, { orgId: w.orgId, kind: "flow.timer", fireAt: new Date(Date.now() - 2 * 3600_000), subject: inst, payload: { kind: "escalation", woId: "WO-9501", gateInstanceId: inst }, dedupeKey: `escalation:${inst}` });
    // Nobody is running: the escalation deadline passes. Recovery: two workers start together.
    expect((await w.q(`select count(*)::int as n from events where type = 'gate.escalated'`))[0].n).toBe(0);
    const other = new JobRunner({ ...w.deps, workerId: "worker-b" }, (await import("../src/worker.js")).HANDLERS, { queues: w.deps.cfg.concurrency });
    await Promise.all([w.worker.runner.drain(), other.drain()]);
    expect((await w.q(`select count(*)::int as n from events where type = 'gate.escalated'`))[0].n).toBe(1);
    expect((await w.q(`select status from timers`))[0].status).toBe("fired");
    expect((await w.q(`select count(*)::int as n from jobs where kind = 'flow.timer'`))[0].n).toBe(1);
  });

  it("an escalation timer is paused by a halt and pushed back, not lost", async () => {
    const inst = await gateWaiting("WO-9502");
    await w.q(`insert into stops (org_id, id, scope_type, wo_id, mode, reason, set_by) values ($1,'wo:WO-9502:1','wo','WO-9502','halt','x','p-asha')`, [w.orgId]);
    await schedule(w.db.app, { orgId: w.orgId, kind: "flow.timer", fireAt: new Date(Date.now() - 1000), subject: inst, payload: { kind: "escalation", woId: "WO-9502", gateInstanceId: inst }, dedupeKey: `escalation:${inst}` });
    await w.worker.runner.drain();
    expect((await w.q(`select count(*)::int as n from events where type = 'gate.escalated'`))[0].n).toBe(0);
    expect((await w.q(`select count(*)::int as n from timers where status = 'pending'`))[0].n).toBe(1);
  });
});

d("scheduler, reaper and verifier", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  it("enqueues the recurring jobs once per interval however many workers tick", async () => {
    await w.q(`update repos set github_full_name = 'acme/payments-api' where org_id = $1 and id = 'payments-api'`, [w.orgId]);
    const nRepos = (await w.q(`select count(*)::int as n from repos where github_full_name is not null or name like '%/%'`))[0].n;
    expect(nRepos).toBeGreaterThanOrEqual(1);
    const s2 = new Scheduler({ ...w.deps, workerId: "b" });
    const [a, b] = await Promise.all([w.worker.scheduler.tick(), s2.tick()]);
    // Two recurring jobs per org, a reconcile per repo with a GitHub name, and (spec 11.3) an onboarding sync for the one Ready repo that has a GitHub identity of its own.
    expect(a + b).toBe(2 + nRepos + 1);
    const kinds = (await w.q(`select kind, count(*)::int as n from jobs group by kind order by kind`)).map((j) => `${j.kind}:${j.n}`);
    expect(kinds).toEqual(["chain.verify:1", `github.reconcile:${nRepos}`, "onboarding.sync:1", "reaper.sweep:1"]);
    expect(await w.worker.scheduler.tick()).toBe(0);
    // Even after the jobs have run, the same interval does not enqueue again.
    await w.worker.runner.drain();
    expect(await w.worker.scheduler.tick()).toBe(0);
    expect(w.broker.calls.filter((c) => c.op === "reconcile").map((c) => c.body!.repo)).toContain("acme/payments-api");
    expect(w.broker.calls.find((c) => c.op === "reconcile")!.body!.branchPrefix).toBe("gantry/");
  });

  it("removes runners, networks and volumes without a live lease and keeps the live one", async () => {
    const live = await w.workOrderAt("WO-9601", { station: "research", repo: null });
    const ended = await w.workOrderAt("WO-9602", { station: "research", repo: null });
    await w.drain();
    w.launcher.addOrphan("r-crashed-before-any-row");
    await w.q(`update attempts set state = 'failed' where id = $1`, [ended.attemptId]);
    await w.enqueue("reaper.sweep", {});
    await w.drain();
    expect([...w.launcher.runs.keys()]).toEqual([live.runId]);
    expect((await w.q(`select state from runs where id = $1`, [ended.runId]))[0].state).toBe("reaped");
    expect((await w.jobs("reaper.sweep"))[0]!.result.orphansRemoved.sort()).toEqual([ended.runId, "r-crashed-before-any-row"].sort());
    // The live run's lease then lapses: expiry (F9) runs first, so the attempt is retried and the old runner is removed.
    await w.q(`update attempts set lease_until = now() - interval '1 hour' where id = $1`, [live.attemptId]);
    await w.enqueue("reaper.sweep", {}, { dedupeKey: "second" });
    await w.drain();
    expect(w.launcher.runs.has(live.runId)).toBe(false);
  });

  it("chain.verify is quiet on a sound ledger and raises an alert event on a break", async () => {
    await w.q(`insert into events (org_id, type, category, actor, channel) values ($1,'seed.a','flow','system','system'), ($1,'seed.b','flow','system','system')`, [w.orgId]);
    await w.enqueue("chain.verify", {});
    await w.drain();
    expect((await w.jobs("chain.verify"))[0]!.result.ok).toBe(true);
    expect((await w.q(`select count(*)::int as n from events where type = 'ledger.chain_broken'`))[0].n).toBe(0);
    const victim = (await w.q(`select id from events order by seq limit 1`))[0].id;
    await w.q(`alter table events disable trigger events_no_update_delete`);
    await w.q(`update events set type = 'tampered' where id = $1`, [victim]);
    await w.q(`alter table events enable trigger events_no_update_delete`);
    await w.enqueue("chain.verify", {}, { dedupeKey: "second" });
    await w.drain();
    const job = (await w.jobs("chain.verify"))[1]!;
    expect(job.result.ok).toBe(false);
    const alert = (await w.q(`select outcome, category, after from events where type = 'ledger.chain_broken'`));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ outcome: "failed", category: "config" });
  });
});

d("worker process loops", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  it("start() runs the loops end to end: a queued dispatch becomes a running container, and stop() is graceful", async () => {
    await w.workOrderAt("WO-9701", { station: "research", repo: null });
    await w.worker.start();
    for (let i = 0; i < 100 && w.launcher.runs.size === 0; i++) await sleep(50);
    expect(w.launcher.runs.size).toBe(1);
    expect(existsSync(w.deps.cfg.heartbeatFile)).toBe(true);
    // The scheduler also ran: a sweep job exists for the org.
    for (let i = 0; i < 100 && !(await w.jobs("reaper.sweep")).length; i++) await sleep(50);
    expect((await w.jobs("reaper.sweep")).length).toBe(1);
    await w.worker.stop(5_000);
    expect((await w.q(`select count(*)::int as n from jobs where status = 'running'`))[0].n).toBe(0);
  });
});
