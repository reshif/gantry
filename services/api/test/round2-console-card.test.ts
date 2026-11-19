import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
const ASHA = "p-asha";
const TOMAS = "p-tomas";

d("round 2: a console card confirms only the brief the person read (S-20)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const grant = async (role: string, rights: string[]) => {
    const cur = (await w.q(`select version, matrix from role_matrix_versions where org_id = $1 and published_at is not null order by version desc limit 1`, [t.orgId]))[0];
    const matrix = { ...cur.matrix, [role]: { ...cur.matrix[role], ...Object.fromEntries(rights.map((r) => [r, true])) } };
    await w.q(`insert into role_matrix_versions (org_id, version, matrix, note, published_at, published_by) values ($1,$2,$3::jsonb,'test-console', now(), 'test')`, [t.orgId, cur.version + 1, JSON.stringify(matrix)]);
  };

  it("an edit after the card was made turns the confirm into a 409; the same confirm on the unchanged brief works", async () => {
    const id = (await w.submit(TOMAS, { title: "Fix the rounding bug in refunds", requestedCls: "bug" })).body.id as string;
    await w.answerAll(id, TOMAS);
    await grant("engineer", ["console.use", "console.propose.approve_gate"]);
    const sess = await t.session(TOMAS);
    const propose = async () => {
      const r = await t.app.inject({ method: "POST", url: "/api/v1/console/tools/propose_approve_gate", headers: sess.headers, payload: { input: { wo: id } } });
      const j = r.json() as any; if (!j.proposals) throw new Error(r.body); return j.proposals[0];
    };
    const card = await propose();
    expect(card, "the console offers a card").toBeTruthy();
    expect(card.call.path).toMatch(/G0G1/);
    expect(typeof card.call.body.briefBase).toBe("string");
    const wo0 = await w.get(id);
    const edit = await w.call(TOMAS, "PATCH", `/api/v1/work-orders/${id}/brief`, { scopeIn: ["Only the refund rounding"] }, w.ifm(wo0.version));
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    // What the console does: the card's own call, no If-Match.
    const stale = await w.call(TOMAS, "POST", card.call.path, card.call.body);
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.msg).toMatch(/the brief changed since you read it/i);
    expect((await w.get(id)).state).not.toBe("running");
    const fresh = await propose();
    const ok = await w.call(TOMAS, "POST", fresh.call.path, fresh.call.body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    void ASHA;
  });
});
