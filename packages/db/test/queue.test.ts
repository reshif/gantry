import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { claim, complete, enqueue, fail, heartbeat } from "../src/jobs.js";
import { claimOutbox, enqueueOutbox, markDelivered, markFailed } from "../src/outbox.js";
import { cancel, fireDue, nextFireAt, schedule } from "../src/timers.js";
import { withTx } from "../src/tx.js";
import { createTestDb, TEST_URL, type TestDb } from "./helpers.js";

describe.skipIf(!TEST_URL)("jobs, timers, outbox", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db.drop());
  beforeEach(async () => {
    await db.admin.query(`delete from timers; delete from outbox; delete from jobs`);
  });

  it("SKIP LOCKED gives each job to exactly one of many concurrent workers", async () => {
    for (let i = 0; i < 30; i++) await enqueue(db.app, { orgId: db.orgId, kind: "k", payload: { i } });
    const claims = await Promise.all(Array.from({ length: 10 }, (_, w) => claim(db.app, { workerId: `w${w}`, leaseMs: 60_000, limit: 5 })));
    const ids = claims.flat().map((j) => j.id);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
    expect(await claim(db.app, { workerId: "late", leaseMs: 1000 })).toEqual([]);
  });

  it("two transactions holding locked rows never overlap", async () => {
    for (let i = 0; i < 4; i++) await enqueue(db.app, { orgId: db.orgId, kind: "k" });
    const a = await db.app.connect();
    const b = await db.app.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      const first = await a.query(`select id from jobs where status = 'queued' order by created_at for update skip locked limit 2`);
      const second = await b.query(`select id from jobs where status = 'queued' order by created_at for update skip locked limit 2`);
      const all = [...first.rows, ...second.rows].map((r) => r.id);
      expect(new Set(all).size).toBe(4);
    } finally {
      await a.query("rollback");
      await b.query("rollback");
      a.release();
      b.release();
    }
  });

  it("orders by priority then run_at, and honours run_at in the future", async () => {
    await enqueue(db.app, { orgId: db.orgId, kind: "low", priority: 0 });
    await enqueue(db.app, { orgId: db.orgId, kind: "high", priority: 10 });
    await enqueue(db.app, { orgId: db.orgId, kind: "later", priority: 99, runAt: new Date(Date.now() + 3_600_000) });
    const got = await claim(db.app, { workerId: "w", leaseMs: 1000, limit: 5 });
    expect(got.map((j) => j.kind)).toEqual(["high", "low"]);
  });

  it("filters by queue", async () => {
    await enqueue(db.app, { orgId: db.orgId, kind: "a", queue: "qa" });
    await enqueue(db.app, { orgId: db.orgId, kind: "b", queue: "qb" });
    expect((await claim(db.app, { workerId: "w", leaseMs: 1000, queues: ["qb"], limit: 5 })).map((j) => j.kind)).toEqual(["b"]);
  });

  it("dedupes while queued or running, and allows a new job after completion", async () => {
    const a = await enqueue(db.app, { orgId: db.orgId, kind: "k", dedupeKey: "wo-1:build" });
    const b = await enqueue(db.app, { orgId: db.orgId, kind: "k", dedupeKey: "wo-1:build" });
    expect(b).toEqual({ id: a.id, deduped: true });
    const [j] = await claim(db.app, { workerId: "w", leaseMs: 1000 });
    expect((await enqueue(db.app, { orgId: db.orgId, kind: "k", dedupeKey: "wo-1:build" })).deduped).toBe(true);
    expect(await complete(db.app, j!.id, "w", { ok: 1 })).toBe(true);
    const c = await enqueue(db.app, { orgId: db.orgId, kind: "k", dedupeKey: "wo-1:build" });
    expect(c.deduped).toBe(false);
    expect(c.id).not.toBe(a.id);
  });

  it("an expired lease is reclaimed by another worker, and the first worker can no longer complete", async () => {
    await enqueue(db.app, { orgId: db.orgId, kind: "k" });
    const [j1] = await claim(db.app, { workerId: "slow", leaseMs: 50 });
    expect(j1!.attempts).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    const [j2] = await claim(db.app, { workerId: "fast", leaseMs: 5000 });
    expect(j2!.id).toBe(j1!.id);
    expect(j2!.attempts).toBe(2);
    expect(await heartbeat(db.app, j1!.id, "slow", 1000)).toBe(false);
    expect(await complete(db.app, j1!.id, "slow")).toBe(false);
    expect(await fail(db.app, j1!.id, "slow", "x")).toEqual({ status: "lost" });
    expect(await heartbeat(db.app, j2!.id, "fast", 5000)).toBe(true);
    expect(await complete(db.app, j2!.id, "fast")).toBe(true);
  });

  it("a job that keeps losing its lease goes dead after max_attempts", async () => {
    await enqueue(db.app, { orgId: db.orgId, kind: "k", maxAttempts: 2 });
    await claim(db.app, { workerId: "a", leaseMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    await claim(db.app, { workerId: "b", leaseMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    expect(await claim(db.app, { workerId: "c", leaseMs: 20 })).toEqual([]);
    const { rows } = await db.admin.query(`select status, attempts from jobs`);
    expect(rows[0]).toEqual({ status: "dead", attempts: 2 });
  });

  it("fail backs off exponentially with jitter, then dies at max_attempts or when not retryable", async () => {
    await enqueue(db.app, { orgId: db.orgId, kind: "k", maxAttempts: 3 });
    const base = { baseMs: 10_000, maxMs: 60_000 };
    const [a1] = await claim(db.app, { workerId: "w", leaseMs: 1000 });
    const r1 = await fail(db.app, a1!.id, "w", "e1", { backoff: base });
    expect(r1.status).toBe("queued");
    const d1 = r1.status === "queued" ? r1.runAt.getTime() - Date.now() : 0;
    expect(d1).toBeGreaterThan(4_000);
    expect(d1).toBeLessThanOrEqual(10_100);
    expect(await claim(db.app, { workerId: "w", leaseMs: 1000 })).toEqual([]); // not due yet
    await db.admin.query(`update jobs set run_at = now()`);
    const [a2] = await claim(db.app, { workerId: "w", leaseMs: 1000 });
    const r2 = await fail(db.app, a2!.id, "w", "e2", { backoff: base });
    const d2 = r2.status === "queued" ? r2.runAt.getTime() - Date.now() : 0;
    expect(d2).toBeGreaterThan(9_000);
    expect(d2).toBeLessThanOrEqual(20_100);
    await db.admin.query(`update jobs set run_at = now()`);
    const [a3] = await claim(db.app, { workerId: "w", leaseMs: 1000 });
    expect(await fail(db.app, a3!.id, "w", "e3", { backoff: base })).toEqual({ status: "dead" });

    await enqueue(db.app, { orgId: db.orgId, kind: "k2" });
    const [b1] = await claim(db.app, { workerId: "w", leaseMs: 1000 });
    expect(await fail(db.app, b1!.id, "w", "permanent", { retry: false })).toEqual({ status: "dead" });
    const { rows } = await db.admin.query(`select last_error from jobs where id = $1`, [b1!.id]);
    expect(rows[0].last_error).toBe("permanent");
  });

  describe("timers", () => {
    it("fires due timers into jobs exactly once across concurrent workers", async () => {
      for (let i = 0; i < 12; i++) await schedule(db.app, { orgId: db.orgId, kind: "gate.escalate", fireAt: new Date(Date.now() - 1000), subject: `WO-${i}`, payload: { n: i } });
      await schedule(db.app, { orgId: db.orgId, kind: "future", fireAt: new Date(Date.now() + 3_600_000) });
      const counts = await Promise.all(Array.from({ length: 5 }, () => withTx(db.app, (tx) => fireDue(tx, 4))));
      const rest = await withTx(db.app, (tx) => fireDue(tx));
      expect(counts.reduce((a, b) => a + b, 0) + rest).toBe(12);
      const { rows } = await db.admin.query(`select count(*)::int n, count(distinct (payload->>'timerId'))::int d from jobs where queue = 'timers'`);
      expect(rows[0]).toEqual({ n: 12, d: 12 });
      expect((await db.admin.query(`select count(*)::int n from timers where status = 'pending'`)).rows[0].n).toBe(1);
      expect((await nextFireAt(db.app))!.getTime()).toBeGreaterThan(Date.now());
    });

    it("dedupes pending timers by key, and cancels by id, key or subject", async () => {
      const a = await schedule(db.app, { orgId: db.orgId, kind: "k", fireAt: new Date(Date.now() + 1000), dedupeKey: "d" });
      const b = await schedule(db.app, { orgId: db.orgId, kind: "k", fireAt: new Date(Date.now() + 2000), dedupeKey: "d" });
      expect(b).toEqual({ id: a.id, created: false });
      expect(await cancel(db.app, { orgId: db.orgId, dedupeKey: "d" })).toBe(1);
      expect(await cancel(db.app, { id: a.id })).toBe(0);
      const c = await schedule(db.app, { orgId: db.orgId, kind: "k", fireAt: new Date(Date.now() + 1000), dedupeKey: "d" });
      expect(c.created).toBe(true);
      await schedule(db.app, { orgId: db.orgId, kind: "esc", fireAt: new Date(Date.now() + 1000), subject: "WO-1" });
      expect(await cancel(db.app, { orgId: db.orgId, subject: "WO-1", kind: "esc" })).toBe(1);
      expect(await cancel(db.app, { id: c.id })).toBe(1);
    });
  });

  describe("outbox", () => {
    async function event() {
      return withTx(db.app, (tx) => appendEvent(tx, { orgId: db.orgId, type: "gate.waiting", category: "approvals", actor: "system", channel: "system" }));
    }

    it("is unique per event and destination", async () => {
      const e = await event();
      const a = await enqueueOutbox(db.app, { orgId: db.orgId, eventId: e.id, destination: "slack", payload: { x: 1 } });
      const b = await enqueueOutbox(db.app, { orgId: db.orgId, eventId: e.id, destination: "slack" });
      const c = await enqueueOutbox(db.app, { orgId: db.orgId, eventId: e.id, destination: "webhook" });
      expect(b).toEqual({ id: a.id, created: false });
      expect(c.created).toBe(true);
    });

    it("drops an invite's one-time link once the row is delivered or dead, and keeps it while it may still be retried", async () => {
      const e = await event();
      const payload = { kind: "invite", to: "a@b.c", link: "https://x/auth/login?invite=SECRETTOKEN", token: "SECRETTOKEN" };
      const a = await enqueueOutbox(db.app, { orgId: db.orgId, eventId: e.id, destination: "smtp", payload });
      const e2 = await event();
      const b = await enqueueOutbox(db.app, { orgId: db.orgId, eventId: e2.id, destination: "smtp", payload, maxAttempts: 1 });
      const got = await claimOutbox(db.app, { workerId: "scrub", leaseMs: 1000, destinations: ["smtp"] });
      expect(got).toHaveLength(2);
      expect(got.find((x) => x.id === a.id)!.payload).toMatchObject({ link: payload.link });
      expect(await markDelivered(db.app, a.id, "scrub")).toBe(true);
      expect(await markFailed(db.app, b.id, "scrub", "550")).toBe("dead");
      for (const id of [a.id, b.id]) {
        const row = (await db.admin.query(`select payload from outbox where id = $1`, [id])).rows[0].payload;
        expect(JSON.stringify(row)).not.toContain("SECRETTOKEN");
        expect(row).toMatchObject({ kind: "invite", to: "a@b.c" });
      }
    });

    it("claims, delivers, retries with backoff and dies", async () => {
      const e = await event();
      await enqueueOutbox(db.app, { orgId: db.orgId, eventId: e.id, destination: "slack", maxAttempts: 2 });
      await enqueueOutbox(db.app, { orgId: db.orgId, eventId: e.id, destination: "email" });
      const claimed = await Promise.all([claimOutbox(db.app, { workerId: "a", leaseMs: 1000 }), claimOutbox(db.app, { workerId: "b", leaseMs: 1000 })]);
      expect(claimed.flat().map((x) => x.destination).sort()).toEqual(["email", "slack"]);
      const slack = claimed.flat().find((x) => x.destination === "slack")!;
      const email = claimed.flat().find((x) => x.destination === "email")!;
      const owner = (x: typeof slack) => (claimed[0]!.includes(x) ? "a" : "b");
      expect(await markDelivered(db.app, email.id, owner(email))).toBe(true);
      expect(await markDelivered(db.app, email.id, owner(email))).toBe(false);
      expect(await markFailed(db.app, slack.id, owner(slack), "503", { baseMs: 10_000, maxMs: 10_000 })).toBe("pending");
      expect(await claimOutbox(db.app, { workerId: "a", leaseMs: 1000 })).toEqual([]);
      await db.admin.query(`update outbox set next_attempt_at = now() where id = $1`, [slack.id]);
      const [again] = await claimOutbox(db.app, { workerId: "a", leaseMs: 1000, destinations: ["slack"] });
      expect(again!.attempts).toBe(2);
      expect(await markFailed(db.app, again!.id, "a", "503")).toBe("dead");
    });
  });
});
