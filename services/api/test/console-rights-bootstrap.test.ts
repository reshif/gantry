import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "./helpers.js";

/** An org created before console rights existed gains them on start-up as a new matrix version: Factory Admin all, others console.use only, edits untouched. */
describe("console rights: upgrade of an existing org", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ seedAudit: false, seedEvals: false }); });
  afterAll(async () => { await t.close(); });

  it("adds the Console actions with their defaults and leaves existing cells (even edited ones) alone; audited as matrix.defaults", async () => {
    const q = (sql: string, p: unknown[] = []) => t.db.admin.query(sql, p);
    const { bootstrapOrg } = await import("../src/core/bootstrap.js");
    await q(`update orgs set settings = jsonb_set(settings, '{catalog,actions}', (select jsonb_agg(a) from jsonb_array_elements(settings->'catalog'->'actions') a where a->>'id' not like 'console.%'))`);
    // An older matrix: no console cells, and an admin edit (Engineer may kill a work order).
    await q(`insert into role_matrix_versions (org_id, version, matrix, published_at, published_by) select org_id, version + 1, (select jsonb_object_agg(r, ((m.matrix->r) - 'console.use' - 'console.propose.submit' - 'console.propose.approve_gate' - 'console.propose.halt' - 'console.propose.resume' - 'console.propose.kill' - 'console.propose.restore' - 'console.propose.park' - 'console.propose.trust_change' - 'console.propose.onboard_repo') || case when r = 'engineer' then '{"kill.workorder": true}'::jsonb else '{}'::jsonb end) from jsonb_object_keys(m.matrix) r), now(), 'test' from role_matrix_versions m order by version desc limit 1`);
    await bootstrapOrg(t.db.app, t.config);
    const m = (await q(`select matrix from role_matrix_versions order by version desc limit 1`)).rows[0].matrix;
    for (const id of Object.keys(m.factory_admin).filter((k) => k.startsWith("console."))) expect(m.factory_admin[id], id).toBe(true);
    expect(m.factory_admin["console.propose.kill"]).toBe(true);
    expect(m.engineer["console.use"]).toBe(true);
    expect(m.engineer["console.propose.submit"]).toBe(false);
    expect(m.viewer["console.use"]).toBe(true);
    expect(m.project_admin["console.propose.halt"]).toBe(false);
    expect(m.engineer["kill.workorder"]).toBe(true); // the admin's edit survives
    const ev = (await q(`select after from events where type = 'matrix.defaults' order by seq desc limit 1`)).rows[0];
    expect(ev.after.added).toContain("console.use");
    const cat = (await q(`select settings->'catalog'->'actions' a from orgs`)).rows[0].a as Array<{ id: string; group: string }>;
    expect(cat.filter((a) => a.group === "Console")).toHaveLength(10);
  });
});
