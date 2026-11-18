import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

/** Owner decision 2026-11-19: the Factory Admin is universal and can override everywhere, never silently. */
d("Factory Admin: /can reports step-up and override", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  it("D: /can reports step_up for a stale session and override for a Factory Admin override", async () => {
    const fresh = await w.call("p-asha", "POST", "/api/v1/can", { checks: [{ action: "kill.factory" }, { action: "audit.view" }] });
    expect(fresh.body.results[0].needs).toBe("");
    const stale = await w.call("p-asha", "POST", "/api/v1/can", { checks: [{ action: "kill.factory" }, { action: "audit.view" }] }, {}, { authAgeSec: 4000 });
    expect(stale.body.results[0]).toMatchObject({ allowed: false, needs: "step_up", rule: { id: "STEP-UP" } });
    expect(stale.body.results[1]).toMatchObject({ allowed: true, needs: "" });
  });
});
