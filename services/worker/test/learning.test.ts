import { enqueue } from "@gantry/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_URL } from "./db.js";
import { startWorld, type World } from "./world.js";

const d = TEST_URL ? describe : describe.skip;
const DAY = 86_400_000;

d("learning.refresh (spec 13.4)", () => {
  let w: World;
  beforeEach(async () => { w = await startWorld(); });
  afterEach(async () => { await w.close(); });

  it("regroups repeated signals into a finding, records one event, and does nothing the second time", async () => {
    for (const id of ["WO-9701", "WO-9702"]) {
      await w.workOrderAt(id, { station: "build", repo: "payments-api" });
      await w.q(`update work_orders set data = jsonb_set(data, '{sendbacks}', $3::jsonb) where org_id = $1 and id = $2`, [w.orgId, id, JSON.stringify([{ from: "build", to: "build", note: "Missing a rollback note", at: Date.now() - 2 * DAY, by: "p-meera" }])]);
    }
    await enqueue(w.db.app, { orgId: w.orgId, queue: "system", kind: "learning.refresh", payload: {} });
    await w.worker.runner.drain();
    const f = await w.q(`select signal, agent_id, project_id, evidence_count, status from findings where signal = 'sendback'`);
    expect(f).toEqual([{ signal: "sendback", agent_id: "ag-build", project_id: "payments", evidence_count: 2, status: "open" }]);
    expect((await w.q(`select count(*)::int as n from events where type = 'learning.refresh'`))[0].n).toBe(1);
    // nothing is drafted or applied by the loop on its own
    expect((await w.q(`select count(*)::int as n from proposals`))[0].n).toBe(0);
    await enqueue(w.db.app, { orgId: w.orgId, queue: "system", kind: "learning.refresh", payload: {} });
    await w.worker.runner.drain();
    expect((await w.q(`select count(*)::int as n from events where type = 'learning.refresh'`))[0].n).toBe(1);
    expect((await w.q(`select count(*)::int as n from jobs where kind = 'learning.refresh' and status = 'done'`))[0].n).toBe(2);
  });
});
