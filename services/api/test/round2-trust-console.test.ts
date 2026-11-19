import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";
const CELL = "ag-spec|feature|payments";

d("round 2: lowering trust is always allowed (S-17)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seedEvals: true });
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const cell = async () => (await w.call(ADMIN, "GET", "/api/v1/trust/cells")).body.cells.find((c: any) => c.id === CELL);

  it("lowering L3 to L2 works while levels above L1 are off; raising still needs the switch", async () => {
    expect((await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: true, reason: "Enough evidence on payments" })).status).toBe(200);
    expect((await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 3, reason: "Specs have been clean for a month" })).status).toBe(200);
    expect((await w.call(ADMIN, "PUT", "/api/v1/trust/switch", { on: false, reason: "Pausing the ladder" })).status).toBe(200);
    const down = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 2, reason: "Specs slipped this week" });
    expect(down.status, JSON.stringify(down.body)).toBe(200);
    expect(await cell()).toMatchObject({ level: 2 });
    const up = await w.call(ADMIN, "POST", "/api/v1/trust/grants", { target: CELL, level: 3, reason: "Back to L3 please" });
    expect(up.status).toBe(403);
    expect(up.body.msg).toMatch(/switched off/);
  });
  it("the console card says what the server will do: lowering is allowed, raising is refused while the switch is off", async () => {
    const tool = async (level: number) => {
      const sess = await t.session(ADMIN);
      const r = await t.app.inject({ method: "POST", url: "/api/v1/console/tools/propose_trust_change", headers: sess.headers, payload: { input: { cell: CELL, level, reason: "Following the spec quality" } } });
      return r.json() as any;
    };
    const lower = await tool(1);
    expect(JSON.stringify(lower)).toMatch(/Lowering a level is always allowed/);
    const raise = await tool(3);
    expect(JSON.stringify(raise)).toMatch(/switched off/);
  });
});
