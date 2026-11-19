import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("round 5 people (S-46, S-47, S-48)", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(() => t.close());
  const w = world(() => t);

  it("S-46: a vote cast by a person who is deactivated before the gate passes still counts", async () => {
    const rule = { roles: ["reviewer", "approver", "line_lead", "release_manager", "project_admin"], people: [], required: 2, sod: true, conditions: [], escalateH: 0, fallback: null };
    expect((await w.call("p-daniel", "PUT", "/api/v1/projects/payments/approvers/G2", { value: rule })).status).toBe(200);
    const id = (await w.submit("p-meera", { title: "Leaver voted" })).body.id as string;
    await w.answerAll(id, "p-meera");
    expect((await w.confirm(id, "p-meera")).status).toBe(200);
    await w.walk(id, (x) => x.state === "waiting" && x.allowed.approve?.gate === "G2");
    const vote = async (who: string) => w.call(who, "POST", await w.gateUrl(id, "G2"), {});
    expect((await vote("p-priya")).body).toMatchObject({ passed: false, have: 1, need: 2 });
    // p-priya leaves the company: deactivated (admin, fresh sign-in, version, reason)
    const ver = (await w.q(`select version from people where id = 'p-priya'`))[0].version;
    const off = await w.call("p-asha", "POST", "/api/v1/people/p-priya/deactivate", { reason: "Left the company on Friday" }, { "if-match": String(ver) });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const second = await vote("p-kenji");
    expect(second.body.have, "the leaver's vote still counts toward 2 of 2").toBe(1);
    expect(second.body.passed).toBe(false);
    expect(second.body.leaverExcluded).toBe(true);
    expect(second.body.msg).toMatch(/a vote by someone who has left does not count/);
  });

  it("S-47/S-48: roles can be granted to a deactivated person at factory level but not at project level; offboarding lists no owned project", async () => {
    const ver = async (id: string) => String((await w.q(`select version from people where id = $1`, [id]))[0].version);
    const owned = (await w.q(`select id, owner_id from projects where owner_id = 'p-daniel'`));
    const off = await w.call("p-asha", "POST", "/api/v1/people/p-daniel/deactivate", { reason: "Left the company on Friday" }, { "if-match": await ver("p-daniel") });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const after = (await w.q(`select id, owner_id from projects where owner_id = 'p-daniel'`));
    expect(after, "offboarding does not reassign the owner").toEqual(owned);
    const admins = (await w.q(`select count(*)::int n from role_assignments ra join people p on p.id = ra.person_id where ra.project_id = 'payments' and ra.role_id = 'project_admin' and ra.revoked_at is null and p.status = 'active'`))[0].n;
    const fr = await w.call("p-asha", "PUT", "/api/v1/people/p-daniel/factory-roles/auditor", { reason: "Audit access for review" }, { "if-match": await ver("p-daniel") });
    const pr = await w.call("p-asha", "PUT", "/api/v1/projects/payments/members/p-daniel/roles/reviewer", {}, { "if-match": await ver("p-daniel") });
    expect(fr.status, "a factory role is granted to a deactivated person").toBe(422);
    expect(fr.body.msg).toMatch(/deactivated.*Reactivate/);
    expect(pr.status).toBe(422);
    // S-47: the response and the audit name the projects left without a Project Admin; the owner is not reassigned and the deactivation is not blocked.
    expect(off.body.projects, JSON.stringify(off.body.projects)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "payments", soleAdmin: expect.any(Boolean) })]));
    const left = (off.body.projectsWithoutAdmin as string[]).length;
    expect(left).toBe(off.body.projects.filter((x: { soleAdmin: boolean }) => x.soleAdmin).length);
    if (admins === 0) {
      expect(off.body.projectsWithoutAdmin).toContain("payments");
      expect(off.body.msg).toMatch(/no active Project Admin left/);
    }
    const audit = (await w.q(`select after from events where type = 'people.deactivate' and subject->>'id' = 'p-daniel' order by seq desc limit 1`))[0];
    expect(JSON.stringify(audit.after)).toContain("projects");
  });
});
