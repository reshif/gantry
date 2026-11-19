import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { agentOffKind } from "../src/areas/session/core.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";
const CELL = "ag-spec|feature|payments";
d("round 2: rolling back to a never-tested version (S-40)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  let k = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `r2r-${Date.now()}-${k++}` });
  const rev = async (id: string) => String((await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === id).rev);
  const row = async (id: string) => (await q(`select status, live_version, data from agents where id = $1`, [id]))[0];

  it("is refused without a passing suite, and a Factory Admin override with a reason records the promotion", async () => {
    const id = (await w.call(ADMIN, "POST", "/api/v1/agents", { name: "Rollback One", station: "close", model: "claude-sonnet-5-5", autonomy: "gate", stations: ["close"], budget: 2, instructions: "Close it." }, key())).body.agent.id as string;
    expect((await w.call(ADMIN, "POST", `/api/v1/agents/${id}/versions`, { label: "0.2.0" })).status).toBe(200);
    const suite = (await row(id)).data.suite;
    await q(`insert into eval_runs (org_id, id, suite_id, status, score, data) values ($1,$2,$3,'completed',0.95,$4::jsonb)`, [t.orgId, `RUN-R2R-${id}`, suite, JSON.stringify({ agent: id, version: "0.2.0" })]);
    expect((await w.call(ADMIN, "POST", `/api/v1/agents/${id}/versions/0.2.0/promote`)).status).toBe(200);
    expect((await w.call(ADMIN, "PATCH", `/api/v1/agents/${id}`, { patch: { status: "active" } }, { "if-match": await rev(id) })).status).toBe(200);
    const refused = await w.call(ADMIN, "POST", `/api/v1/agents/${id}/rollback`, { version: 1 });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect((await row(id)).live_version).toBe(2);
    const ok = await w.call(ADMIN, "POST", `/api/v1/agents/${id}/rollback`, { version: 1, overrideReason: "0.2.0 broke the close station" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const r = await row(id);
    expect(r.live_version).toBe(1);
    expect(agentOffKind({ status: r.status, live_version: r.live_version, data: r.data }, { requirePromotionRecord: false })).toBeNull();
    const ev = (await w.events("agent.rollback")).pop()!;
    expect(ev.after.promotion).toMatchObject({ override: true, overrideReason: "0.2.0 broke the close station" });
  });
});
