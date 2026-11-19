import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { agentOffKind } from "../src/areas/session/core.js";

const d = TEST_URL ? describe : describe.skip;
const ADMIN = "p-asha";

d("round 2: agent turn-on gate (S-13)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const q = w.q;
  let n = 0;
  const key = (): Record<string, string> => ({ "idempotency-key": `r2a-${Date.now()}-${n++}` });
  const agent = async (id: string) => (await w.call(ADMIN, "GET", "/api/v1/agents")).body.find((a: any) => a.id === id);
  const make = async (name: string): Promise<string> =>
    (await w.call(ADMIN, "POST", "/api/v1/agents", { name, station: "close", model: "claude-sonnet-5-5", autonomy: "gate", stations: ["close"], budget: 2, instructions: "Close the work order." }, key())).body.agent.id;
  const turnOn = async (id: string, extra: object = {}) => w.call(ADMIN, "PATCH", `/api/v1/agents/${id}`, { patch: { status: "active" }, ...extra }, { "if-match": String((await agent(id)).rev) });
  const row = async (id: string) => (await q(`select status, live_version, data from agents where id = $1`, [id]))[0];

  it("a created agent's first version is not promoted, and turning it on without a passing suite is refused", async () => {
    const id = await make("Gate One");
    const r0 = await row(id);
    expect(r0.data.promoted).toEqual([]);
    expect(agentOffKind({ status: "active", live_version: r0.live_version, data: r0.data }, { requirePromotionRecord: false })).toBe("unpromoted");
    const r = await turnOn(id);
    expect(r.status).toBe(403);
    expect(r.body.needs).toMatch(/passing run/);
    expect((await row(id)).status).toBe("paused");
  });
  it("turns on once its suite passed for the live version, and worker dispatch agrees", async () => {
    const id = await make("Gate Two");
    const suite = (await row(id)).data.suite;
    await q(`insert into eval_runs (org_id, id, suite_id, status, score, data) values ($1,$2,$3,'completed',0.95,$4::jsonb)`, [t.orgId, `RUN-R2-${id}`, suite, JSON.stringify({ agent: id, version: "0.1.0" })]);
    expect((await turnOn(id)).status).toBe(200);
    const r = await row(id);
    expect(r.status).toBe("active");
    expect(agentOffKind({ status: r.status, live_version: r.live_version, data: r.data }, { requirePromotionRecord: false })).toBeNull();
  });
  it("a Factory Admin may override with a reason of 5 characters, audited; a short reason is refused", async () => {
    const id = await make("Gate Three");
    expect((await turnOn(id, { overrideReason: "abc" })).status).toBe(403);
    const r = await turnOn(id, { overrideReason: "pilot approved by the owner" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ev = (await w.events("agent.edit")).filter((e: any) => e.subject.id === id).pop();
    expect(ev.after.turnOn).toMatchObject({ override: true, overrideReason: "pilot approved by the owner" });
    const x = await row(id);
    expect(agentOffKind({ status: x.status, live_version: x.live_version, data: x.data }, { requirePromotionRecord: false })).toBeNull();
  });
  it("a seeded agent with no promotion record still turns on", async () => {
    expect((await w.call(ADMIN, "PATCH", "/api/v1/agents/ag-classifier", { patch: { status: "paused" } }, { "if-match": String((await agent("ag-classifier")).rev) })).status).toBe(200);
    expect((await turnOn("ag-classifier")).status).toBe(200);
  });
});
