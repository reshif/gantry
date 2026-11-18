import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("agent-led intake: a person's class is kept, children are not invented, the brief is editable (G-01)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);

  it("keeps the class the submitter chose, and says the keyword guess is only a guess", async () => {
    const r = await w.submit("p-tomas", { title: "Fix the rounding bug in refunds", requestedCls: "chore" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const wo = await w.get(r.body.id as string);
    expect(wo.cls).toBe("chore");
    expect(wo.clsRationale).toMatch(/Chosen by the submitter/);
    expect(wo.clsRationale).toMatch(/rule-based keyword match/i);
    expect(wo.conv.messages.every((m: { from: string }) => m.from === "system")).toBe(true);
  });

  it("an epic carries no invented split; a person edits scope and children with If-Match; stale and wrong-class edits are refused; the edit is audited and survives an answer", async () => {
    const id = (await w.submit("p-tomas", { title: "Three report jobs for the network team", requestedCls: "epic" })).body.id as string;
    const base = `/api/v1/work-orders/${id}`;
    const wo0 = await w.get(id);
    expect(wo0.brief.children).toEqual([]);
    expect(wo0.conv.questions.some((q: { id: string }) => q.id === "children")).toBe(false);

    const stale = await w.call("p-tomas", "PATCH", `${base}/brief`, { children: ["A: one"] }, w.ifm(wo0.version + 50));
    expect(stale.status).toBe(409);
    expect((await w.call("p-rui", "PATCH", `${base}/brief`, { children: ["A: one"] })).status).toBe(403);
    expect((await w.call("p-tomas", "PATCH", `${base}/brief`, {})).status).toBe(422);

    const ok = await w.call("p-tomas", "PATCH", `${base}/brief`, { children: ["Interfaces report: list interfaces by location", "Cables report: cable inventory"], scopeIn: ["Three read-only Nautobot jobs"] }, w.ifm(wo0.version));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const wo1 = await w.get(id);
    expect(wo1.brief.children).toEqual(["Interfaces report: list interfaces by location", "Cables report: cable inventory"]);
    expect(wo1.brief.scopeIn).toEqual(["Three read-only Nautobot jobs"]);
    const ev = await w.q(`select type, after, before from events where wo_id = $1 and type = 'wo.brief.edit'`, [id]);
    expect(ev.length).toBe(1);
    expect(ev[0].before).toBeTruthy();

    // A later scripted answer recomputes the brief; the person's edits stay.
    const ans = await w.call("p-tomas", "POST", `${base}/messages`, { text: "Only the jobs repo." });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    const wo2 = await w.get(id);
    expect(wo2.brief.children).toEqual(wo1.brief.children);
    expect(wo2.brief.scopeIn).toEqual(wo1.brief.scopeIn);

    // Children belong to an epic only.
    const bug = (await w.submit("p-tomas", { title: "Fix a typo", requestedCls: "bug" })).body.id as string;
    expect((await w.call("p-tomas", "PATCH", `/api/v1/work-orders/${bug}/brief`, { children: ["X: y"] })).status).toBe(422);
    // A credential in the brief is refused.
    expect((await w.call("p-tomas", "PATCH", `${base}/brief`, { scopeIn: ["password: hunter2hunter2"] })).status).toBe(422);
  });
});
