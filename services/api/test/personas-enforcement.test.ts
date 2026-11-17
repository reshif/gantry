/**
 * Demo personas against REAL endpoints: the decision in can() is enforced server-side, denials are 403 with a reason and an audit event,
 * step-up and the two-person restore rule hold, delegation while away follows scope and expiry, on-call changes decisions.
 * Order matters: the stateful scenarios (stops, delegation, on-call) run last and put the org back as they found it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
let checks = 0;
const ok = <T>(v: T): T => (checks++, v);

d("demo personas: enforcement on real endpoints", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ seedAudit: true });
  });
  afterAll(() => {
    console.log(`personas-enforcement: ${checks} explicit persona checks`);
    return t.close();
  });
  const w = world(() => t);
  const denials = async (type: string, actor: string) => Number((await t.db.admin.query(`select count(*) n from events where type = $1 and actor = $2 and outcome = 'denied'`, [type, actor])).rows[0].n);

  /** The call must be refused 403 with a reason, and leave exactly one `<action>.denied` event for the actor. */
  const expectDenied = async (who: string, action: string, run: () => Promise<{ status: number; body: Record<string, any> }>, why?: RegExp) => {
    const before = await denials(`${action}.denied`, who);
    const r = await run();
    expect(r.status, `${who} ${action}: ${JSON.stringify(r.body)}`).toBe(403);
    expect(String(r.body.msg ?? ""), `${who} ${action} has a reason`).not.toBe("");
    if (why) expect(r.body.msg).toMatch(why);
    expect(await denials(`${action}.denied`, who), `${who} ${action} is audited`).toBe(before + 1);
    ok(0);
  };
  /** Passed the permission gate: anything but 401/403 (it may still fail validation or state, which is not a permission matter). */
  const expectReaches = (who: string, r: { status: number; body: Record<string, any> }) => {
    expect([401, 403], `${who}: ${JSON.stringify(r.body)}`).not.toContain(r.status);
    ok(0);
  };

  const submit = (who: string, project: string, repo: string) => w.submit(who, { title: `Persona check by ${who}`, repo }, project);
  const gate = (who: string, project: string, mode = "human") => w.call(who, "PATCH", `/api/v1/projects/${project}/config`, { gate: "G2", mode });
  const merge = (who: string, repo: string) => w.call(who, "POST", `/api/v1/repos/${repo}/onboarding/merge`, {});
  const matrixCell = (who: string, o: { authAgeSec?: number } = {}) => w.call(who, "PUT", "/api/v1/access/matrix/engineer/release", { on: false }, {}, o);
  const teams = (who: string) => w.call(who, "PUT", "/api/v1/people/p-tomas/teams", { teams: ["payments"] });
  const stop = (who: string, body: object, o: { authAgeSec?: number } = {}) => w.call(who, "POST", "/api/v1/stops", body, {}, o);
  const lift = (who: string, id: string) => w.call(who, "DELETE", `/api/v1/stops/${encodeURIComponent(id)}`);
  const restore = (who: string, id: string, o: { authAgeSec?: number } = {}) => w.call(who, "POST", `/api/v1/stops/${encodeURIComponent(id)}/restore`, { reason: "The incident is over" }, {}, o);
  const projectName = async (id: string) => (await t.db.admin.query(`select name from projects where id = $1`, [id])).rows[0].name as string;
  const me = async (who: string) => (await w.call(who, "GET", "/api/v1/me")).body;

  describe("Sam Whitfield, Auditor: reads everything, changes nothing", () => {
    const sam = "p-sam";
    it("reads the whole ledger, verifies the chain, sees every project", async () => {
      const a = await w.call(sam, "GET", "/api/v1/audit?limit=200");
      expect(a.status).toBe(200);
      expect(a.body.items.length).toBeGreaterThan(20);
      expect((await w.call(sam, "GET", "/api/v1/audit/verify")).status).toBe(200);
      const m = await me(sam);
      expect(m.projects.length).toBeGreaterThanOrEqual(10);
      ok(0);
    });
    it("is refused on every kind of change, with a reason and an audit event, and nothing is written", async () => {
      const writes = async () => Number((await t.db.admin.query(`select count(*) n from events where actor = $1 and coalesce(outcome,'ok') <> 'denied' and type not like 'auth.%'`, [sam])).rows[0].n);
      const before = await writes();
      await expectDenied(sam, "wo.submit", () => submit(sam, "payments", "payments-api"));
      await expectDenied(sam, "wo.submit", () => submit(sam, "storefront", "web-storefront"));
      await expectDenied(sam, "line.halt", () => stop(sam, { scope: "project", id: "payments", mode: "halt", reason: "Because I said so" }));
      await expectDenied(sam, "kill.factory", () => stop(sam, { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY" }));
      await expectDenied(sam, "project.config", () => gate(sam, "payments"));
      await expectDenied(sam, "onboarding.merge", () => merge(sam, "payments-api"));
      await expectDenied(sam, "policy.edit", () => matrixCell(sam));
      await expectDenied(sam, "people.manage", () => teams(sam));
      expect(await writes()).toBe(before);
    });
  });

  describe("Tomás Ferreira, Engineer on Payments Platform only", () => {
    const tomas = "p-tomas";
    it("submits on Payments, is refused on Storefront, Risk and Identity", async () => {
      expectReaches(tomas, await submit(tomas, "payments", "payments-api"));
      await expectDenied(tomas, "wo.submit", () => submit(tomas, "storefront", "web-storefront"));
      await expectDenied(tomas, "wo.submit", () => submit(tomas, "risk", "risk-models"));
      await expectDenied(tomas, "wo.submit", () => submit(tomas, "identity", "auth-gateway"));
    });
    it("cannot configure, merge onboarding, edit policy or people, even on Payments", async () => {
      await expectDenied(tomas, "project.config", () => gate(tomas, "payments"));
      await expectDenied(tomas, "onboarding.merge", () => merge(tomas, "payments-api"));
      await expectDenied(tomas, "policy.edit", () => matrixCell(tomas));
      await expectDenied(tomas, "people.manage", () => teams(tomas));
      await expectDenied(tomas, "kill.project", () => stop(tomas, { scope: "project", id: "payments", mode: "kill", reason: "Because I said so", confirmText: "Payments" }));
    });
    it("sees only Payments in the ledger and in /me", async () => {
      const m = await me(tomas);
      expect(m.projects.map((p: any) => p.id)).toEqual(["payments"]);
      const a = await w.call(tomas, "GET", "/api/v1/audit?limit=200");
      expect(a.status).toBe(200);
      // what he did himself is always visible (his refused attempts elsewhere); everything else is limited to his project
      const others = a.body.items.filter((e: any) => !/Tom/.test(String(e.actor)) && e.actor !== "p-tomas");
      expect(others.length).toBeGreaterThan(0);
      expect([...new Set(others.map((e: any) => e.project).filter(Boolean))]).toEqual(["payments"]);
      ok(0);
    });
    it("cannot open another project's floor", async () => {
      const r = await w.call(tomas, "GET", "/api/v1/projects/storefront/floor");
      expect([403, 404]).toContain(r.status);
      ok(0);
    });
  });

  describe("Fatima Zahra, Reviewer and Engineer on Storefront", () => {
    const fatima = "p-fatima";
    it("submits (engineer) on Storefront but not on Payments, Risk or Identity", async () => {
      expectReaches(fatima, await submit(fatima, "storefront", "web-storefront"));
      await expectDenied(fatima, "wo.submit", () => submit(fatima, "payments", "payments-api"));
      await expectDenied(fatima, "wo.submit", () => submit(fatima, "risk", "risk-models"));
    });
    it("cannot release, configure or merge on Storefront (reviewer and engineer do not carry them)", async () => {
      await expectDenied(fatima, "project.config", () => gate(fatima, "storefront"));
      await expectDenied(fatima, "onboarding.merge", () => merge(fatima, "web-storefront"));
    });
  });

  describe("Kenji Watanabe, Release Manager", () => {
    const kenji = "p-kenji";
    it("merges onboarding PRs on Payments, Storefront and Risk (passes the gate), but not on Identity or Search", async () => {
      for (const repo of ["payments-api", "web-storefront", "risk-models"]) expectReaches(kenji, await merge(kenji, repo));
      // a project he holds nothing in is not visible to him: refused (403) or hidden (404), never run
      for (const repo of ["auth-gateway", "search-api"]) {
        const r = await merge(kenji, repo);
        expect([403, 404], repo).toContain(r.status);
        ok(0);
      }
      expect((await w.q(`select 1 from events where type like 'onboarding.merge%' and actor = $1 and coalesce(outcome,'ok') <> 'denied' and subject->>'id' in ('auth-gateway','search-api')`, [kenji])).length).toBe(0);
    });
    it("cannot submit work or change configuration (release only)", async () => {
      await expectDenied(kenji, "wo.submit", () => submit(kenji, "payments", "payments-api"));
      await expectDenied(kenji, "project.config", () => gate(kenji, "payments"));
    });
    it("release is refused during an active freeze, whatever the window says", async () => {
      const s = await t.session(kenji);
      const r = await t.app.inject({ method: "POST", url: "/api/v1/can", headers: s.headers, payload: { checks: [{ action: "release", repo: "payouts-worker", time: Date.now() }] } });
      const x = r.json().results[0];
      expect(x.allowed).toBe(false);
      expect(x.reason).toMatch(/Freeze FRZ-07/);
      ok(0);
    });
  });

  describe("Priya Nair: Reviewer on Payments, Line Lead on Risk; the roles do not leak", () => {
    const priya = "p-priya";
    it("submits on Risk (line lead) but is refused on Payments (reviewer only) and Storefront", async () => {
      expectReaches(priya, await submit(priya, "risk", "risk-models"));
      await expectDenied(priya, "wo.submit", () => submit(priya, "payments", "payments-api"));
      await expectDenied(priya, "wo.submit", () => submit(priya, "storefront", "web-storefront"));
    });
    it("configures nothing on either project (line lead and reviewer lack project.config)", async () => {
      await expectDenied(priya, "project.config", () => gate(priya, "risk"));
      await expectDenied(priya, "project.config", () => gate(priya, "payments"));
    });
  });

  describe("Daniel Okafor, Project Admin on Payments and Storefront", () => {
    const daniel = "p-daniel";
    it("configures Payments and Storefront, not Risk or Identity", async () => {
      expectReaches(daniel, await gate(daniel, "payments"));
      expectReaches(daniel, await gate(daniel, "storefront"));
      await expectDenied(daniel, "project.config", () => gate(daniel, "risk"));
      await expectDenied(daniel, "project.config", () => gate(daniel, "identity"));
    });
    it("has no factory rights: people, policy and factory kill are refused", async () => {
      await expectDenied(daniel, "people.manage", () => teams(daniel));
      await expectDenied(daniel, "policy.edit", () => matrixCell(daniel));
      await expectDenied(daniel, "kill.factory", () => stop(daniel, { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY" }));
    });
    it("FINDING: a Project Admin reads the whole factory ledger (audit.view is a factory action and ignores the grant's project)", async () => {
      const a = await w.call(daniel, "GET", "/api/v1/audit?limit=200");
      expect(a.status).toBe(200);
      const projs = new Set(a.body.items.map((e: any) => e.project).filter(Boolean));
      // Daniel administers payments and storefront only, yet the ledger he reads covers more projects.
      expect(projs.size).toBeGreaterThan(2);
      ok(0);
    });
  });

  describe("Meera Iyer, Line Lead on Payments", () => {
    const meera = "p-meera";
    it("submits on Payments, is refused on Storefront, cannot change people or policy, cannot kill a project unless on call", async () => {
      expectReaches(meera, await submit(meera, "payments", "payments-api"));
      await expectDenied(meera, "wo.submit", () => submit(meera, "storefront", "web-storefront"));
      await expectDenied(meera, "people.manage", () => teams(meera));
      await expectDenied(meera, "policy.edit", () => matrixCell(meera));
      await expectDenied(meera, "kill.project", () => stop(meera, { scope: "project", id: "payments", mode: "kill", reason: "Bad release suspected", confirmText: "Payments Platform" }));
    });
  });

  describe("Lena Fischer, Project Admin on Identity", () => {
    const lena = "p-lena";
    it("configures Identity, not Payments", async () => {
      expectReaches(lena, await gate(lena, "identity"));
      await expectDenied(lena, "project.config", () => gate(lena, "payments"));
      await expectDenied(lena, "people.manage", () => teams(lena));
    });
  });

  describe("sensitive actions need a fresh sign-in (the card's MFA step)", () => {
    it("Asha: policy edit with an old sign-in is refused with the step-up reason and audited; fresh passes", async () => {
      const before = await denials("policy.edit.denied", "p-asha");
      const stale = await matrixCell("p-asha", { authAgeSec: 4000 });
      expect(stale.status).toBe(403);
      expect(stale.body.needs).toBe("step_up");
      expect(stale.body.rule).toMatchObject({ kind: "step-up" });
      expect(await denials("policy.edit.denied", "p-asha")).toBe(before + 1);
      expectReaches("p-asha", await matrixCell("p-asha"));
    });
    it("Omar, Daniel and Lena: kill with an old sign-in is refused with step_up, fresh is allowed on their own scope", async () => {
      const name = await projectName("identity");
      const stale = await stop("p-lena", { scope: "project", id: "identity", mode: "kill", reason: "Bad release suspected", confirmText: name }, { authAgeSec: 4000 });
      expect(stale.status).toBe(403);
      expect(stale.body.needs).toBe("step_up");
      const staleO = await stop("p-omar", { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY" }, { authAgeSec: 4000 });
      expect(staleO.status).toBe(403);
      expect(staleO.body.needs).toBe("step_up");
      const staleD = await stop("p-daniel", { scope: "project", id: "storefront", mode: "kill", reason: "Bad release suspected", confirmText: await projectName("storefront") }, { authAgeSec: 4000 });
      expect(staleD.status).toBe(403);
      expect(staleD.body.needs).toBe("step_up");
      ok(0);
    });
    it("a step-up beats nothing else: a person without the right gets the permission reason, not a step-up prompt", async () => {
      const r = await stop("p-tomas", { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY" }, { authAgeSec: 4000 });
      expect(r.status).toBe(403);
      expect(r.body.needs).not.toBe("step_up");
      ok(0);
    });
  });

  describe("factory restore needs two different Factory Admins (Asha and Omar)", () => {
    it("only Factory Admins can kill or restore the factory; Asha kills, a second admin is required to restore", async () => {
      const k = await stop("p-asha", { scope: "factory", mode: "kill", reason: "Credential leak suspected", confirmText: "KILL FACTORY", inFlight: "hold" });
      expect(k.status, JSON.stringify(k.body)).toBe(200);
      for (const who of ["p-daniel", "p-kenji", "p-sam", "p-meera", "p-tomas", "p-priya", "p-lena", "p-fatima"]) {
        await expectDenied(who, "restore.factory", () => restore(who, "factory:"));
      }
      const first = await restore("p-asha", "factory:");
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.pending).toBe(true);
      expect((await restore("p-asha", "factory:")).status).toBe(409); // the same admin cannot be both approvers
      const still = await w.call("p-tomas", "GET", "/api/v1/stops");
      expect(JSON.stringify(still.body)).toContain("factory");
      const second = await restore("p-omar", "factory:");
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.pending).toBe(false);
      const left = await w.q(`select 1 from stops where scope_type = 'factory' and lifted_at is null`);
      expect(left.length).toBe(0);
      ok(0);
    });
    it("a restore with an old sign-in is refused even for a Factory Admin", async () => {
      const k = await stop("p-omar", { scope: "factory", mode: "kill", reason: "Second drill of the day", confirmText: "KILL FACTORY", inFlight: "hold" });
      expect(k.status, JSON.stringify(k.body)).toBe(200);
      const stale = await restore("p-asha", "factory:", { authAgeSec: 4000 });
      expect(stale.status).toBe(403);
      expect(stale.body.needs).toBe("step_up");
      expect((await restore("p-omar", "factory:")).status).toBe(200);
      expect((await restore("p-asha", "factory:")).status).toBe(200);
      expect((await w.q(`select 1 from stops where scope_type = 'factory' and lifted_at is null`)).length).toBe(0);
    });
  });

  describe("project stops: who may halt, resume, kill and restore", () => {
    it("Tomás (engineer) may halt Payments but not resume it; Meera (line lead) resumes", async () => {
      const h = await stop("p-tomas", { scope: "project", id: "payments", mode: "halt", reason: "Flaky integration tests" });
      expect(h.status, JSON.stringify(h.body)).toBe(200);
      await expectDenied("p-tomas", "line.resume", () => lift("p-tomas", "project:payments"));
      expect((await lift("p-fatima", "project:payments")).status).toBe(404); // no role on Payments: the project does not reveal itself
      expect((await lift("p-meera", "project:payments")).status).toBe(200);
    });
    it("Tomás cannot halt Storefront (not his project)", async () => {
      // another project's id answers like an unknown one (no existence oracle)
      expect((await stop("p-tomas", { scope: "project", id: "storefront", mode: "halt", reason: "Flaky integration tests" })).status).toBe(404);
    });
    it("Lena (Project Admin, fresh sign-in) kills and restores Identity, and cannot touch Payments", async () => {
      const name = await projectName("identity");
      expect((await stop("p-lena", { scope: "project", id: "payments", mode: "kill", reason: "Bad release suspected", confirmText: "Payments Platform" })).status).toBe(404);
      const k = await stop("p-lena", { scope: "project", id: "identity", mode: "kill", reason: "Bad release suspected", confirmText: name, inFlight: "hold" });
      expect(k.status, JSON.stringify(k.body)).toBe(200);
      expect((await restore("p-lena", "project:identity")).status).toBe(200);
    });
  });

  describe("on call changes what a person may do (POL-103, POL-106)", () => {
    // On call is per project (owner decision 7): the project's admin (Asha here) sets the list.
    const setOncall = async (who: string, on: boolean, project: string) => {
      const row = (await w.q(`select version, coalesce(config -> 'oncall', '[]'::jsonb) as oncall from projects where id = $1`, [project]))[0];
      const cur = row.oncall as string[];
      const next = on ? [...new Set([...cur, who])] : cur.filter((x) => x !== who);
      return w.call("p-asha", "PUT", `/api/v1/projects/${project}/oncall`, { people: next }, { "if-match": String(row.version) });
    };
    const canNow = async (who: string, action: string, project: string, time = Date.UTC(2026, 10, 11, 5, 30)) => {
      const s = await t.session(who);
      const r = await t.app.inject({ method: "POST", url: "/api/v1/can", headers: s.headers, payload: { checks: [{ action, project, time }] } });
      return r.json().results[0] as { allowed: boolean; reason: string };
    };
    it("Lena on call may release Identity; off call she may not (POL-103 applies only on call)", async () => {
      expect((await canNow("p-lena", "release", "identity")).allowed).toBe(true);
      const off = await setOncall("p-lena", false, "identity");
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      const x = await canNow("p-lena", "release", "identity");
      expect(x.allowed).toBe(false);
      expect(x.reason).toMatch(/not on call/);
      expect((await setOncall("p-lena", true, "identity")).status).toBe(200);
      expect((await canNow("p-lena", "release", "identity")).allowed).toBe(true);
      ok(0);
    });
    it("Meera on call may kill her project (POL-106 extends kill.project to on-call line leads) but still not restore it", async () => {
      expect((await canNow("p-meera", "kill.project", "payments")).allowed).toBe(false);
      expect((await setOncall("p-meera", true, "payments")).status).toBe(200);
      expect((await canNow("p-meera", "kill.project", "payments")).allowed).toBe(true);
      expect((await canNow("p-meera", "restore.project", "payments")).allowed).toBe(false);
      expect((await canNow("p-meera", "kill.project", "storefront")).allowed).toBe(false); // on call on Payments only
      expect((await setOncall("p-meera", false, "payments")).status).toBe(200);
      expect((await canNow("p-meera", "kill.project", "payments")).allowed).toBe(false);
      ok(0);
    });
    it("nobody puts themselves on call, and only a project admin sets who is (project.members)", async () => {
      expect((await w.call("p-lena", "PUT", "/api/v1/people/p-lena/oncall", { on: true })).status).toBe(410);
      const v = (await w.q(`select version from projects where id = 'payments'`))[0].version;
      await expectDenied("p-tomas", "project.members", () => w.call("p-tomas", "PUT", "/api/v1/projects/payments/oncall", { people: ["p-tomas"] }, { "if-match": String(v) }));
    });
  });

  describe("Meera is away: approvals route to Priya as her delegate, within scope and expiry", () => {
    const rule = (over: Record<string, unknown> = {}) => ({ roles: [], people: ["p-meera"], required: 1, sod: true, conditions: [], escalateH: 0, fallback: null, ...over });
    let wo = "";
    let gateId = "";
    const setRule = async (value: object) => {
      const r = await w.call("p-daniel", "PUT", `/api/v1/projects/payments/approvers/${gateId}`, { value });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    const allowedFor = async (who: string) => (await w.get(wo, who)).allowed.approve as { gate: string; allowed: boolean; reason?: string };
    beforeAll(async () => {
      const sub = await w.submit("p-tomas", { title: "Delegation check" });
      wo = sub.body.id as string;
      await w.answerAll(wo, "p-tomas");
      expect((await w.confirm(wo, "p-tomas")).status).toBe(200);
      const at = await w.walk(wo, (x) => x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate === "G2");
      gateId = at.allowed.approve.gate;
      await setRule(rule());
    });
    it("the seed has Meera away now with Priya as delegate", async () => {
      const p = (await w.q(`select away from people where id = 'p-meera'`))[0].away;
      expect(p.delegate).toBe("p-priya");
      expect(p.to).toBeGreaterThan(Date.now());
      expect(p.from).toBeLessThanOrEqual(Date.now());
    });
    it("while Meera is away, a gate that names only Meera is approvable by Priya, and by nobody else without the rule", async () => {
      expect((await allowedFor("p-priya")).allowed).toBe(true);
      expect((await allowedFor("p-meera")).allowed).toBe(true); // she is named; being away does not strip her right
      expect((await allowedFor("p-grace")).allowed).toBe(false); // approver on Payments by matrix, not by this rule
      expect((await allowedFor("p-tomas")).allowed).toBe(false);
      ok(0);
    });
    it("the delegation covers only Meera's own approvals: a rule naming someone else is not approvable by Priya", async () => {
      await setRule(rule({ people: ["p-grace"] }));
      expect((await allowedFor("p-priya")).allowed).toBe(false);
      await setRule(rule());
      expect((await allowedFor("p-priya")).allowed).toBe(true);
    });
    it("an expired away window ends the delegation, and coming back ends it", async () => {
      const original = (await w.q(`select away from people where id = 'p-meera'`))[0].away;
      await t.db.admin.query(`update people set away = $1::jsonb where id = 'p-meera'`, [JSON.stringify({ ...original, from: Date.now() - 4 * 86_400_000, to: Date.now() - 1000 })]);
      expect((await allowedFor("p-priya")).allowed).toBe(false);
      await t.db.admin.query(`update people set away = null where id = 'p-meera'`);
      expect((await allowedFor("p-priya")).allowed).toBe(false);
      await t.db.admin.query(`update people set away = $1::jsonb where id = 'p-meera'`, [JSON.stringify(original)]);
      expect((await allowedFor("p-priya")).allowed).toBe(true);
      ok(0);
    });
    it("Priya's approval is accepted for real and Rui (a viewer) is refused with the audit trail", async () => {
      await expectDenied("p-rui", "gate.approve", () => w.call("p-rui", "POST", `/api/v1/gate-instances/${encodeURIComponent(`${wo}:${gateId}`)}/approve`, {}));
      const a = await w.call("p-priya", "POST", `/api/v1/gate-instances/${encodeURIComponent(`${wo}:${gateId}`)}/approve`, {});
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.passed).toBe(true);
    });
    it("Fatima (Storefront reviewer) cannot approve a Payments gate; Tomás cannot approve his own", async () => {
      const sub = await w.submit("p-tomas", { title: "Cross-project approval check" });
      const id = sub.body.id as string;
      await w.answerAll(id, "p-tomas");
      expect((await w.confirm(id, "p-tomas")).status).toBe(200);
      await w.walk(id, (x) => x.state === "waiting" && !!x.allowed.approve && x.allowed.approve.gate === "G2");
      await setRule({ roles: ["reviewer", "approver", "line_lead", "release_manager", "project_admin"], people: [], required: 2, sod: true, conditions: [], escalateH: 0, fallback: null });
      const url = `/api/v1/gate-instances/${encodeURIComponent(`${id}:G2`)}/approve`;
      const hidden = await w.call("p-fatima", "POST", url, {}); // a Payments work order is not even visible to Fatima
      expect([403, 404]).toContain(hidden.status);
      expect((await w.get(id)).gates.G2.approvals ?? []).toHaveLength(0);
      await expectDenied("p-tomas", "gate.approve", () => w.call("p-tomas", "POST", url, {}));
      await expectDenied("p-sam", "gate.approve", () => w.call("p-sam", "POST", url, {}));
    });
  });
});
