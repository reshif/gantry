import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
d("sc6 delegation", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ seedAudit: true }); });
  afterAll(() => t.close());
  const w = world(() => t);
  const rule = (over: Record<string, unknown> = {}) => ({ roles: [], people: ["p-meera"], required: 1, sod: true, conditions: [], escalateH: 0, fallback: null, ...over });
  const setRule = async (value: object) => { const r = await w.call("p-daniel", "PUT", `/api/v1/projects/payments/approvers/G2`, { value }); expect(r.status, JSON.stringify(r.body)).toBe(200); };
  const toG2 = async (title: string, who = "p-tomas") => {
    const sub = await w.submit(who, { title });
    const id = sub.body.id as string;
    await w.answerAll(id, who);
    expect((await w.confirm(id, who)).status).toBe(200);
    await w.walk(id, (x) => x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate === "G2");
    return id;
  };

  it("D1: a named approver and her own delegate both vote: one seat is counted twice", async () => {
    const id = await toG2("Delegation counts twice");
    await setRule(rule({ people: ["p-meera", "p-grace"], required: 2 })); // two named people; Priya is only Meera's delegate
    const url = await w.gateUrl(id, "G2");
    const a = await w.call("p-meera", "POST", url, {});
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.passed).toBe(false);
    const b = await w.call("p-priya", "POST", url, {});
    console.log("D1 delegate vote", b.status, JSON.stringify(b.body).slice(0, 200));
    const g = (await w.get(id)).gates.G2;
    console.log("D1 approvals", JSON.stringify(g.approvals));
    expect(b.status, "one seat is not counted twice").toBe(403);
    expect(String(b.body.msg)).toMatch(/seat counts once|already has a vote/);
    expect(g.approvals).toHaveLength(1);
    expect((await w.get(id)).gates.G2.status).toBe("waiting");
  });

  it("D1b: the stand-in votes first, the leaver is then refused, and the second seat completes the gate", async () => {
    const id = await toG2("Delegation seat filled by the stand-in");
    await setRule(rule({ people: ["p-meera", "p-grace"], required: 2 }));
    const url = await w.gateUrl(id, "G2");
    const a = await w.call("p-priya", "POST", url, {});
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.passed).toBe(false);
    const row = (await w.q(`select for_person from gate_votes where voter = 'p-priya' and gate_instance_id like $1`, [`${id}:G2:%`]))[0];
    expect(row.for_person).toBe("p-meera");
    const m = await w.call("p-meera", "POST", url, {});
    expect(m.status).toBe(403);
    const g = await w.call("p-grace", "POST", url, {});
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.passed).toBe(true);
  });

  it("D2: the author's own delegate approves the author's work order under separation of duties", async () => {
    const roles = (await t.db.admin.query(`select person_id, role_id, project_id from role_assignments where revoked_at is null and project_id = 'payments'`)).rows;
    console.log("payments roles", JSON.stringify(roles));
    // A line lead who can submit and approve is the author; the gate lists line leads with separation of duties on.
    const author = roles.find((r: any) => r.role_id === "line_lead")?.person_id as string;
    console.log("author", author);
    const id = await toG2("Delegate approves the author's order", author);
    await setRule({ roles: ["line_lead"], people: [], required: 1, sod: true, conditions: [], escalateH: 0, fallback: null });
    const url0 = await w.gateUrl(id, "G2");
    const own = await w.call(author, "POST", url0, {});
    console.log("D2 author direct", own.status, own.body.msg);
    expect(own.status).toBe(403);
    // the author names a reviewer (holds gate.approve, is not a line lead) as delegate: needs no right, no second person
    const rv = roles.find((r: any) => r.role_id === "reviewer" || r.role_id === "approver")?.person_id as string;
    const set = await w.call(author, "PUT", `/api/v1/people/${author}/away`, { away: { to: Date.now() + 86_400_000, delegate: rv } });
    console.log("D2 away", set.status, "delegate", rv);
    const b = await w.call(rv, "POST", url0, {});
    console.log("D2 delegate vote", b.status, JSON.stringify(b.body).slice(0, 200));
    expect(b.status, "the author's stand-in must not approve the author's own work").toBe(403);
    expect(String(b.body.msg)).toMatch(/Separation of duties/);
    const g = (await w.get(id)).gates.G2;
    expect(g.approvals ?? []).toHaveLength(0);
  });

  it("D3: leave start, loop A<->B and a chain A->B->C", async () => {
    const id = await toG2("Delegation loop");
    await setRule(rule({ people: ["p-meera", "p-grace"], required: 2, sod: true }));
    const set = (who: string, delegate: string) => w.call(who, "PUT", `/api/v1/people/${who}/away`, { away: { to: Date.now() + 86_400_000, delegate } });
    const r1 = await set("p-meera", "p-grace"); const r2 = await set("p-grace", "p-meera");
    console.log("D3 loop accepted", r1.status, r2.status);
    const self = await set("p-meera", "p-meera"); console.log("D3 self", self.status);
    const r3 = await set("p-meera", "p-rui"); // rui is a viewer
    const url = await w.gateUrl(id, "G2");
    const rui = await w.call("p-rui", "POST", url, {});
    console.log("D3 viewer-delegate", r3.status, rui.status, rui.body.msg);
    expect(rui.status).toBe(403);
  });
});
