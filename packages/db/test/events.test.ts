import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvent, verifyChain, type EventInput } from "../src/events.js";
import { withTx } from "../src/tx.js";
import { createTestDb, TEST_URL, type TestDb } from "./helpers.js";

const ev = (orgId: string, n: number): EventInput => ({
  orgId, type: "wo.submitted", category: "flow", actor: "u-ana", channel: "web", subject: { type: "wo", id: `WO-${n}` },
  projectId: "p1", woId: `WO-${n}`, woVersion: 1, after: { title: `t${n}` }, sourceIp: "10.0.0.7", requestId: `r${n}`,
});

describe.skipIf(!TEST_URL)("events", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db.drop());

  it("appends through the app role with seq starting at 1, and verifies", async () => {
    const a = await withTx(db.app, (tx) => appendEvent(tx, ev(db.orgId, 1)));
    const b = await withTx(db.app, (tx) => appendEvent(tx, ev(db.orgId, 2)));
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(a.prevHash).toBe("0".repeat(64));
    expect(b.prevHash).toBe(a.hash);
    expect(await verifyChain(db.app, db.orgId)).toEqual({ ok: true, value: { count: 2, headSeq: 2, headHash: b.hash } });
  });

  it("ignores caller-supplied seq and hashes", async () => {
    const r = await db.app.query(
      `insert into events (org_id, seq, type, category, actor, channel, prev_hash, hash) values ($1, 999, 'x.y', 'flow', 'a', 'system', repeat('a', 64), repeat('b', 64)) returning seq, prev_hash`,
      [db.orgId],
    );
    expect(Number(r.rows[0].seq)).toBe(3);
    expect(r.rows[0].prev_hash).not.toBe("a".repeat(64));
    expect((await verifyChain(db.app, db.orgId)).ok).toBe(true);
  });

  it("gantry_app cannot UPDATE, DELETE or TRUNCATE events, nor touch the counter", async () => {
    await expect(db.app.query(`update events set actor = 'evil'`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.query(`delete from events`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.query(`truncate events`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.query(`select * from event_counters`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.query(`update event_counters set last_seq = 0`)).rejects.toMatchObject({ code: "42501" });
    const { rows } = await db.app.query(`select has_table_privilege('gantry_app','events','update') u, has_table_privilege('gantry_app','events','delete') d, has_table_privilege('gantry_app','events','truncate') t, has_table_privilege('gantry_app','events','insert') i, has_table_privilege('gantry_app','events','select') s`);
    expect(rows[0]).toEqual({ u: false, d: false, t: false, i: true, s: true });
  });

  it("the trigger also blocks the owner until it is disabled (tamper requires a deliberate act)", async () => {
    await expect(db.admin.query(`update events set actor = 'evil' where seq = 1`)).rejects.toMatchObject({ code: "42501" });
  });

  it("a rolled-back append leaves no gap", async () => {
    await expect(withTx(db.app, async (tx) => { await appendEvent(tx, ev(db.orgId, 50)); throw new Error("boom"); })).rejects.toThrow("boom");
    const e = await withTx(db.app, (tx) => appendEvent(tx, ev(db.orgId, 51)));
    expect(e.seq).toBe(4);
    expect((await verifyChain(db.app, db.orgId)).ok).toBe(true);
  });

  it("seq is gapless and chained under 20 concurrent appends", async () => {
    const org2 = (await db.admin.query<{ id: string }>(`insert into orgs (slug, name) values ('c', 'Concurrent') returning id`)).rows[0]!.id;
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => withTx(db.app, (tx) => appendEvent(tx, ev(org2, i)))));
    expect(out.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const r = await verifyChain(db.app, org2);
    expect(r).toMatchObject({ ok: true, value: { count: 20, headSeq: 20 } });
    // other orgs are unaffected: separate counters
    const o = await withTx(db.app, (tx) => appendEvent(tx, ev(db.orgId, 99)));
    expect(o.seq).toBe(5);
  });

  describe("tamper detection (edits made as owner with the trigger disabled)", () => {
    async function tamper(sql: string) {
      const c = await db.admin.connect();
      try {
        await c.query(`alter table events disable trigger events_no_update_delete`);
        await c.query(sql);
      } finally {
        await c.query(`alter table events enable trigger events_no_update_delete`).catch(() => undefined);
        c.release();
      }
    }
    async function freshOrg(slug: string, n: number) {
      const id = (await db.admin.query<{ id: string }>(`insert into orgs (slug, name) values ($1, $1) returning id`, [slug])).rows[0]!.id;
      for (let i = 1; i <= n; i++) await withTx(db.app, (tx) => appendEvent(tx, ev(id, i)));
      return id;
    }

    it("reports hash_mismatch at the edited row", async () => {
      const id = await freshOrg("tamper-edit", 5);
      expect((await verifyChain(db.app, id)).ok).toBe(true);
      await tamper(`update events set after = '{"title":"forged"}' where org_id = '${id}' and seq = 3`);
      expect(await verifyChain(db.app, id)).toEqual({ ok: false, error: { kind: "hash_mismatch", seq: 3 } });
    });

    it("reports a prev_hash break when an edited row's hash was recomputed", async () => {
      const id = await freshOrg("tamper-rehash", 4);
      await tamper(`update events set after = '{"x":1}' where org_id = '${id}' and seq = 2; update events e set hash = gantry_event_hash(e) where org_id = '${id}' and seq = 2`);
      expect(await verifyChain(db.app, id)).toEqual({ ok: false, error: { kind: "prev_hash_mismatch", seq: 3 } });
    });

    it("reports seq_gap when a middle row is deleted", async () => {
      const id = await freshOrg("tamper-del", 5);
      await tamper(`delete from events where org_id = '${id}' and seq = 2`);
      expect(await verifyChain(db.app, id)).toEqual({ ok: false, error: { kind: "seq_gap", seq: 3, expected: 2 } });
    });

    it("reports tail_mismatch when the newest rows are removed", async () => {
      const id = await freshOrg("tamper-tail", 4);
      await tamper(`delete from events where org_id = '${id}' and seq = 4`);
      expect(await verifyChain(db.app, id)).toEqual({ ok: false, error: { kind: "tail_mismatch", seq: 3, detail: "counter_ahead_of_log" } });
    });

    it("an empty org verifies", async () => {
      const id = (await db.admin.query<{ id: string }>(`insert into orgs (slug, name) values ('empty', 'e') returning id`)).rows[0]!.id;
      expect(await verifyChain(db.app, id)).toEqual({ ok: true, value: { count: 0, headSeq: 0, headHash: "0".repeat(64) } });
    });
  });

  it("rejects values outside the spec's categories, channels and outcomes", async () => {
    await expect(withTx(db.app, (tx) => appendEvent(tx, { ...ev(db.orgId, 7), category: "nope" as never }))).rejects.toMatchObject({ code: "23514" });
    await expect(withTx(db.app, (tx) => appendEvent(tx, { ...ev(db.orgId, 7), channel: "fax" as never }))).rejects.toMatchObject({ code: "23514" });
  });
});
