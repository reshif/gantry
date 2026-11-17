/**
 * Owner decision 2026-11-17: factory-wide settings (Access, Security, System health, vendors, prices, budgets, routing) are for factory-level roles only.
 * A Project Admin gets 403 on each of them, however the matrix or the stored catalogue looks, and the matrix refuses to grant them to a project role.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyChain } from "@gantry/db";
import { defaultMatrix } from "@gantry/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { withVersion } from "./versions.js";

const d = TEST_URL ? describe : describe.skip;

const FACTORY_ENDPOINTS = ["/api/v1/access/matrix", "/api/v1/security", "/api/v1/system/health", "/api/v1/vendors", "/api/v1/prices", "/api/v1/budgets", "/api/v1/routing"] as const;
const READ_RIGHTS = ["people.view", "policy.view", "agents.view", "models.view", "integrations.view"] as const;
const PROJECT_ADMINS = ["p-daniel", "p-lena"]; // project_admin on payments/storefront and on identity
const FACTORY_READERS = ["p-asha", "p-sam"]; // factory_admin, auditor

d("factory-wide rights stay on factory-level roles", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  const get = async (who: string, url: string) => (await t.app.inject({ method: "GET", url, headers: (await t.session(who)).headers })).statusCode;
  const put = async (who: string, url: string, payload: object) => {
    const s = await t.session(who);
    const r = await t.app.inject({ method: "PUT", url, headers: { ...s.headers, ...(await withVersion(t.db.admin, "PUT", url, {})) }, payload });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };

  it("the default matrix gives no project-level role any factory-scope right", () => {
    const m = defaultMatrix();
    for (const role of ["project_admin", "line_lead", "engineer", "reviewer", "approver", "release_manager", "viewer"]) for (const a of [...READ_RIGHTS, "audit.view", "eval.run", "policy.edit", "kill.factory"]) expect(m[role]![a], `${role} ${a}`).toBe(false);
    for (const a of READ_RIGHTS) expect(m.auditor![a]).toBe(true);
  });

  it("project_admin gets 403 on every factory-wide endpoint; factory roles still get 200", async () => {
    for (const url of FACTORY_ENDPOINTS) {
      for (const who of PROJECT_ADMINS) expect(await get(who, url), `${who} ${url}`).toBe(403);
      for (const who of FACTORY_READERS) expect(await get(who, url), `${who} ${url}`).toBe(200);
    }
  });

  it("factory_manager and security_reviewer (read-only factory roles) get 200", async () => {
    for (const [who, role] of [["p-meera", "factory_manager"], ["p-priya", "security_reviewer"]] as const) {
      await t.db.admin.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, project_id, granted_by) values ($1, $2, $3, $4, 'factory', null, 'p-asha')`, [t.orgId, `ra-fo-${role}`, who, role]);
      for (const url of FACTORY_ENDPOINTS) expect(await get(who, url), `${role} ${url}`).toBe(200);
    }
  });

  it("the matrix API refuses to grant a factory-scope right to a project-level role, with a clear message, and publishes nothing", async () => {
    const before = (await t.db.admin.query(`select count(*)::int as n from role_matrix_versions`)).rows[0].n;
    for (const a of READ_RIGHTS) {
      const r = await put("p-asha", `/api/v1/access/matrix/project_admin/${a}`, { on: true });
      expect(r.status, a).toBe(403);
      expect(r.body.msg, a).toMatch(/project-level role.*factory-wide right.*factory-level roles only/s);
    }
    expect((await put("p-asha", "/api/v1/access/matrix/line_lead/kill.factory", { on: true })).status).toBe(403);
    expect((await t.db.admin.query(`select count(*)::int as n from role_matrix_versions`)).rows[0].n).toBe(before);
    // a project-scope right is still grantable, and a factory-scope right can still go to a factory-level role
    expect((await put("p-asha", "/api/v1/access/matrix/viewer/wo.submit", { on: true })).status).toBe(200);
    expect((await put("p-asha", "/api/v1/access/matrix/security_reviewer/people.view", { on: false })).status).toBe(200);
  });

  it("a stored grant is ignored by resolution, and the migration removes it and writes the ledger", async () => {
    // an org as the live one was: the Read rights stored with project scope, and project_admin holding them
    await t.db.admin.query(`update orgs set settings = jsonb_set(settings, '{catalog,actions}', (select jsonb_agg(case when a->>'id' = any($2) then jsonb_set(a, '{scope}', '"project"') else a end) from jsonb_array_elements(settings->'catalog'->'actions') a)) where id = $1`, [t.orgId, [...READ_RIGHTS]]);
    const cur = (await t.db.admin.query(`select version, matrix from role_matrix_versions where org_id = $1 order by version desc limit 1`, [t.orgId])).rows[0];
    const tampered = structuredClone(cur.matrix);
    for (const a of READ_RIGHTS) tampered.project_admin[a] = true;
    await t.db.admin.query(`insert into role_matrix_versions (org_id, version, matrix, note, published_at, published_by) values ($1, $2, $3::jsonb, 'tampered', now(), 'test')`, [t.orgId, cur.version + 1, JSON.stringify(tampered)]);
    for (const url of FACTORY_ENDPOINTS) for (const who of PROJECT_ADMINS) expect(await get(who, url), `${who} ${url}`).toBe(403);
    expect(await get("p-asha", "/api/v1/security")).toBe(200);

    await t.db.admin.query(readFileSync(fileURLToPath(new URL("../../../packages/db/migrations/0047_factory_rights_factory_roles_only.sql", import.meta.url)), "utf8"));
    const fixed = (await t.db.admin.query(`select version, matrix, note from role_matrix_versions where org_id = $1 order by version desc limit 1`, [t.orgId])).rows[0];
    expect(fixed.version).toBe(cur.version + 2);
    expect(fixed.note).toMatch(/removed from project-level roles/);
    for (const a of READ_RIGHTS) expect(fixed.matrix.project_admin[a], a).toBe(false);
    expect(fixed.matrix.auditor["policy.view"]).toBe(true);
    const scopes = (await t.db.admin.query(`select a->>'scope' as s from orgs, jsonb_array_elements(settings->'catalog'->'actions') a where id = $1 and a->>'id' = 'policy.view'`, [t.orgId])).rows;
    expect(scopes[0].s).toBe("factory");
    const [e] = (await t.db.admin.query(`select * from events where type = 'matrix.sanitised'`)).rows;
    expect(e.category).toBe("access");
    expect(e.after.removed).toEqual(expect.arrayContaining(READ_RIGHTS.map((a) => ({ role: "project_admin", right: a }))));
    expect((await verifyChain(t.db.app, t.orgId)).ok).toBe(true);

    // running it again changes nothing
    await t.db.admin.query(readFileSync(fileURLToPath(new URL("../../../packages/db/migrations/0047_factory_rights_factory_roles_only.sql", import.meta.url)), "utf8"));
    expect((await t.db.admin.query(`select max(version)::int as v from role_matrix_versions where org_id = $1`, [t.orgId])).rows[0].v).toBe(fixed.version);
  });
});
