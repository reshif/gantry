import { randomBytes } from "node:crypto";
import { withTx } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetBreach } from "../src/areas/internal/metering.js";
import { loadRunCtx } from "../src/areas/internal/context.js";
import { issueRunToken } from "../src/areas/internal/tokens.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const EDGE = { authorization: "Bearer edge-token-for-tests" };
const ADMIN = "p-daniel"; // project admin on payments: project.config there
const NOBODY = "p-tomas";

d("work order spending cap (owner decision 3)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ config: { secrets: { sessionKey: Buffer.from("test-session-key-0123456789abcdef"), dataKey: randomBytes(32), edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const put = (who: string, id: string, body: object) => w.call(who, "PUT", `/api/v1/work-orders/${id}/budget`, body);
  let n = 0;
  const insert = (woId: string, cap: number) =>
    w.q(`insert into work_orders (org_id, id, project_id, repo_id, title, class, position, state, flow_version, submitter, data) values ($1,$2,'payments','payments-api','T','feature','build','running',1,'p-tomas',$3::jsonb)`, [t.orgId, woId, JSON.stringify({ budgetUsd: cap, history: [], log: [] })]);
  /** A running work order with a cap, one run, and a usage report that breaches it (the meter then halts the work order with cause budget). */
  async function breached(cap: number) {
    const i = ++n;
    const woId = `WO-CAP-${i}`;
    const runId = `run-cap-${i}`;
    await insert(woId, cap);
    const att = (await w.q(`insert into attempts (org_id, id, wo_id, station, visit, state, data) values ($1,$2,$3,'build',1,'running','{}'::jsonb) returning fencing::text as fencing`, [t.orgId, `at-cap-${i}`, woId]))[0];
    await w.q(`insert into runs (org_id, id, attempt_id, wo_id, model_id, data) values ($1,$2,$3,$4,'claude-sonnet-5-5','{}'::jsonb)`, [t.orgId, runId, `at-cap-${i}`, woId]);
    const tk = await withTx(t.db.app, (tx) => issueRunToken(tx, runId, `at-cap-${i}`, att.fencing));
    const usage = await t.app.inject({ method: "POST", url: `/internal/v1/runs/${runId}/usage`, headers: EDGE, payload: { token: tk.token, requestId: `rq-cap-${i}`, model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 1000 } });
    expect(usage.statusCode, usage.body).toBe(200);
    return { woId, runId };
  }
  const breach = (runId: string) => withTx(t.db.app, async (tx) => budgetBreach(tx, (await loadRunCtx(tx, t.orgId, runId))!));
  const stops = (woId: string) => w.q(`select id, cause, mode, lifted_at from stops where wo_id = $1 order by set_at`, [woId]);

  it("refuses a caller without the project right, and audits the denial", async () => {
    const { woId } = await breached(0.01);
    const r = await put(NOBODY, woId, { usd: 5, reason: "More room" });
    expect(r.status).toBe(403);
    expect((await w.q(`select data from work_orders where id = $1`, [woId]))[0].data.budgetUsd).toBe(0.01);
    expect((await w.events("project.config.denied")).length).toBeGreaterThan(0);
  });

  it("validates the amount: positive, bounded, and above what is already spent", async () => {
    const { woId } = await breached(0.01);
    expect((await put(ADMIN, woId, { usd: 0 })).status).toBe(422);
    expect((await put(ADMIN, woId, { usd: -3 })).status).toBe(422);
    expect((await put(ADMIN, woId, { usd: 1_000_000 })).status).toBe(422);
    const low = await put(ADMIN, woId, { usd: 0.005 });
    expect(low.status).toBe(422);
    expect(low.body.msg).toMatch(/already spent/);
    expect((await put(ADMIN, "WO-nope", { usd: 5 })).status).toBe(404);
  });

  it("a raise resumes the budget halt in the same step, audited with before and after, and the breach clears", async () => {
    const { woId, runId } = await breached(0.01);
    expect(await stops(woId)).toEqual([expect.objectContaining({ cause: "budget", mode: "halt", lifted_at: null })]);
    expect(await breach(runId)).toMatchObject({ scope: "wo" });
    const r = await put(ADMIN, woId, { usd: 5, reason: "Needs the extra tests" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ budgetUsd: 5, resumed: true });
    const rows = await stops(woId);
    expect(rows[0].lifted_at).not.toBeNull();
    expect(await breach(runId)).toBeNull();
    const ev = (await w.events("wo.budget")).find((e) => e.after?.resumed === rows[0].id)!;
    expect(ev.before).toMatchObject({ usd: 0.01 });
    expect(ev.after).toMatchObject({ usd: 5, reason: "Needs the extra tests" });
    expect((await w.events("resume")).some((e) => e.after?.stop === rows[0].id)).toBe(true);
  });

  it("a raise during a manual halt leaves it halted; lowering is allowed but resumes nothing", async () => {
    await insert("WO-CAP-MAN", 1);
    const h = await w.call("p-meera", "POST", "/api/v1/stops", { scope: "workorder", id: "WO-CAP-MAN", mode: "halt", reason: "Hold for review" });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    const r = await put(ADMIN, "WO-CAP-MAN", { usd: 9 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resumed).toBe(false);
    expect(await stops("WO-CAP-MAN")).toEqual([expect.objectContaining({ cause: "manual", lifted_at: null })]);

    // Lowering below spend is refused and the halt stays; lowering above spend after a raise resumes nothing.
    const { woId, runId } = await breached(0.01);
    expect((await put(ADMIN, woId, { usd: 0.011 })).status).toBe(422);
    expect((await stops(woId))[0].lifted_at).toBeNull();
    expect((await put(ADMIN, woId, { usd: 5 })).body.resumed).toBe(true);
    const lower = await put(ADMIN, woId, { usd: 1 });
    expect(lower.status, JSON.stringify(lower.body)).toBe(200);
    expect(lower.body.resumed).toBe(false);
    expect(await stops(woId)).toHaveLength(1);
    expect(await breach(runId)).toBeNull();
  });

  const resume = (who: string, woId: string, reason?: string) => w.call(who, "DELETE", `/api/v1/stops/${encodeURIComponent(`workorder:${woId}`)}`, reason ? { reason } : undefined);

  it("S-12: resuming a budget halt while still over budget is refused; a Factory Admin can resume it with a reason, audited", async () => {
    const { woId } = await breached(0.01);
    const [halt] = await stops(woId);
    const refused = await resume("p-meera", woId, "Try again");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.msg).toMatch(/still over budget, raise the cap first/);
    expect((await stops(woId))[0].lifted_at).toBeNull();
    // A Factory Admin needs a reason to override.
    const noReason = await resume("p-asha", woId);
    expect(noReason.status).toBe(409);
    expect(noReason.body.msg).toMatch(/reason of at least 5 characters/);
    const ok = await resume("p-asha", woId, "Owner approved finishing this order");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await stops(woId))[0].lifted_at).not.toBeNull();
    const ev = (await w.events("resume")).find((e) => e.after?.stop === halt.id)!;
    expect(ev.after).toMatchObject({ override: true, text: "Owner approved finishing this order", overBudget: expect.stringMatching(/work order's cap/) });
    // Raising the cap is still the normal way: it lifts without any override.
    const again = await breached(0.01);
    expect((await put(ADMIN, again.woId, { usd: 5 })).body.resumed).toBe(true);
  });
});
