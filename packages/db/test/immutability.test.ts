import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, TEST_URL, type TestDb } from "./helpers.js";

const VERSIONED = [
  "flow_versions", "role_matrix_versions", "policy_versions", "approver_rule_versions", "agent_versions", "skill_versions",
  "instruction_versions", "guideline_versions", "routing_versions", "price_versions", "trust_criteria_versions", "security_settings",
];

describe.skipIf(!TEST_URL)("immutable versioned tables", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db.drop());

  it("every versioned table has the immutability trigger", async () => {
    const { rows } = await db.admin.query<{ t: string }>(`select c.relname t from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname like '%\\_immutable'`);
    expect(rows.map((r) => r.t).sort()).toEqual([...VERSIONED].sort());
  });

  it("a draft can change, publishing freezes it (update and delete rejected)", async () => {
    const o = db.orgId;
    await db.app.query(`insert into role_matrix_versions (org_id, version, matrix) values ($1, 1, '{"a":{"x":true}}')`, [o]);
    await db.app.query(`update role_matrix_versions set matrix = '{"a":{"x":false}}' where org_id = $1 and version = 1`, [o]);
    await db.app.query(`update role_matrix_versions set published_at = now(), published_by = 'u-ana' where org_id = $1 and version = 1`, [o]);
    await expect(db.app.query(`update role_matrix_versions set matrix = '{}' where org_id = $1 and version = 1`, [o])).rejects.toMatchObject({ code: "23000", message: expect.stringContaining("immutable") });
    await expect(db.app.query(`update role_matrix_versions set published_at = null where org_id = $1 and version = 1`, [o])).rejects.toMatchObject({ code: "23000" });
    await expect(db.app.query(`delete from role_matrix_versions where org_id = $1 and version = 1`, [o])).rejects.toMatchObject({ code: "23000" });
    // an unpublished draft may be deleted
    await db.app.query(`insert into role_matrix_versions (org_id, version, matrix) values ($1, 2, '{}')`, [o]);
    await db.app.query(`delete from role_matrix_versions where org_id = $1 and version = 2`, [o]);
    const { rows } = await db.app.query(`select matrix from role_matrix_versions where org_id = $1`, [o]);
    expect(rows).toEqual([{ matrix: { a: { x: false } } }]);
  });

  it("holds for a published flow version, composite keys included", async () => {
    const o = db.orgId;
    await db.app.query(`insert into projects (org_id, id, key, name) values ($1, 'p1', 'PAY', 'Payments')`, [o]);
    await db.app.query(`insert into flow_versions (org_id, project_id, version, doc, published_at) values ($1, 'p1', 1, '{"order":["intake"]}', now())`, [o]);
    await expect(db.app.query(`update flow_versions set doc = '{}' where org_id = $1`, [o])).rejects.toMatchObject({ code: "23000" });
    await db.app.query(`insert into flow_versions (org_id, project_id, version, doc, published_at) values ($1, 'p1', 2, '{"order":["intake","spec"]}', now())`, [o]);
    expect((await db.app.query(`select count(*)::int n from flow_versions`)).rows[0].n).toBe(2);
  });

  it("admin cannot bypass it either (owner rows are also frozen)", async () => {
    await expect(db.admin.query(`update flow_versions set note = 'edited'`)).rejects.toMatchObject({ code: "23000" });
  });

  it("gate decisions are append-only for the app role", async () => {
    const { rows } = await db.app.query(`select has_table_privilege('gantry_app','gate_decisions','update') u, has_table_privilege('gantry_app','gate_decisions','delete') d`);
    expect(rows[0]).toEqual({ u: false, d: false });
  });

  it("updated_at is maintained on mutable rows", async () => {
    await db.app.query(`insert into teams (org_id, id, name) values ($1, 't1', 'A')`, [db.orgId]);
    const before = (await db.app.query(`select updated_at from teams where id = 't1'`)).rows[0].updated_at as Date;
    await new Promise((r) => setTimeout(r, 15));
    await db.app.query(`update teams set name = 'B' where id = 't1'`);
    const after = (await db.app.query(`select updated_at from teams where id = 't1'`)).rows[0].updated_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("the app role cannot create objects or read migration bookkeeping", async () => {
    await expect(db.app.query(`create table evil (id int)`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.query(`select * from schema_migrations`)).rejects.toMatchObject({ code: "42501" });
  });
});
