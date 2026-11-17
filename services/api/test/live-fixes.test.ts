import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readProjects } from "../src/core/read/index.js";
import { world } from "./flow-helpers.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const EDGE = { authorization: "Bearer edge-token-for-tests" };

/** Fixes found by a live end-to-end test: spend roll-up and cost recording. */
d("live fixes: project spend and conversational cost", () => {
  let t: TestApp;
  let n = 0;
  const w = world(() => t);
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());
  const mtd = async (project: string) => (await readProjects(t.db.app, t.orgId)).find((p) => p.id === project)!.budget.mtd;

  it("project spend is all metered spend of the month: station runs, conversational turns and side threads (never the figure the config carried)", async () => {
    await w.q(`update projects set config = config || '{"mtd": 0}'::jsonb where org_id = $1 and id = 'payments'`, [t.orgId]);
    await w.q(`delete from usage_meter where project_id = 'payments'`);
    expect(await mtd("payments")).toBe(0);
    const row = (station: string, micros: number, at = "now()") =>
      w.q(`insert into usage_meter (org_id, station, project_id, model_id, input_tokens, cost_micros, at) values ($1,$2,'payments','m',1,$3,${at})`, [t.orgId, station, micros]);
    await row("build", 3_000_000); // a station run
    await row("console", 2_000_000); // a conversational turn
    await row("console", 500_000); // a side thread
    await row("build", 9_000_000, "date_trunc('month', now()) - interval '1 day'"); // last month does not count
    expect(await mtd("payments")).toBeCloseTo(5.5, 6);
    expect(await mtd("identity")).toBe(0);
  });

  it("the budget gate and the project's shown spend are the same number", async () => {
    await w.q(`insert into budgets (org_id, project_id, monthly_limit_micros, alert_at) values ($1,'payments',6000000,0.8) on conflict (org_id, project_id) do update set monthly_limit_micros = 6000000, alert_at = 0.8`, [t.orgId]);
    const p = (await readProjects(t.db.app, t.orgId)).find((x) => x.id === "payments")!;
    expect(p.budget).toMatchObject({ monthly: 6, mtd: 5.5, alertAt: 0.8 });
    const gate = Number((await w.q(`select coalesce(sum(cost_micros),0)::text as n from usage_meter where project_id = 'payments' and at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`))[0].n);
    expect(gate / 1e6).toBe(p.budget.mtd);
  });

  it("a conversation on a work order puts its tokens and cost on the station it happened at, and carries the work order and project", async () => {
    const id = "WO-LIVE1";
    await w.insertWo(id, { position: "intake", data: { history: [{ station: "intake", startedAt: 1, endedAt: null, tokens: 0, cost: 0 }] } });
    const r = await t.app.inject({ method: "POST", url: "/internal/v1/service-calls/usage", headers: { ...EDGE, "idempotency-key": `lf-${++n}` }, payload: { purpose: "console", requestId: `lf-${n}`, model: "claude-test-1", vendor: "anthropic", inputTokens: 1000, outputTokens: 500, surface: "workorder", project: "payments", woId: id } });
    expect(r.statusCode, r.body).toBe(200);
    const m = (await w.q(`select surface, project_id, wo_id, cost_micros::int as c from usage_meter where wo_id = $1`, [id]))[0];
    expect(m).toMatchObject({ surface: "workorder", project_id: "payments", wo_id: id });
    const h = (await w.q(`select data->'history' as h from work_orders where id = $1`, [id]))[0].h[0];
    expect(h.tokens).toBe(1500);
    expect(h.cost).toBeCloseTo(m.c / 1e6, 9);
  });

  it("a work order at the brief gate reaches the person's Home as a gate decision (it carries the gate), not only as a question", async () => {
    const sub = await w.submit("p-tomas", { title: "Brief gate in the inbox" });
    const id = sub.body.id as string;
    const home = (await w.call("p-tomas", "GET", "/api/v1/home")).body;
    const item = (home.sections.waiting.conversations as Array<Record<string, any>>).find((c) => c.wo === id);
    expect(item, JSON.stringify(home.sections.waiting)).toBeTruthy();
    expect(item!.gate).toMatchObject({ id: "G0G1", label: "G0+G1", name: "Brief confirmed" });
  });

  describe("a failed work order", () => {
    const failed = "WO-LIVE2";
    const parked = "WO-LIVE3";
    beforeAll(async () => {
      await w.insertWo(failed, { position: "spec", state: "failed", data: { failReason: "The run could not be started: workspace seeding failed", failPhase: "start", history: [{ station: "spec", agent: "ag-spec", startedAt: 1, endedAt: null, tokens: 0, cost: 0 }] } });
      await w.insertWo(parked, { position: "person", state: "parked", data: { bayFrom: "spec", bayCause: "failed", bayReason: "Spec failed 3 times; a person needs to look.", history: [] } });
      await w.q(`insert into bay_stays (org_id, id, wo_id, bay, reason, entered_by, entered_at) values ($1,'BS-live3',$2,'person','x','system',now())`, [t.orgId, parked]);
    });

    it("stays in Waiting on you with the reason and the actions it allows (retry, assign), and Home says the run did not start", async () => {
      const home = (await w.call("p-asha", "GET", "/api/v1/home")).body;
      const items = home.sections.waiting.conversations as Array<Record<string, any>>;
      const f = items.find((c) => c.wo === failed)!;
      expect(f.question).toContain("workspace seeding failed");
      expect(f.stuck).toMatchObject({ state: "failed", actions: ["retry", "assign"] });
      expect(items.find((c) => c.wo === parked)!.stuck).toMatchObject({ state: "parked", actions: ["retry", "assign"] });
      // An engineer may retry (wo.sendback) but not assign (wo.reassign).
      const eng = (await w.call("p-tomas", "GET", "/api/v1/home")).body.sections.waiting.conversations as Array<Record<string, any>>;
      expect(eng.find((c) => c.wo === failed)?.stuck.actions).toEqual(["retry"]);
      const att = (home.sections.attention as Array<Record<string, any>>).find((a) => a.id === `hm-att-wo-${failed}`)!;
      expect(att.title).toBe(`${failed} run did not start`);
    });

    it("the conversation says a person has to act, never that the agent works at the station", async () => {
      const sess = (await w.call("p-asha", "GET", `/api/v1/work-orders/${failed}/session`)).body;
      expect(sess.next.actor).toBe("you");
      expect(sess.next.text).toContain("workspace seeding failed");
      expect(sess.next.text).not.toMatch(/works at/);
      expect(sess.waiting).toMatchObject({ kind: "you" });
      const list = (await w.call("p-asha", "GET", "/api/v1/work-order-sessions?project=payments")).body.items as Array<Record<string, any>>;
      expect(list.find((x) => x.id === failed)!.waitingOn).toBe("you");
    });

    it("a station that fails to start three times fails, then parks for a person with the failure as the cause (so Retry applies), and says the run never started", async () => {
      const id = await w.atStation("spec", "Fails to start");
      for (let i = 0; i < 3; i++) {
        const att = await w.liveAttempt(id);
        expect(att, `attempt ${i}`).toBeTruthy();
        const r = await w.apply(att!, { status: "failed", summary: "The run could not be started: seed failed", error: { code: "seed", msg: "The run could not be started: seed failed", phase: "start" } });
        expect(r.applied).toBe(true);
        const row = (await w.q(`select state, data from work_orders where id = $1`, [id]))[0];
        if (i < 2) {
          expect(row.state).toBe("failed");
          expect(row.data.failPhase).toBe("start");
          await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/retry`, {});
        } else {
          expect(row.state).toBe("parked");
          expect(row.data.bayCause).toBe("failed");
        }
      }
    });

    it("Retry works on a work order parked for a person after repeated failures, and starts the station again", async () => {
      const r = await w.call("p-asha", "POST", `/api/v1/work-orders/${parked}/retry`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const row = (await w.q(`select state, position, data from work_orders where id = $1`, [parked]))[0];
      expect(row.position).toBe("spec");
      expect(row.state).not.toBe("parked");
      expect(row.data.bayCause).toBeUndefined();
      // A work order that is merely waiting is still not retryable.
      const again = await w.call("p-asha", "POST", `/api/v1/work-orders/${parked}/retry`, {});
      expect(again.status).toBe(422);
    });
  });
});
