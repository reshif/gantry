import { randomBytes } from "node:crypto";
import { withTx } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueRunToken } from "../src/areas/internal/tokens.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const EDGE = { authorization: "Bearer edge-token-for-tests" };
const ADMIN = "p-daniel";

d("round 5 budget (S-43, S-44, S-45)", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ config: { secrets: { sessionKey: Buffer.from("test-session-key-0123456789abcdef"), dataKey: randomBytes(32), edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } }); });
  afterAll(() => t.close());
  const w = world(() => t);
  let n = 0;
  async function run(woId: string, opts: { data?: object; usage?: boolean } = {}) {
    const i = ++n;
    await w.q(`insert into work_orders (org_id, id, project_id, repo_id, title, class, position, state, flow_version, submitter, data) values ($1,$2,'payments','payments-api','T','feature','build','running',1,'p-tomas',$3::jsonb)`, [t.orgId, woId, JSON.stringify({ history: [], log: [], ...(opts.data ?? {}) })]);
    const att = (await w.q(`insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,'build',1,'running','{}'::jsonb) returning fencing::text as fencing`, [t.orgId, `at-s${i}`, woId]))[0];
    await w.q(`insert into runs (org_id, id, attempt_id, wo_id, model_id, data) values ($1,$2,$3,$4,'claude-sonnet-5-5','{}'::jsonb)`, [t.orgId, `run-s${i}`, `at-s${i}`, woId]);
    const tk = await withTx(t.db.app, (tx) => issueRunToken(tx, `run-s${i}`, `at-s${i}`, att.fencing));
    return { runId: `run-s${i}`, token: tk.token, usage: () => t.app.inject({ method: "POST", url: `/internal/v1/runs/run-s${i}/usage`, headers: EDGE, payload: { token: tk.token, requestId: `rq-s${i}-${Math.random()}`, model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 1000 } }),
      authorize: async () => (await t.app.inject({ method: "POST", url: `/internal/v1/runs/run-s${i}/authorize`, headers: EDGE, payload: { token: tk.token, model: "claude-sonnet-5-5" } })).json() };
  }
  const stops = (woId: string) => w.q(`select id, cause, mode, lifted_at from stops where wo_id = $1 order by set_at`, [woId]);

  it("S-45: raising the project's per-work-order default cap lifts the budget halts it held", async () => {
    const put = (usd: number) => w.call(ADMIN, "PUT", "/api/v1/budgets/payments", { perWorkOrder: usd });
    expect((await put(0.01)).status).toBe(200);
    const r = await run("WO-S1");
    expect((await r.usage()).statusCode).toBe(200);
    expect(await stops("WO-S1")).toEqual([expect.objectContaining({ cause: "budget", lifted_at: null })]);
    const up = await put(50);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect((await stops("WO-S1"))[0].lifted_at, "halt still on after the raise").not.toBeNull();
  });

  it("S-43 (owner decision): a monthly budget of 0 means no cap, never a $0 cap", async () => {
    await w.call(ADMIN, "PUT", "/api/v1/budgets/payments", { perWorkOrder: 0 });
    const r = await run("WO-S2");
    const set = await w.call(ADMIN, "PATCH", "/api/v1/projects/payments/config", { path: "budget.monthly", value: 0 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    await t.app.inject({ method: "POST", url: `/internal/v1/runs/${r.runId}/usage`, headers: EDGE, payload: { token: r.token, requestId: "rq-b2", model: "claude-sonnet-5-5", inputTokens: 5_000_000, outputTokens: 5_000_000 } });
    expect((await r.authorize()).allow, "0 is no cap: spend is allowed").toBe(true);
    expect(await stops("WO-S2"), "no budget halt from an uncapped project").toEqual([]);
    expect(set.body.msg).not.toMatch(/\$0 cap|nothing metered/);
    expect(await w.q(`select monthly_zero_cap from budgets where project_id = 'payments'`)).toEqual([{ monthly_zero_cap: false }]);
    const read = (await w.call("p-asha", "GET", "/api/v1/budgets")).body.find((x: { project: string }) => x.project === "payments");
    expect(read).toMatchObject({ monthly: 0, capped: false });
  });

  it("S-43: null also means no cap; a row that still carries the old zero-cap flag is uncapped too; a real amount is capped", async () => {
    await w.q(`delete from usage_meter where project_id = 'payments'`);
    const r = await run("WO-S2B");
    const off = await w.call(ADMIN, "PATCH", "/api/v1/projects/payments/config", { path: "budget.monthly", value: null });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await w.call("p-asha", "GET", "/api/v1/budgets")).body.find((x: { project: string }) => x.project === "payments")).toMatchObject({ monthly: 0, capped: false });
    expect((await r.authorize()).allow, "no cap").toBe(true);
    await w.q(`update budgets set monthly_limit_micros = 0, monthly_zero_cap = true where project_id = 'payments'`);
    expect((await r.authorize()).allow, "a leftover zero-cap flag is ignored").toBe(true);
    expect((await w.call("p-asha", "GET", "/api/v1/budgets")).body.find((x: { project: string }) => x.project === "payments")).toMatchObject({ capped: false });
    const cap = await w.call(ADMIN, "PATCH", "/api/v1/projects/payments/config", { path: "budget.monthly", value: 0.000001 });
    expect(cap.status).toBe(200);
    expect(await w.q(`select monthly_zero_cap from budgets where project_id = 'payments'`)).toEqual([{ monthly_zero_cap: false }]);
    expect((await w.call("p-asha", "GET", "/api/v1/budgets")).body.find((x: { project: string }) => x.project === "payments")).toMatchObject({ capped: true });
    await w.call(ADMIN, "PATCH", "/api/v1/projects/payments/config", { path: "budget.monthly", value: 1000 });
  });

  it("S-44: a parallel work order is refused by the project cap that another work order crossed, with no halt on it", async () => {
    await w.call(ADMIN, "PATCH", "/api/v1/projects/payments/config", { path: "budget.monthly", value: 100000 });
    await w.q(`delete from usage_meter where project_id = 'payments'`);
    await w.call(ADMIN, "PATCH", "/api/v1/projects/payments/config", { path: "budget.monthly", value: 0.01 });
    const a = await run("WO-S4A"); const b = await run("WO-S4B");
    await a.usage();
    expect((await stops("WO-S4A"))).toHaveLength(1);
    const deny = await b.authorize();
    expect(deny.allow).toBe(false);
    expect(await stops("WO-S4B"), "B refused, no halt").toHaveLength(1);
    // The same raise that lifts A lifts B's halt too.
    expect((await w.call(ADMIN, "PATCH", "/api/v1/projects/payments/config", { path: "budget.monthly", value: 100000 })).status).toBe(200);
    expect((await stops("WO-S4B"))[0].lifted_at, "B's halt lifted with the raise").not.toBeNull();
  });

  it("S-44 side-thread: spend by a side thread (no work order) fills the project's month; the next work-order call is refused and nothing marks it", async () => {
    await w.call(ADMIN, "PATCH", "/api/v1/projects/payments/config", { path: "budget.monthly", value: 1 });
    await w.q(`delete from usage_meter where project_id = 'payments'`);
    await w.q(`insert into usage_meter (org_id, request_id, run_id, project_id, model_id, input_tokens, output_tokens, cost_micros, price_version, outcome) values ($1,'rq-side',null,'payments','claude-sonnet-5-5',1,1,1500000,1,'ok')`, [t.orgId]).catch((e) => console.log("insert err", e.message));
    const r = await run("WO-S3");
    const a = await r.authorize();
    expect(a.allow).toBe(false);
    expect(await stops("WO-S3"), "refused with no halt marker").toHaveLength(1);
  });
});
