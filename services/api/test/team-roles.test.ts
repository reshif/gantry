import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";
const engineer = "p-tomas";

d("team role grants (spec 8.9)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  type M = "GET" | "POST" | "PUT" | "DELETE";
  const call = async (who: string, method: M, url: string, payload?: unknown, o: { authAgeSec?: number; headers?: Record<string, string> } = {}) => {
    const s = await t.session(who, o.authAgeSec === undefined ? {} : { authAgeSec: o.authAgeSec });
    const r = await t.app.inject({ method, url, headers: { ...s.headers, ...(o.headers ?? {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };
  const ev = async (type: string) => (await t.db.admin.query(`select * from events where type = $1 order by seq`, [type])).rows;
  const person = async (id: string) => ((await call(admin, "GET", "/api/v1/people")).body as unknown as Array<Record<string, any>>).find((p) => p.id === id)!;
  const setTeams = async (id: string, teams: string[]) => {
    const v = (await t.db.admin.query(`select version from people where id = $1`, [id])).rows[0].version;
    return call(admin, "PUT", `/api/v1/people/${id}/teams`, { teams }, { headers: { "if-match": String(v) } });
  };
  const can = async (who: string, action: string, project: string | null) => ((await call(who, "POST", "/api/v1/can", { checks: [{ action, project }] })).body.results[0]) as { allowed: boolean; reason: string };
  let action = ""; // a project action Reviewer has and Engineer does not
  let team = "";

  it("sets up a team and finds an action only a Reviewer role allows", async () => {
    const r = await call(admin, "POST", "/api/v1/teams", { name: "Review Guild" });
    team = r.body.team.id;
    const m = (await call(admin, "GET", "/api/v1/access/matrix")).body as { matrix: Record<string, Record<string, boolean>>; actions: Array<{ id: string; scope: string }> };
    const a = m.actions.find((x) => x.scope === "project" && m.matrix.reviewer?.[x.id] && !m.matrix.engineer?.[x.id]);
    expect(a, "matrix has an action only the reviewer holds").toBeTruthy();
    action = a!.id;
  });

  it("needs people.manage and a fresh sign-in", async () => {
    expect((await call(engineer, "POST", `/api/v1/teams/${team}/roles`, { role: "reviewer", scope: "storefront" })).status).toBe(403);
    const old = await call(admin, "POST", `/api/v1/teams/${team}/roles`, { role: "reviewer", scope: "storefront" }, { authAgeSec: 3600 });
    expect(old.status).toBe(403);
    expect(old.body.needs).toBe("step_up");
    expect((await call(admin, "GET", `/api/v1/teams/${team}/roles`)).body).toEqual([]);
  });

  it("refuses Factory Admin, level/scope mismatches, unknown roles and projects, and past expiry", async () => {
    const post = (b: unknown) => call(admin, "POST", `/api/v1/teams/${team}/roles`, b);
    const fa = await post({ role: "factory_admin", scope: "factory" });
    expect(fa.status).toBe(403);
    expect(fa.body.rule?.id).toBe("INV-TEAM-ADMIN");
    expect((await post({ role: "reviewer", scope: "factory" })).status).toBe(422);
    expect((await post({ role: "auditor", scope: "storefront" })).status).toBe(422);
    expect((await post({ role: "nope", scope: "storefront" })).status).toBe(422);
    expect((await post({ role: "reviewer", scope: "no-such-project" })).status).toBe(422);
    expect((await post({ role: "reviewer", scope: "storefront", expiresAt: Date.now() - 1000 })).status).toBe(422);
    expect((await call(admin, "POST", `/api/v1/teams/nope/roles`, { role: "reviewer", scope: "storefront" })).status).toBe(404);
  });

  it("members inherit a project grant, only in that project, with the source named", async () => {
    await setTeams(engineer, [...(await person(engineer)).teams, team]);
    expect((await can(engineer, action, "storefront")).allowed).toBe(false);
    const g = await call(admin, "POST", `/api/v1/teams/${team}/roles`, { role: "reviewer", scope: "storefront" });
    expect(g.status).toBe(200);
    expect(g.body.msg).toMatch(/1 member inherits it/);
    const ok = await can(engineer, action, "storefront");
    expect(ok.allowed).toBe(true);
    expect(ok.reason).toMatch(/via Review Guild/);
    expect((await can(engineer, action, "payments")).allowed).toBe(false);
    const p = await person(engineer);
    expect(p.roles).toContainEqual({ role: "reviewer", scope: "storefront", via: team });
    expect(p.roles).toContainEqual({ role: "engineer", scope: "payments" });
    const e = (await ev("team.role.grant"))[0];
    expect(e).toMatchObject({ actor: admin, subject: { type: "team", id: team } });
  });

  it("effective permissions say where each permission comes from", async () => {
    const r = (await call(admin, "GET", `/api/v1/people/${engineer}/effective-permissions`)).body as any;
    expect(r.cells[action].storefront).toEqual([1, "MATRIX", [team]]);
    expect(r.cells[action].payments[0]).toBe(0);
    expect(r.teams[team]).toBe("Review Guild");
    expect(r.grants).toContainEqual({ role: "reviewer", roleName: "Reviewer", scope: "storefront", via: team });
    expect(r.grants).toContainEqual({ role: "engineer", roleName: "Engineer", scope: "payments", via: null });
  });

  it("a granted twice is idempotent, and a direct grant of the same role keeps its own source", async () => {
    const again = await call(admin, "POST", `/api/v1/teams/${team}/roles`, { role: "reviewer", scope: "storefront" });
    expect(again.body.msg).toMatch(/already has/);
    expect((await ev("team.role.grant")).length).toBe(1);
    expect((await call(admin, "GET", `/api/v1/teams/${team}/roles`)).body).toHaveLength(1);
    const direct = await call(admin, "PUT", `/api/v1/projects/storefront/members/${engineer}/roles/reviewer`, undefined, {
      headers: { "if-match": String((await t.db.admin.query(`select version from people where id = $1`, [engineer])).rows[0].version) },
    });
    expect(direct.status).toBe(200);
    const r = (await call(admin, "GET", `/api/v1/people/${engineer}/effective-permissions`)).body as any;
    expect(r.cells[action].storefront[2]).toEqual(expect.arrayContaining(["direct", team]));
    // Removing the direct grant leaves the inherited one; the team's grant is untouched by member-level removal.
    const rm = await call(admin, "DELETE", `/api/v1/projects/storefront/members/${engineer}/roles/reviewer`, undefined, {
      headers: { "if-match": String((await t.db.admin.query(`select version from people where id = $1`, [engineer])).rows[0].version) },
    });
    expect(rm.status).toBe(200);
    expect((await can(engineer, action, "storefront")).allowed).toBe(true);
  });

  it("leaving the team removes the inherited role; rejoining restores it", async () => {
    await setTeams(engineer, (await person(engineer)).teams.filter((x: string) => x !== team));
    expect((await can(engineer, action, "storefront")).allowed).toBe(false);
    expect((await person(engineer)).roles.some((r: any) => r.via)).toBe(false);
    await setTeams(engineer, [...(await person(engineer)).teams, team]);
    expect((await can(engineer, action, "storefront")).allowed).toBe(true);
  });

  it("revoking the grant removes it from every member at once, and is audited", async () => {
    const id = ((await call(admin, "GET", `/api/v1/teams/${team}/roles`)).body as any[])[0].id;
    expect((await call(engineer, "DELETE", `/api/v1/teams/${team}/roles/${id}`)).status).toBe(403);
    const r = await call(admin, "DELETE", `/api/v1/teams/${team}/roles/${id}`);
    expect(r.status).toBe(200);
    expect((await can(engineer, action, "storefront")).allowed).toBe(false);
    expect((await call(admin, "DELETE", `/api/v1/teams/${team}/roles/${id}`)).status).toBe(404);
    expect((await ev("team.role.revoke"))[0]).toMatchObject({ subject: { type: "team", id: team } });
  });

  it("an expired grant stops applying, and can be granted again", async () => {
    const g = await call(admin, "POST", `/api/v1/teams/${team}/roles`, { role: "reviewer", scope: "storefront", expiresAt: Date.now() + 3_600_000 });
    expect(g.status).toBe(200);
    expect((await can(engineer, action, "storefront")).allowed).toBe(true);
    expect(((await call(admin, "GET", "/api/v1/teams")).body as any[]).find((x) => x.id === team).roles[0].expiresAt).toBeGreaterThan(Date.now());
    await t.db.admin.query(`update team_role_assignments set expires_at = now() - interval '1 minute' where team_id = $1 and revoked_at is null`, [team]);
    expect((await can(engineer, action, "storefront")).allowed).toBe(false);
    expect((await call(admin, "GET", `/api/v1/teams/${team}/roles`)).body).toEqual([]);
    expect((await call(admin, "POST", `/api/v1/teams/${team}/roles`, { role: "reviewer", scope: "storefront" })).status).toBe(200);
    expect((await can(engineer, action, "storefront")).allowed).toBe(true);
  });

  it("factory-level roles via a team apply everywhere; a role held by a team cannot be deleted; deleting the team drops its grants", async () => {
    const c = await call(admin, "POST", "/api/v1/roles", { name: "Observer", level: "factory", base: "auditor" });
    const roleId = c.body.role?.id ?? c.body.id ?? "observer";
    // a factory-level grant needs a reason, and so does taking it away
    expect((await call(admin, "POST", `/api/v1/teams/${team}/roles`, { role: roleId, scope: "factory" })).status).toBe(422);
    const g = await call(admin, "POST", `/api/v1/teams/${team}/roles`, { role: roleId, scope: "factory", reason: "Quarterly access review" });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect((await ev("team.role.grant")).at(-1).after).toMatchObject({ scope: "factory", reason: "Quarterly access review" });
    expect((await person(engineer)).roles).toContainEqual({ role: roleId, scope: "factory", via: team });
    expect((await call(admin, "DELETE", `/api/v1/teams/${team}/roles/${g.body.grant.id}`)).status).toBe(422);
    const del = await call(admin, "DELETE", `/api/v1/roles/${roleId}`, undefined, { headers: { "if-match": String((await t.db.admin.query(`select version from roles where id = $1`, [roleId])).rows[0].version) } });
    expect(del.status).toBe(409);
    await setTeams(engineer, (await person(engineer)).teams.filter((x: string) => x !== team));
    const gone = await call(admin, "DELETE", `/api/v1/teams/${team}`);
    expect(gone.status).toBe(200);
    expect((await t.db.admin.query(`select count(*)::int as n from team_role_assignments where team_id = $1`, [team])).rows[0].n).toBe(0);
    expect((await ev("teams.delete"))[0].before).toMatchObject({ roles: expect.any(Array) });
  });
});
