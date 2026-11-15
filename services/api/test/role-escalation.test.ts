import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

/** people.manage can be handed to a custom role; it must never be a path to Factory Admin or to more rights for oneself. */
d("role-grant escalation", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    // Hand the Auditor role people.manage and policy.edit, as a Factory Admin could for a custom role.
    await t.db.admin.query(`insert into role_matrix_versions (org_id, version, matrix, published_at, published_by) select org_id, version + 1, jsonb_set(jsonb_set(matrix, '{auditor,people.manage}', 'true'), '{auditor,policy.edit}', 'true'), now(), 'test' from role_matrix_versions order by version desc limit 1`);
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const roles = async (id: string) => ((await w.call("p-asha", "GET", "/api/v1/people")).body as unknown as Array<{ id: string; roles: Array<{ role: string }> }>).find((p) => p.id === id)!.roles.map((r) => r.role);

  it("cannot grant themselves any role", async () => {
    const r = await w.call("p-sam", "PUT", "/api/v1/people/p-sam/factory-roles/factory_admin");
    expect(r.status).toBe(403);
    expect(r.body.msg).toMatch(/yourself/);
  });
  it("cannot grant or remove Factory Admin unless they are one", async () => {
    expect((await w.call("p-sam", "PUT", "/api/v1/people/p-tomas/factory-roles/factory_admin")).status).toBe(403);
    expect((await w.call("p-sam", "DELETE", "/api/v1/people/p-omar/factory-roles/factory_admin")).status).toBe(403);
    expect(await roles("p-tomas")).not.toContain("factory_admin");
    expect(await roles("p-omar")).toContain("factory_admin");
  });
  it("still grants the other factory roles it is for", async () => {
    expect((await w.call("p-sam", "PUT", "/api/v1/people/p-tomas/factory-roles/auditor")).status).toBe(200);
    expect(await roles("p-tomas")).toContain("auditor");
  });

  it("policy.edit cannot add rights to a role its holder holds", async () => {
    const v = async () => String((await w.call("p-asha", "GET", "/api/v1/access/matrix")).body.version);
    const own = await w.call("p-sam", "PUT", "/api/v1/access/matrix/auditor/wo.submit", { on: true }, { "if-match": await v() });
    expect(own.status).toBe(403);
    expect(own.body.msg).toMatch(/you hold Auditor/i);
    expect((await w.call("p-sam", "PUT", "/api/v1/access/matrix/viewer/wo.submit", { on: true }, { "if-match": await v() })).status).toBe(200);
    expect((await w.call("p-sam", "PUT", "/api/v1/access/matrix/auditor/wo.submit", { on: false }, { "if-match": await v() })).status).toBe(200);
  });
});
