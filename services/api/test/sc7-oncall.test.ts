import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("sc7 on call", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());
  const w = world(() => t);

  it("O1: a person who lost every role on the project stays on call for it and can still hand it over", async () => {
    const roles = (await w.q(`select role_id, project_id from role_assignments where person_id = 'p-meera' and revoked_at is null`)) as Array<{ role_id: string; project_id: string | null }>;
    const put = await w.call("p-daniel", "PUT", "/api/v1/projects/payments/oncall", { people: ["p-meera"] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    let lastMsg = "";
    for (const r of roles.filter((x) => x.project_id === "payments")) {
      const del: any = await w.call("p-daniel", "DELETE", `/api/v1/projects/payments/members/p-meera/roles/${r.role_id}`);
      lastMsg = String(del.body.msg);
    }
    const list = (await w.q(`select config->'oncall' as o from projects where id = 'payments'`))[0].o;
    const hand = await w.call("p-meera", "POST", "/api/v1/projects/payments/oncall/handover", { to: "p-grace" });
    expect(lastMsg, "the response says the list is now empty").toMatch(/on-call list for .* is now empty/);
    expect(list, "a person with no role on the project is off its on-call list").not.toContain("p-meera");
    expect(hand.status, "a person with no role on the project cannot change who is on call").not.toBe(200);
    expect(list, "the list is empty now").toEqual([]);
  });
});
