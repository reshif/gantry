import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { openGate } from "../src/areas/workorders/engine.js";
import { lockWo } from "../src/areas/workorders/model.js";

const d = TEST_URL ? describe : describe.skip;

/** Spec 9.5: any risk tag forces a human vote, including on a gate the project runs automatically. */
d("risk tags on automatic gates", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  const open = (id: string) => w.tx(async (tx) => openGate(await w.fxIn(tx), await lockWo(tx, t.orgId, id), "G4", { checks: [{ name: "Required checks", ok: true }] }));
  const decision = async (id: string) => (await w.q<{ decision: string }>(`select decision from gate_decisions where wo_id = $1`, [id]))[0]?.decision ?? null;

  it("an untagged change passes an automatic gate on green checks; a CI, dependency or migration change waits for a person", async () => {
    expect((await w.call("p-asha", "PATCH", "/api/v1/projects/payments/config", { gate: "G4", mode: "auto" })).status).toBe(200);
    await w.insertWo("WO-9101", { position: "build", state: "running", data: { files: [{ path: "src/charge.ts" }] } });
    await open("WO-9101");
    expect(await decision("WO-9101")).toBe("auto_passed");
    for (const [id, path] of [["WO-9102", ".github/workflows/ci.yml"], ["WO-9103", "package-lock.json"], ["WO-9104", "db/migrations/0042_add.sql"]] as const) {
      await w.insertWo(id, { position: "build", state: "running", data: { files: [{ path }] } });
      await open(id);
      expect(await decision(id), path).toBeNull();
      const wo = await w.get(id);
      expect(wo.state, path).toBe("waiting");
    }
  });
});
