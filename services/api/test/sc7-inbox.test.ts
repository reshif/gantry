import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("sc7 inbox", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());
  const w = world(() => t);
  let n = 0;
  const ask = async (woId: string, station: string, att: string) => {
    await w.q(`insert into wo_questions (org_id, id, wo_id, station, attempt_id, asked_by, question, why, options, blocking, ask_of, created_at, updated_at) values ($1,$2,$3,$4,$5,'ag-x','Which currency should refunds use?','needed','[]'::jsonb,true,'requester',now(),now())`, [t.orgId, `Q-SC7-${++n}`, woId, station, att]);
  };
  const waiting = async (who: string) => {
    const h = await w.call(who, "GET", "/api/v1/home");
    return { approvals: (h.body.sections?.waiting?.approvals ?? h.body.approvals ?? []) as any[], conversations: (h.body.sections?.waiting?.conversations ?? h.body.conversations ?? []) as any[] };
  };

  it("N1: a station's open question stays in the requester's Inbox after the work order is declined", async () => {
    const id = await w.atStation("plan", "Question then decline");
    const att = await w.liveAttempt(id);
    await ask(id, "plan", att!.id);
    const before = await waiting("p-tomas");
    expect(before.conversations.some((c) => c.wo === id), "the question is listed while the order is live").toBe(true);
    expect((await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/decline`, { reason: "We are not doing this one" })).status).toBe(200);
    const after = await waiting("p-tomas");
    const row = (await w.q(`select status, answer from wo_questions where wo_id = $1`, [id]))[0];
    expect(row.status, "the question is closed, with the reason").toBe("dismissed");
    expect(row.answer).toMatch(/declined/);
    expect(after.conversations.some((c) => c.wo === id), "a declined order's question is dropped from the Inbox").toBe(false);
  });

  it("N2: a question of a station run that was sent back stays open and blocks the next feasibility check", async () => {
    const id = await w.atStation("plan", "Question then send back");
    const att = await w.liveAttempt(id);
    await ask(id, "plan", att!.id);
    expect((await w.call("p-asha", "POST", `/api/v1/work-orders/${id}/send-back`, { toStation: "intake", note: "Start again from the brief" })).status).toBe(200);
    // The person answers the brief again and confirms it: the order runs its stations afresh.
    await w.answerAll(id);
    expect((await w.confirm(id)).status).toBe(200);
    const list2 = await waiting("p-tomas");
    const stale = list2.conversations.filter((c) => c.wo === id);
    expect(stale.some((c) => c.question === "Which currency should refunds use?"), "a question of a cancelled run is not offered again").toBe(false);
    expect((await w.q(`select status from wo_questions where wo_id = $1`, [id]))[0].status, "a question of a cancelled run is closed").not.toBe("open");
  });
});
