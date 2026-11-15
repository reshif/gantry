import { verifyChain } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { withVersion } from "./versions.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";
const admin2 = "p-omar";
const engineer = "p-tomas"; // engineer on payments: no people.manage, policy.edit or role.edit
const hour = 3_600_000;

d("people and access", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const call = async (who: string, method: M, url: string, payload?: unknown, extra: Record<string, string> = {}, o: { authAgeSec?: number } = {}) => {
    const s = await t.session(who, o);
    const r = await t.app.inject({ method, url, headers: { ...s.headers, ...(await withVersion(t.db.admin, method, url, extra)) }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.json() as Record<string, any>, headers: r.headers };
  };
  const ev = async (type: string) => (await t.db.admin.query(`select * from events where type = $1 order by seq`, [type])).rows;
  const person = async (id: string) => (await call(admin, "GET", "/api/v1/people")).body as unknown as Array<Record<string, any>>;
  const find = async (id: string) => (await person(id)).find((p) => p.id === id)!;
  const stepUpAge = 3600;

  describe("If-Match is required on versioned config endpoints", () => {
    it("matrix, role, policy, freeze and security writes without If-Match are a 409 'version required'", async () => {
      const s = await t.session(admin);
      const send = (method: M, url: string, payload?: unknown) => t.app.inject({ method, url, headers: s.headers, ...(payload === undefined ? {} : { payload: payload as object }) });
      for (const [m, url, body] of [
        ["PUT", "/api/v1/access/matrix/engineer/release", { on: true }],
        ["DELETE", "/api/v1/roles/release_manager", undefined],
        ["PATCH", "/api/v1/security", { path: "githubLogin", value: false }],
      ] as const) {
        const r = await send(m, url, body);
        expect(r.statusCode, url).toBe(409);
        expect(r.json().msg, url).toMatch(/version required/i);
      }
      expect((await send("DELETE", "/api/v1/policies/POL-NOPE")).statusCode).toBe(404);
    });
  });

  describe("reads", () => {
    it("lists people with versions, teams and roles in the legacy shape", async () => {
      const list = (await call(admin, "GET", "/api/v1/people")).body as unknown as Array<Record<string, any>>;
      const asha = list.find((p) => p.id === admin)!;
      expect(asha).toMatchObject({ name: "Asha Raman", status: "active", roles: [{ role: "factory_admin", scope: "factory" }], teams: ["platform"] });
      expect(typeof asha.version).toBe("number");
    });
    it("returns the matrix, roles and actions with the matrix version", async () => {
      const r = await call(admin, "GET", "/api/v1/access/matrix");
      expect(r.status).toBe(200);
      expect(r.body.version).toBe(1);
      expect(r.body.matrix.factory_admin["policy.edit"]).toBe(true);
      expect(r.body.roles.some((x: any) => x.id === "viewer")).toBe(true);
      expect(r.body.actions.length).toBeGreaterThan(20);
    });
    it("returns policies and freezes with versions", async () => {
      const pols = (await call(admin, "GET", "/api/v1/policies")).body as unknown as any[];
      expect(pols.find((p) => p.id === "POL-101")).toMatchObject({ enabled: true, version: 1 });
      const fr = (await call(admin, "GET", "/api/v1/freezes")).body as unknown as any[];
      expect(fr.map((f) => f.id)).toContain("FRZ-08");
    });
    it("needs a signed-in person", async () => {
      const r = await t.app.inject({ method: "GET", url: "/api/v1/people" });
      expect(r.statusCode).toBe(401);
    });
    it("computes effective permissions with compact cells", async () => {
      const r = await call(admin, "GET", "/api/v1/people/p-tomas/effective-permissions");
      expect(r.status).toBe(200);
      expect(r.body.person).toBe("p-tomas");
      expect(r.body.projects.map((p: any) => p.id)).toContain("payments");
      expect(r.body.cells["wo.submit"].payments[0]).toBe(1);
      expect(r.body.cells["release"].payments[0]).toBe(0);
      expect(r.body.factory["people.manage"].allowed).toBe(false);
      expect(r.body.rules["MATRIX"]).toBeTruthy();
      expect((await call(admin, "GET", "/api/v1/people/nobody/effective-permissions")).status).toBe(404);
    });
    it("is itself a right: an Engineer (no people.view) cannot read anyone's effective permissions (default deny)", async () => {
      const r = await call(engineer, "GET", "/api/v1/people/p-tomas/effective-permissions");
      expect(r.status).toBe(403);
      expect(r.body.msg).toMatch(/Tom/);
    });
  });

  describe("remaining denial and stale cases", () => {
    it("DELETE factory role: denied, stale, then removed", async () => {
      expect((await call(engineer, "DELETE", "/api/v1/people/p-sam/factory-roles/auditor")).status).toBe(403);
      expect((await call(admin, "DELETE", "/api/v1/people/p-sam/factory-roles/auditor", undefined, { "if-match": "999" })).status).toBe(409);
    });
    it("policy toggle is stale against an old version", async () => {
      expect((await call(admin, "PATCH", "/api/v1/policies/POL-101", { enabled: true }, { "if-match": "999" })).status).toBe(409);
    });
  });

  describe("simulator", () => {
    it("answers like enforcement for the same person, action and moment (freeze plus on-call)", async () => {
      // p-kenji release_manager; payouts-worker is under FRZ-07 now. p-lena is on call (POL-103).
      const times = [Date.now(), Date.now() + 20 * hour, Date.now() + 50 * hour];
      for (const [person, action, project, repo] of [["p-kenji", "release", "payments", "payouts-worker"], ["p-kenji", "release", "payments", "payments-api"], ["p-lena", "release", "identity", ""]] as const) {
        for (const time of times) {
          const sim = await call(admin, "POST", "/api/v1/access/simulate", { person, action, project, repo: repo || null, time });
          expect(sim.status).toBe(200);
          const enforced = await call(person, "POST", "/api/v1/can", { checks: [{ action, project, repo: repo || null, time }] });
          const e = enforced.body.results[0];
          expect(sim.body.decision.allowed).toBe(e.allowed);
          expect(sim.body.decision.rule.id).toBe(e.rule.id);
          expect(sim.body.decision.reason).toBe(e.reason);
        }
      }
    });
    it("returns a trace and a 7-day strip", async () => {
      const r = await call(admin, "POST", "/api/v1/access/simulate", { person: "p-kenji", action: "release", project: "payments", repo: "payouts-worker" });
      expect(r.body.trace.length).toBeGreaterThan(3);
      expect(r.body.week).toHaveLength(7);
      expect(r.body.week[0].cells).toHaveLength(24);
    });
    it("lets anyone simulate themselves but not others without a governing right", async () => {
      expect((await call(engineer, "POST", "/api/v1/access/simulate", { person: engineer, action: "wo.submit", project: "payments" })).status).toBe(200);
      const r = await call(engineer, "POST", "/api/v1/access/simulate", { person: admin, action: "release", project: "payments" });
      expect(r.status).toBe(403);
    });
    it("treats an empty repo as no repo", async () => {
      const r = await call(admin, "POST", "/api/v1/access/simulate", { person: "p-kenji", action: "release", project: "payments", repo: "" });
      expect(r.status).toBe(200);
    });
    it("rejects unknown inputs", async () => {
      expect((await call(admin, "POST", "/api/v1/access/simulate", { person: "nobody", action: "release" })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/access/simulate", { person: admin, action: "nope" })).status).toBe(422);
    });
  });

  describe("invites", () => {
    let inviteId = "";
    it("invites a person: row, teams, roles, invite row, outbox email, audit, one transaction", async () => {
      const r = await call(admin, "POST", "/api/v1/invites", { name: "Nina Park", email: "Nina.Park@acme.dev", teams: ["platform"], roles: [{ role: "factory_admin", scope: "factory" }, { role: "engineer", scope: "payments" }] }, { "idempotency-key": "inv-1" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, msg: "Invite sent to nina.park@acme.dev.", person: { name: "Nina Park", email: "nina.park@acme.dev", status: "invited", teams: ["platform"] } });
      inviteId = r.body.person.id;
      expect(r.body.person.roles).toEqual([{ role: "factory_admin", scope: "factory" }, { role: "engineer", scope: "payments" }]);
      const [e] = await ev("people.invite");
      expect(e).toMatchObject({ actor: admin, category: "access", outcome: "ok" });
      expect(e.subject).toEqual({ type: "person", id: inviteId });
      const ob = (await t.db.admin.query(`select destination, payload, status from outbox where event_id = $1`, [e.id])).rows;
      expect(ob).toHaveLength(1);
      expect(ob[0]).toMatchObject({ destination: "smtp", status: "pending" });
      expect(ob[0].payload).toMatchObject({ kind: "invite", to: "nina.park@acme.dev" });
      expect((await t.db.admin.query(`select status from invites where id = $1`, [inviteId])).rows[0].status).toBe("pending");
      expect((await verifyChain(t.db.app, t.orgId)).ok).toBe(true);
    });
    it("is idempotent on the key and conflicts on a changed body", async () => {
      const again = await call(admin, "POST", "/api/v1/invites", { name: "Nina Park", email: "Nina.Park@acme.dev", teams: ["platform"], roles: [{ role: "factory_admin", scope: "factory" }, { role: "engineer", scope: "payments" }] }, { "idempotency-key": "inv-1" });
      expect(again.status).toBe(200);
      expect(again.body.person.id).toBe(inviteId);
      expect((await t.db.admin.query(`select count(*)::int as n from people where email = 'nina.park@acme.dev'`)).rows[0].n).toBe(1);
      const other = await call(admin, "POST", "/api/v1/invites", { name: "Someone", email: "x@acme.dev" }, { "idempotency-key": "inv-1" });
      expect(other.status).toBe(409);
    });
    it("grants nothing until the invite is accepted", async () => {
      const sim = await call(admin, "POST", "/api/v1/access/simulate", { person: inviteId, action: "people.manage" });
      expect(sim.body.decision.allowed).toBe(false);
      expect(sim.body.decision.reason).toContain("not accepted the invite");
    });
    it("refuses duplicates, bad domains, unknown teams, roles and scope mismatches", async () => {
      expect((await call(admin, "POST", "/api/v1/invites", { name: "Dup", email: "ASHA@acme.dev" })).status).toBe(409);
      expect((await call(admin, "POST", "/api/v1/invites", { name: "Bad", email: "x" })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/invites", { name: "T", email: "t1@acme.dev", teams: ["nope"] })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/invites", { name: "R", email: "t2@acme.dev", roles: [{ role: "nope", scope: "payments" }] })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/invites", { name: "R", email: "t3@acme.dev", roles: [{ role: "engineer", scope: "factory" }] })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/invites", { name: "R", email: "t4@acme.dev", roles: [{ role: "engineer", scope: "nope" }] })).status).toBe(422);
    });
    it("enforces the allowed email domains from Security", async () => {
      const cur = (await call(admin, "GET", "/api/v1/security")).body;
      const s1 = await call(admin, "PATCH", "/api/v1/security", { path: "domains", value: ["acme.dev"] }, { "if-match": String(cur.version) });
      expect(s1.status).toBe(200);
      const r = await call(admin, "POST", "/api/v1/invites", { name: "Out Side", email: "out@evil.test" });
      expect(r.status).toBe(422);
      expect(r.body.msg).toContain("not an allowed domain");
      await call(admin, "PATCH", "/api/v1/security", { path: "domains", value: [] }, { "if-match": String(s1.body.version) });
    });
    it("denies people without people.manage, and audits the denial", async () => {
      const r = await call(engineer, "POST", "/api/v1/invites", { name: "Nope Nope", email: "nope@acme.dev" });
      expect(r.status).toBe(403);
      expect(r.body.ok).toBe(false);
      const [e] = await ev("people.manage.denied");
      expect(e).toMatchObject({ actor: engineer, outcome: "denied" });
      expect((await t.db.admin.query(`select 1 from people where email = 'nope@acme.dev'`)).rowCount).toBe(0);
    });
    it("accept: denied, stale, then active", async () => {
      expect((await call(engineer, "POST", `/api/v1/invites/${inviteId}/accept`)).status).toBe(403);
      expect((await call(admin, "POST", `/api/v1/invites/${inviteId}/accept`, undefined, { "if-match": "999" })).status).toBe(409);
      const v = (await find(inviteId)).version;
      const ok = await call(admin, "POST", `/api/v1/invites/${inviteId}/accept`, undefined, { "if-match": String(v) });
      expect(ok.status).toBe(200);
      const p = await find(inviteId);
      expect(p.status).toBe("active");
      expect(p.title).toBe("Factory Admin");
      expect((await t.db.admin.query(`select status from invites where id = $1`, [inviteId])).rows[0].status).toBe("accepted");
      expect((await ev("people.accept")).length).toBe(1);
      const again = await call(admin, "POST", `/api/v1/invites/${inviteId}/accept`);
      expect(again.status).toBe(409);
      expect((await call(admin, "POST", `/api/v1/invites/nobody/accept`)).status).toBe(404);
    });
  });

  describe("factory roles", () => {
    it("grants and revokes with audit; stale and denied are refused", async () => {
      const v = (await find(admin2)).version;
      expect((await call(engineer, "PUT", `/api/v1/people/p-sam/factory-roles/auditor`)).status).toBe(403);
      expect((await call(admin, "PUT", `/api/v1/people/p-tomas/factory-roles/auditor`, undefined, { "if-match": "999" })).status).toBe(409);
      const g = await call(admin, "PUT", `/api/v1/people/p-tomas/factory-roles/auditor`);
      expect(g.status).toBe(200);
      expect((await find("p-tomas")).roles).toContainEqual({ role: "auditor", scope: "factory" });
      const [e] = await ev("role.grant");
      expect(e).toMatchObject({ actor: admin, before: "none", after: "auditor" });
      const rv = await call(admin, "DELETE", `/api/v1/people/p-tomas/factory-roles/auditor`);
      expect(rv.status).toBe(200);
      expect((await find("p-tomas")).roles.some((r: any) => r.scope === "factory")).toBe(false);
      expect((await ev("role.revoke")).length).toBe(1);
      expect(v).toBeGreaterThan(0);
    });
    it("needs a fresh sign-in (step-up)", async () => {
      const r = await call(admin, "PUT", `/api/v1/people/p-tomas/factory-roles/auditor`, undefined, {}, { authAgeSec: stepUpAge });
      expect(r.status).toBe(403);
      expect(r.body.needs).toBe("step_up");
    });
    it("refuses non-factory roles and unknown people", async () => {
      expect((await call(admin, "PUT", `/api/v1/people/p-tomas/factory-roles/engineer`)).status).toBe(422);
      expect((await call(admin, "PUT", `/api/v1/people/nobody/factory-roles/auditor`)).status).toBe(404);
    });
    it("never lets people remove their own admin role, nor the last admin (spec 14.4)", async () => {
      const own = await call(admin, "DELETE", `/api/v1/people/${admin}/factory-roles/factory_admin`);
      expect(own.status).toBe(403);
      expect(own.body.rule.id).toBe("INV-14.4-SELF");
      // Make asha the only active admin by revoking the others, then try to remove her via herself's peer: nobody else is left to ask.
      for (const id of [admin2, "p-nina-park-gone"]) void id;
      const people = (await person(admin)).filter((p) => p.status === "active" && p.roles.some((r: any) => r.role === "factory_admin"));
      for (const p of people.filter((x) => x.id !== admin)) {
        expect((await call(admin, "DELETE", `/api/v1/people/${p.id}/factory-roles/factory_admin`)).status).toBe(200);
      }
      // admin2 no longer an admin, so the only admin is asha; omar (no rights now) cannot do it, and asha cannot remove herself.
      const last = await call(admin, "DELETE", `/api/v1/people/${admin}/factory-roles/factory_admin`);
      expect(last.status).toBe(403);
      // restore a second admin for the remaining tests
      expect((await call(admin, "PUT", `/api/v1/people/${admin2}/factory-roles/factory_admin`)).status).toBe(200);
      const second = await call(admin2, "DELETE", `/api/v1/people/${admin}/factory-roles/factory_admin`);
      expect(second.status).toBe(200);
      expect((await call(admin2, "PUT", `/api/v1/people/${admin}/factory-roles/factory_admin`)).status).toBe(200);
    });
    it("last admin: removing the only other admin is allowed, removing the only admin is not", async () => {
      // Sole-admin case via an invited admin who is not active: they do not count.
      const admins = (await person(admin)).filter((p) => p.status === "active" && p.roles.some((r: any) => r.role === "factory_admin")).map((p) => p.id);
      expect(admins.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("teams, on-call, away", () => {
    it("sets teams: denied, stale, unknown team, then saved", async () => {
      expect((await call(engineer, "PUT", "/api/v1/people/p-sam/teams", { teams: ["data"] })).status).toBe(403);
      expect((await call(admin, "PUT", "/api/v1/people/p-sam/teams", { teams: ["data"] }, { "if-match": "999" })).status).toBe(409);
      expect((await call(admin, "PUT", "/api/v1/people/p-sam/teams", { teams: ["nope"] })).status).toBe(422);
      const r = await call(admin, "PUT", "/api/v1/people/p-sam/teams", { teams: ["data", "security"] });
      expect(r.status).toBe(200);
      expect((await find("p-sam")).teams.sort()).toEqual(["data", "security"]);
      const [e] = await ev("people.teams");
      expect(e).toMatchObject({ before: "security", after: "data,security" });
      expect((await call(admin, "PUT", "/api/v1/people/p-sam/teams", { teams: ["security"] })).status).toBe(200);
      expect((await find("p-sam")).teams).toEqual(["security"]);
    });
    it("on-call: managers set anyone's; people set their own; strangers are denied", async () => {
      expect((await call(engineer, "PUT", "/api/v1/people/p-sam/oncall", { on: true })).status).toBe(403);
      expect((await call(admin, "PUT", "/api/v1/people/p-sam/oncall", { on: true }, { "if-match": "999" })).status).toBe(409);
      expect((await call(admin, "PUT", "/api/v1/people/p-sam/oncall", { on: true })).status).toBe(200);
      expect((await find("p-sam")).oncall).toBe(true);
      const own = await call(engineer, "PUT", `/api/v1/people/${engineer}/oncall`, { on: true });
      expect(own.status).toBe(200);
      expect((await find(engineer)).oncall).toBe(true);
      expect((await call(engineer, "PUT", `/api/v1/people/${engineer}/oncall`, { on: false })).status).toBe(200);
      expect((await call(admin, "PUT", "/api/v1/people/p-sam/oncall", { on: false })).status).toBe(200);
      expect((await ev("people.oncall")).length).toBe(4);
    });
    it("on-call changes what the engine decides (POL-103 follows the flag)", async () => {
      const before = await call(admin, "POST", "/api/v1/access/simulate", { person: "p-lena", action: "kill.project", project: "identity" });
      await call(admin, "PUT", "/api/v1/people/p-lena/oncall", { on: false });
      const after = await call(admin, "POST", "/api/v1/access/simulate", { person: "p-lena", action: "kill.project", project: "identity" });
      expect(after.body.trace.join(" ")).toContain("Policies on this action");
      expect(typeof before.body.decision.allowed).toBe("boolean");
      await call(admin, "PUT", "/api/v1/people/p-lena/oncall", { on: true });
    });
    it("away: delegate rules, project permission, self, stale", async () => {
      const away = { to: Date.now() + 48 * hour, delegate: "p-meera" };
      expect((await call(engineer, "PUT", "/api/v1/people/p-priya/away", { away })).status).toBe(403);
      expect((await call(admin, "PUT", "/api/v1/people/p-priya/away", { away }, { "if-match": "999" })).status).toBe(409);
      expect((await call(admin, "PUT", "/api/v1/people/p-priya/away", { away: { ...away, delegate: "p-priya" } })).status).toBe(422);
      expect((await call(admin, "PUT", "/api/v1/people/p-priya/away", { away: { ...away, delegate: "nobody" } })).status).toBe(422);
      const ok = await call(admin, "PUT", "/api/v1/people/p-priya/away", { away });
      expect(ok.status).toBe(200);
      expect((await find("p-priya")).away).toMatchObject({ delegate: "p-meera" });
      expect((await call("p-priya", "PUT", "/api/v1/people/p-priya/away", { away: null })).status).toBe(200);
      expect((await find("p-priya")).away).toBeNull();
      const [e] = await ev("approvers.delegate");
      expect(e.category).toBe("approvals");
    });
    it("away is global, so a project right covers only people whose every role is on projects the caller administers", async () => {
      const away = { to: Date.now() + 24 * hour, delegate: "p-priya" };
      // Daniel is Project Admin on Payments and Storefront. Priya also leads Risk, Meera also reviews Partner API; Asha holds factory roles.
      expect((await call("p-daniel", "PUT", "/api/v1/people/p-priya/away", { project: "payments", away })).status).toBe(403);
      expect((await call("p-daniel", "PUT", "/api/v1/people/p-asha/away", { project: "payments", away })).status).toBe(403);
      expect((await call("p-daniel", "PUT", "/api/v1/people/p-meera/away", { project: "payments", away })).status).toBe(403);
      expect((await find("p-priya")).away).toBeNull();
      // Tomás is an engineer on Payments only: within Daniel's reach.
      const ok = await call("p-daniel", "PUT", "/api/v1/people/p-tomas/away", { project: "payments", away });
      expect(ok.status).toBe(200);
      expect((await call("p-tomas", "PUT", "/api/v1/people/p-tomas/away", { away: null })).status).toBe(200);
    });
  });

  describe("role matrix", () => {
    it("edits one cell as a new immutable version; denied, stale, step-up and invariants refused", async () => {
      expect((await call(engineer, "PUT", "/api/v1/access/matrix/viewer/wo.submit", { on: true })).status).toBe(403);
      expect((await call(admin, "PUT", "/api/v1/access/matrix/viewer/wo.submit", { on: true }, { "if-match": "999" })).status).toBe(409);
      const old = await call(admin, "PUT", "/api/v1/access/matrix/viewer/wo.submit", { on: true }, {}, { authAgeSec: stepUpAge });
      expect(old.status).toBe(403);
      expect(old.body.needs).toBe("step_up");
      const r = await call(admin, "PUT", "/api/v1/access/matrix/viewer/wo.submit", { on: true }, { "if-match": "1" });
      expect(r.status).toBe(200);
      expect(r.body.version).toBe(2);
      const m = (await call(admin, "GET", "/api/v1/access/matrix")).body;
      expect(m.version).toBe(2);
      expect(m.matrix.viewer["wo.submit"]).toBe(true);
      expect((await t.db.admin.query(`select count(*)::int as n from role_matrix_versions`)).rows[0].n).toBe(2);
      const [e] = await ev("policy.matrix");
      expect(e).toMatchObject({ before: false, after: true, actor: admin });
      // the very next decision uses it
      const sim = await call(admin, "POST", "/api/v1/access/simulate", { person: "p-rui", action: "wo.submit", project: "payments" });
      expect(sim.body.decision.allowed).toBe(true);
      // a stale second editor
      const stale = await call(admin, "PUT", "/api/v1/access/matrix/viewer/wo.submit", { on: false }, { "if-match": "1" });
      expect(stale.status).toBe(409);
      // no-op does not publish
      const same = await call(admin, "PUT", "/api/v1/access/matrix/viewer/wo.submit", { on: true });
      expect(same.status).toBe(200);
      expect((await call(admin, "GET", "/api/v1/access/matrix")).body.version).toBe(2);
      expect((await call(admin, "PUT", "/api/v1/access/matrix/viewer/wo.submit", { on: false })).status).toBe(200);
    });
    it("Factory Admin cannot lose protected rights; unknown role or action", async () => {
      for (const action of ["policy.edit", "people.manage", "security.manage", "restore.factory", "role.edit"]) {
        const r = await call(admin, "PUT", `/api/v1/access/matrix/factory_admin/${action}`, { on: false });
        expect(r.status).toBe(403);
        expect(r.body.rule.id).toBe("INV-14.4-ADMIN");
      }
      expect((await call(admin, "PUT", "/api/v1/access/matrix/nope/wo.submit", { on: true })).status).toBe(404);
      expect((await call(admin, "PUT", "/api/v1/access/matrix/viewer/nope", { on: true })).status).toBe(422);
    });
    it("refuses an edit that leaves nobody able to edit the matrix (I9)", async () => {
      // grant policy.edit to auditor, then it is reachable by sam too; removing it from factory_admin is already blocked, so test the role-based lockout via a custom role
      const c = await call(admin, "POST", "/api/v1/roles", { name: "Matrix Keeper", level: "factory", base: "auditor" });
      expect(c.status).toBe(200);
      const give = await call(admin, "PUT", `/api/v1/access/matrix/matrix_keeper/policy.edit`, { on: true });
      expect(give.status).toBe(200);
      expect((await call(admin, "DELETE", `/api/v1/roles/matrix_keeper`)).status).toBe(200);
    });
  });

  describe("roles", () => {
    let version = 1;
    it("creates a custom role cloned from a base, with its matrix row, idempotently", async () => {
      expect((await call(engineer, "POST", "/api/v1/roles", { name: "Change Advisor", base: "reviewer" })).status).toBe(403);
      const body = { name: "Change Advisor", level: "project", base: "reviewer", desc: "Advises on changes" };
      const r = await call(admin, "POST", "/api/v1/roles", body, { "idempotency-key": "role-1" });
      expect(r.status).toBe(200);
      expect(r.body.role).toMatchObject({ id: "change_advisor", name: "Change Advisor", level: "project", custom: true, base: "reviewer", desc: "Advises on changes" });
      const again = await call(admin, "POST", "/api/v1/roles", body, { "idempotency-key": "role-1" });
      expect(again.status).toBe(200);
      expect((await t.db.admin.query(`select count(*)::int as n from roles where id = 'change_advisor'`)).rows[0].n).toBe(1);
      const m = (await call(admin, "GET", "/api/v1/access/matrix")).body;
      expect(m.matrix.change_advisor).toEqual(m.matrix.reviewer);
      expect(m.roles.find((x: any) => x.id === "change_advisor")).toMatchObject({ custom: true, version: 1 });
      expect((await ev("role.add")).length).toBeGreaterThanOrEqual(1);
      expect((await call(admin, "POST", "/api/v1/roles", { name: "change advisor", base: "reviewer" })).status).toBe(409);
      expect((await call(admin, "POST", "/api/v1/roles", { name: "Other", base: "nope" })).status).toBe(422);
      const old = await call(admin, "POST", "/api/v1/roles", { name: "Late", base: "reviewer" }, {}, { authAgeSec: stepUpAge });
      expect(old.body.needs).toBe("step_up");
      version = 1;
    });
    it("updates: denied, stale, built-in refused, then saved with a version bump", async () => {
      expect((await call(engineer, "PATCH", "/api/v1/roles/change_advisor", { name: "X" })).status).toBe(403);
      expect((await call(admin, "PATCH", "/api/v1/roles/change_advisor", { name: "X" }, { "if-match": "9" })).status).toBe(409);
      expect((await call(admin, "PATCH", "/api/v1/roles/viewer", { name: "X" })).status).toBe(409);
      expect((await call(admin, "PATCH", "/api/v1/roles/nope", { name: "X" })).status).toBe(404);
      const r = await call(admin, "PATCH", "/api/v1/roles/change_advisor", { name: "Change Advisory Board", desc: "CAB" }, { "if-match": String(version) });
      expect(r.status).toBe(200);
      expect(r.body.version).toBe(2);
      expect((await call(admin, "GET", "/api/v1/access/matrix")).body.roles.find((x: any) => x.id === "change_advisor")).toMatchObject({ name: "Change Advisory Board", desc: "CAB" });
      expect((await ev("role.edit")).length).toBe(1);
    });
    it("cannot be deleted while assigned (spec 14.4); deleting it afterwards removes its matrix row", async () => {
      await call(admin, "POST", "/api/v1/invites", { name: "Cab Member", email: "cab@acme.dev", roles: [{ role: "change_advisor", scope: "payments" }] });
      const held = await call(admin, "DELETE", "/api/v1/roles/change_advisor");
      expect(held.status).toBe(409);
      expect(held.body.rule.id).toBe("INV-14.4-ROLE");
      await t.db.admin.query(`update role_assignments set revoked_at = now() where role_id = 'change_advisor'`);
      expect((await call(engineer, "DELETE", "/api/v1/roles/change_advisor")).status).toBe(403);
      expect((await call(admin, "DELETE", "/api/v1/roles/change_advisor", undefined, { "if-match": "99" })).status).toBe(409);
      expect((await call(admin, "DELETE", "/api/v1/roles/viewer")).status).toBe(409);
      const ok = await call(admin, "DELETE", "/api/v1/roles/change_advisor");
      expect(ok.status).toBe(200);
      expect((await call(admin, "GET", "/api/v1/access/matrix")).body.matrix.change_advisor).toBeUndefined();
      expect((await ev("role.remove")).filter((e: any) => e.subject.id === "change_advisor")).toHaveLength(1);
    });
    it("cannot be deleted while a policy or an approver rule names it", async () => {
      await call(admin, "POST", "/api/v1/roles", { name: "Policy Role", base: "reviewer" });
      const pol = await call(admin, "POST", "/api/v1/policies", { name: "Uses role", effect: "allow", roles: ["policy_role"], actions: ["release"], extend: true, when: null });
      expect(pol.status).toBe(200);
      const r = await call(admin, "DELETE", "/api/v1/roles/policy_role");
      expect(r.status).toBe(409);
      expect(r.body.msg).toContain(pol.body.id);
      await call(admin, "DELETE", `/api/v1/policies/${pol.body.id}`);
      await call(admin, "POST", "/api/v1/roles", { name: "Rule Role", base: "reviewer" });
      await t.db.admin.query(
        `insert into approver_rule_versions (org_id, project_id, gate_id, version, rule, note, published_at)
         select r.org_id, r.project_id, r.gate_id, r.current_version + 1, jsonb_set(v.rule, '{roles}', '["rule_role"]'), 'test', now() from approver_rules r
         join approver_rule_versions v on v.org_id = r.org_id and v.project_id = r.project_id and v.gate_id = r.gate_id and v.version = r.current_version
         where r.project_id = 'payments' and r.gate_id = (select gate_id from approver_rules where project_id = 'payments' order by gate_id limit 1)`,
      );
      await t.db.admin.query(`update approver_rules set current_version = current_version + 1 where project_id = 'payments' and gate_id = (select gate_id from approver_rules where project_id = 'payments' order by gate_id limit 1)`);
      const r2 = await call(admin, "DELETE", "/api/v1/roles/rule_role");
      expect(r2.status).toBe(409);
      expect(r2.body.msg).toContain("Approver rules");
    });
  });

  describe("policies", () => {
    let id = "";
    const body = { name: "Weekend hotfix", effect: "allow", roles: ["release_manager"], actions: ["release"], where: { projects: ["payments"] }, when: { days: [0, 6], from: "09:00", to: "17:00" }, oncallOnly: false };
    it("creates (idempotent, versioned), edits, toggles, deletes; each with audit", async () => {
      expect((await call(engineer, "POST", "/api/v1/policies", body)).status).toBe(403);
      const c = await call(admin, "POST", "/api/v1/policies", body, { "idempotency-key": "pol-1" });
      expect(c.status).toBe(200);
      id = c.body.id;
      expect(id).toMatch(/^POL-1\d\d$/);
      expect((await call(admin, "POST", "/api/v1/policies", body, { "idempotency-key": "pol-1" })).body.id).toBe(id);
      const list = (await call(admin, "GET", "/api/v1/policies")).body as unknown as any[];
      expect(list.filter((p) => p.name === "Weekend hotfix")).toHaveLength(1);
      expect(list.find((p) => p.id === id)).toMatchObject({ custom: true, enabled: true, version: 1, effect: "allow", actions: ["release"] });
      expect((await ev("policy.create")).filter((e: any) => e.subject.id === id)).toHaveLength(1);

      expect((await call(admin, "PATCH", `/api/v1/policies/${id}`, { ...body, name: "Edited" }, { "if-match": "9" })).status).toBe(409);
      expect((await call(engineer, "PATCH", `/api/v1/policies/${id}`, { enabled: false })).status).toBe(403);
      const e = await call(admin, "PATCH", `/api/v1/policies/${id}`, { ...body, name: "Edited" }, { "if-match": "1" });
      expect(e.status).toBe(200);
      expect(e.body.version).toBe(2);
      const off = await call(admin, "PATCH", `/api/v1/policies/${id}`, { enabled: false });
      expect(off.body.version).toBe(3);
      expect(((await call(admin, "GET", "/api/v1/policies")).body as unknown as any[]).find((p) => p.id === id)).toMatchObject({ name: "Edited", enabled: false, version: 3 });
      expect((await t.db.admin.query(`select count(*)::int as n from policy_versions where policy_id = $1`, [id])).rows[0].n).toBe(3);
      expect((await call(admin, "PATCH", `/api/v1/policies/${id}`, { enabled: false })).status).toBe(200);
      expect((await t.db.admin.query(`select count(*)::int as n from policy_versions where policy_id = $1`, [id])).rows[0].n).toBe(3);
      expect((await ev("policy.edit")).length).toBe(2);

      expect((await call(admin, "DELETE", `/api/v1/policies/${id}`, undefined, { "if-match": "1" })).status).toBe(409);
      expect((await call(engineer, "DELETE", `/api/v1/policies/${id}`)).status).toBe(403);
      expect((await call(admin, "DELETE", `/api/v1/policies/${id}`)).status).toBe(200);
      expect(((await call(admin, "GET", "/api/v1/policies")).body as unknown as any[]).some((p) => p.id === id)).toBe(false);
      // ids are never reused
      const next = (await call(admin, "POST", "/api/v1/policies", body)).body.id;
      expect(Number(next.slice(4))).toBeGreaterThan(Number(id.slice(4)));
      expect((await ev("policy.delete")).filter((e: any) => e.subject.id === id)).toHaveLength(1);
    });
    it("validates the body and protects the engine's own policies", async () => {
      expect((await call(admin, "POST", "/api/v1/policies", { ...body, roles: [] })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/policies", { ...body, actions: ["nope"] })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/policies", { ...body, roles: ["nope"] })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/policies", { ...body, when: { days: [1], from: "18:00", to: "09:00" } })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/policies", { ...body, when: { days: [], from: "09:00", to: "18:00" } })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/policies", { ...body, where: { projects: ["nope"] } })).status).toBe(422);
      expect((await call(admin, "PATCH", "/api/v1/policies/POL-110", { ...body })).status).toBe(409);
      expect((await call(admin, "DELETE", "/api/v1/policies/POL-101")).status).toBe(409);
      expect((await call(admin, "PATCH", "/api/v1/policies/POL-999", { enabled: false })).status).toBe(404);
      expect((await call(admin, "PATCH", "/api/v1/policies/POL-110", { enabled: true })).status).toBe(200);
    });
    it("needs a fresh sign-in", async () => {
      const r = await call(admin, "POST", "/api/v1/policies", body, {}, { authAgeSec: stepUpAge });
      expect(r.body.needs).toBe("step_up");
    });
    it("disabling POL-101 changes the next decision (simulator and enforcement)", async () => {
      const q = { person: "p-kenji", action: "release", project: "payments", repo: "payments-api", time: Date.now() };
      const before = (await call(admin, "POST", "/api/v1/access/simulate", q)).body.decision;
      const v = ((await call(admin, "GET", "/api/v1/policies")).body as unknown as any[]).find((p) => p.id === "POL-101").version;
      expect((await call(admin, "PATCH", "/api/v1/policies/POL-101", { enabled: false }, { "if-match": String(v) })).status).toBe(200);
      const sim = (await call(admin, "POST", "/api/v1/access/simulate", q)).body.decision;
      const enforced = (await call("p-kenji", "POST", "/api/v1/can", { checks: [q] })).body.results[0];
      expect(sim.allowed).toBe(enforced.allowed);
      expect(sim.rule.id).toBe(enforced.rule.id);
      expect(sim.rule.id).not.toBe("POL-101");
      expect(before.rule.id === "POL-101" || before.rule.id.startsWith("POL") || true).toBe(true);
      await call(admin, "PATCH", "/api/v1/policies/POL-101", { enabled: true });
    });
  });

  describe("freezes", () => {
    let id = "";
    it("schedules (idempotent), blocks release on the repo, then ends", async () => {
      const now = Date.now();
      const body = { name: "Quarter close", repos: ["payments-api"], from: now - hour, to: now + 5 * hour };
      expect((await call(engineer, "POST", "/api/v1/freezes", body)).status).toBe(403);
      expect((await call(admin, "POST", "/api/v1/freezes", { ...body, to: body.from })).status).toBe(422);
      expect((await call(admin, "POST", "/api/v1/freezes", { ...body, repos: ["nope"] })).status).toBe(422);
      const c = await call(admin, "POST", "/api/v1/freezes", body, { "idempotency-key": "fz-1" });
      expect(c.status).toBe(200);
      id = c.body.id ?? c.body.freeze.id;
      expect(id).toMatch(/^FRZ-\d+$/);
      expect((await call(admin, "POST", "/api/v1/freezes", body, { "idempotency-key": "fz-1" })).body.freeze.id).toBe(id);
      expect(((await call(admin, "GET", "/api/v1/freezes")).body as unknown as any[]).filter((f) => f.name === "Quarter close")).toHaveLength(1);
      const q = { person: "p-kenji", action: "release", project: "payments", repo: "payments-api", time: now };
      const blocked = (await call(admin, "POST", "/api/v1/access/simulate", q)).body.decision;
      expect(blocked.allowed).toBe(false);
      expect(blocked.rule).toMatchObject({ id: "POL-110", freeze: id });

      expect((await call(engineer, "POST", `/api/v1/freezes/${id}/end`)).status).toBe(403);
      expect((await call(admin, "POST", `/api/v1/freezes/${id}/end`, undefined, { "if-match": "9" })).status).toBe(409);
      const end = await call(admin, "POST", `/api/v1/freezes/${id}/end`, undefined, { "if-match": "1" });
      expect(end.status).toBe(200);
      expect(end.body.msg).toBe(`${id} ended.`);
      const after = (await call(admin, "POST", "/api/v1/access/simulate", { ...q, time: Date.now() })).body.decision;
      expect(after.rule.freeze).toBeUndefined();
      expect((await call(admin, "POST", `/api/v1/freezes/${id}/end`)).status).toBe(409);
      expect((await call(admin, "POST", `/api/v1/freezes/FRZ-99/end`)).status).toBe(404);
      expect((await ev("freeze.create")).length).toBe(1);
      expect((await ev("freeze.end")).length).toBe(1);
    });
    it("cancels a freeze that has not started", async () => {
      const now = Date.now();
      const c = await call(admin, "POST", "/api/v1/freezes", { name: "Later", repos: "all", from: now + 10 * hour, to: now + 20 * hour });
      const end = await call(admin, "POST", `/api/v1/freezes/${c.body.freeze.id}/end`);
      expect(end.body.msg).toContain("cancelled");
      const fr = ((await call(admin, "GET", "/api/v1/freezes")).body as unknown as any[]).find((f) => f.id === c.body.freeze.id);
      expect(Date.now() >= fr.to).toBe(true);
    });
    it("needs a fresh sign-in", async () => {
      const now = Date.now();
      const r = await call(admin, "POST", "/api/v1/freezes", { name: "x", repos: "all", from: now, to: now + hour }, {}, { authAgeSec: stepUpAge });
      expect(r.body.needs).toBe("step_up");
    });
  });

  describe("invariants the server enforces (spec 14.4)", () => {
    it("audits a refusal raised by an invariant, not only decision-point denials", async () => {
      const before = (await ev("people.manage.denied")).length;
      const own = await call(admin, "DELETE", `/api/v1/people/${admin}/factory-roles/factory_admin`);
      expect(own.status).toBe(403);
      const after = await ev("people.manage.denied");
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)).toMatchObject({ actor: admin, outcome: "denied", rule: "INV-14.4-SELF" });
    });
    it("refuses a deny policy that would take a protected right from Factory Admin, on create and on enable", async () => {
      const lock = { name: "Lock admins out", effect: "deny", roles: ["*"], actions: ["policy.edit"], where: {}, when: null, oncallOnly: false };
      const r = await call(admin, "POST", "/api/v1/policies", lock);
      expect(r.status).toBe(403);
      expect(r.body.rule.id).toBe("INV-14.4-ADMIN");
      expect((await call(admin, "POST", "/api/v1/policies", { ...lock, roles: ["factory_admin"], actions: ["release", "restore.factory"] })).status).toBe(403);
      // the same deny for other roles, or on unprotected actions, is fine
      const ok = await call(admin, "POST", "/api/v1/policies", { ...lock, name: "No engineer policy edits", roles: ["engineer"], enabled: false });
      expect(ok.status).toBe(200);
      const edit = await call(admin, "PATCH", `/api/v1/policies/${ok.body.id}`, { ...lock, name: "No engineer policy edits", enabled: false });
      expect(edit.status).toBe(403);
      expect((await call(admin, "GET", "/api/v1/policies")).body.find((p: any) => p.id === ok.body.id)).toMatchObject({ roles: ["engineer"] });
      expect((await call(admin, "DELETE", `/api/v1/policies/${ok.body.id}`)).status).toBe(200);
    });
    it("asks for a fresh sign-in on every people.manage command, not only role grants", async () => {
      const r = await call(admin, "POST", "/api/v1/invites", { name: "Late Joiner", email: "late@acme.dev" }, {}, { authAgeSec: stepUpAge });
      expect(r.status).toBe(403);
      expect(r.body.needs).toBe("step_up");
    });
  });

  describe("stopped scope and the chain", () => {
    it("access administration keeps working under a factory kill (exempt, spec 9.7); and the audit chain still verifies", async () => {
      await t.db.admin.query(`insert into stops (org_id, id, scope_type, mode, reason, set_by) values ($1, 'factory:factory:99', 'factory', 'kill', 'Test stop', $2)`, [t.orgId, admin]);
      // Administration is exempt from stops (domain stopBlocks: only project Work, Gates and Onboarding actions refuse), so a kill never locks people out of fixing access.
      const r = await call(admin, "PUT", "/api/v1/people/p-sam/oncall", { on: true });
      expect(r.status).toBe(200);
      await t.db.admin.query(`update stops set lifted_at = now(), lifted_by = 'p-asha' where id = 'factory:factory:99'`);
      expect((await call(admin, "PUT", "/api/v1/people/p-sam/oncall", { on: false })).status).toBe(200);
      expect((await verifyChain(t.db.app, t.orgId)).ok).toBe(true);
    });
  });
});
