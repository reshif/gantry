import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, hashBody, idempotent } from "../src/idempotency.js";
import { withTx } from "../src/tx.js";
import { createTestDb, TEST_URL, type TestDb } from "./helpers.js";

describe("canonical body hashing", () => {
  it("ignores key order and undefined, distinguishes values", () => {
    expect(hashBody({ a: 1, b: { c: [1, 2], d: undefined } })).toBe(hashBody({ b: { c: [1, 2] }, a: 1 }));
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: "1" }));
    expect(hashBody([1, 2])).not.toBe(hashBody([2, 1]));
    expect(canonicalJson({ b: 1, a: null })).toBe('{"a":null,"b":1}');
  });
});

describe.skipIf(!TEST_URL)("idempotency keys", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db.drop());

  const run = (key: string, body: unknown, counter: { n: number }) =>
    withTx(db.app, (tx) =>
      idempotent(tx, { orgId: db.orgId, scope: "u-ana:POST /work-orders", key, body }, async () => {
        counter.n += 1;
        return { status: 201, response: { id: `WO-${counter.n}` } };
      }),
    );

  it("same key and body returns the stored result without running again", async () => {
    const c = { n: 0 };
    const a = await run("k1", { title: "x", n: 1 }, c);
    const b = await run("k1", { n: 1, title: "x" }, c);
    expect(a).toEqual({ replayed: false, status: 201, response: { id: "WO-1" } });
    expect(b).toEqual({ replayed: true, status: 201, response: { id: "WO-1" } });
    expect(c.n).toBe(1);
  });

  it("same key with a different body is a conflict", async () => {
    const c = { n: 0 };
    await run("k2", { title: "x" }, c);
    expect(await run("k2", { title: "y" }, c)).toEqual({ conflict: true });
    expect(c.n).toBe(1);
  });

  it("keys are scoped per org and scope", async () => {
    const c = { n: 0 };
    await run("k3", { a: 1 }, c);
    const r = await withTx(db.app, (tx) => idempotent(tx, { orgId: db.orgId, scope: "other", key: "k3", body: { a: 2 } }, async () => ({ status: 200, response: 1 })));
    expect(r).toMatchObject({ replayed: false });
  });

  it("concurrent requests with one key run the command once", async () => {
    const c = { n: 0 };
    const results = await Promise.all(Array.from({ length: 8 }, () => run("k4", { same: true }, c)));
    expect(c.n).toBe(1);
    expect(results.filter((r) => "replayed" in r && !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify((r as { response: unknown }).response))).size).toBe(1);
  });

  it("a rolled-back first attempt releases the key", async () => {
    const c = { n: 0 };
    await expect(
      withTx(db.app, async (tx) => {
        await idempotent(tx, { orgId: db.orgId, scope: "u-ana:POST /work-orders", key: "k5", body: { a: 1 } }, async () => ({ status: 201, response: 1 }));
        throw new Error("later failure");
      }),
    ).rejects.toThrow("later failure");
    expect(await run("k5", { a: 2 }, c)).toMatchObject({ replayed: false });
  });
});
