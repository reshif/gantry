import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { addMessage, ensureThread } from "../src/areas/console/threads.js";

const d = TEST_URL ? describe : describe.skip;
const ASHA = "p-asha";

d("round 5 console cards (S-49, S-50)", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());
  const w = world(() => t);
  const card = async (who: string, call: object, extra: object = {}) => {
    const mid = `MSG-S5-${Math.random().toString(36).slice(2, 8)}`;
    await w.tx(async (tx: any) => {
      const th = await ensureThread(tx, t.orgId, who, null, "A card", new Date());
      await addMessage(tx, t.orgId, th!.id, "assistant", "Proposed.", { proposals: [{ id: "PROP-1", kind: "halt", title: "T", summary: "", steps: [], call, perm: { action: "line.halt" }, check: { allowed: true }, needsReason: 4, phrase: null, danger: false, entities: [], status: "pending", ...extra }] }, new Date(), mid);
    });
    return mid;
  };
  const confirm = async (who: string, mid: string, payload: object, o: { authAgeSec?: number } = {}) => {
    const s = await t.session(who, o);
    const r = await t.app.inject({ method: "POST", url: `/api/v1/console/messages/${mid}/proposals/PROP-1/confirm`, headers: s.headers, payload });
    return { status: r.statusCode, body: r.json() as any };
  };
  const stored = async (mid: string) => (await w.q(`select data from console_messages where id = $1`, [mid]))[0].data.proposals[0];

  it("C2: two tabs confirm one card at once; the card must end done and the action run once", async () => {
    const mid = await card(ASHA, { method: "POST", path: "/api/v1/stops", body: { scope: "project", id: "payments", mode: "halt", reason: "", via: "console" }, idempotent: false });
    const [a, b] = await Promise.all([confirm(ASHA, mid, { reason: "hold for review" }), confirm(ASHA, mid, { reason: "hold for review" })]);
    const p = await stored(mid);
    const stops = await w.q(`select count(*)::int n from stops where scope_type='project' and project_id='payments' and cause <> 'budget'`);
    expect(p.status).toBe("done");
    expect(a.body.status === "done" || b.body.status === "done").toBe(true);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(stops[0].n, "the action ran once").toBe(1);
    const again = await confirm(ASHA, mid, { reason: "hold for review" });
    expect(again.status).toBe(409);
    expect(again.body.msg).toMatch(/already done/);
  });
  it("C1: a card for a step-up action confirmed after the sign-in window ends the card as failed; a fresh sign-in cannot confirm it", async () => {
    const mid = await card(ASHA, { method: "POST", path: "/api/v1/stops", body: { scope: "project", id: "payments", mode: "kill", reason: "", via: "console" }, idempotent: true }, { kind: "kill", phrase: "Payments Platform" });
    const old = await confirm(ASHA, mid, { reason: "duplicate refunds seen", confirmText: "Payments Platform" }, { authAgeSec: 3 * 3600 });
    expect(old.status).toBe(403);
    expect(old.body).toMatchObject({ recorded: false, status: "pending", needs: "step_up", retry: true });
    expect((await stored(mid)).status, "the card stays pending and nothing is recorded").toBe("pending");
    const fresh = await confirm(ASHA, mid, { reason: "duplicate refunds seen", confirmText: "Payments Platform" }, { authAgeSec: 0 });
    expect(fresh.status, "after signing in again the same card should run").toBe(200);
    expect(fresh.body.status).toBe("done");
  });

});
