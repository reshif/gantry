import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";
const CELL = "ag-spec|feature|payments";

d("round 2: a level change clears the probation marker (S-39)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seedEvals: true });
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  const cell = async (id: string) => (await w.call(ADMIN, "GET", "/api/v1/trust/cells")).body.cells.find((c: any) => c.id === id);
  it("a demotion clears the marker, so a regrant to L3 runs at L3", async () => {
    expect((await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true, reason: "Enough evidence on payments" })).status).toBe(200);
    expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 3, reason: "Specs have been clean for a month" })).status).toBe(200);
    await q(`update trust_cells set data = data || '{"probation":{"since":"x","fromVersion":null,"toVersion":"9","kind":"promote","runsLeft":5}}'::jsonb where id = $1`, [CELL]);
    expect(await cell(CELL)).toMatchObject({ effective: 2 });
    expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 2, reason: "Specs slipped this week" })).status).toBe(200);
    expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 3, reason: "Back to clean again" })).status).toBe(200);
    expect(await cell(CELL)).toMatchObject({ level: 3, effective: 3, probation: null });
  });
});
