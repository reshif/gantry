import { verifyChain } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey } from "../src/core/auth/apikeys.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";
const admin2 = "p-omar";
const engineer = "p-tomas"; // project rights only: no people.manage
const manager = "p-sam"; // Auditor, handed people.manage below: not a Factory Admin
const leaver = "p-kenji";

d("offboarding", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await t.db.admin.query(`insert into role_matrix_versions (org_id, version, matrix, published_at, published_by) select org_id, version + 1, jsonb_set(matrix, '{auditor,people.manage}', 'true'), now(), 'test' from role_matrix_versions order by version desc limit 1`);
  });
  afterAll(() => t.close());

  const q = async (sql: string, params: unknown[] = []) => (await t.db.admin.query(sql, params)).rows;
  const version = async (id: string): Promise<number> => (await q(`select version from people where id = $1`, [id]))[0].version;
  const post = async (who: string, id: string, action: "deactivate" | "reactivate", payload: unknown, o: { ifMatch?: number | null; authAgeSec?: number } = {}) => {
    const s = await t.session(who, { authAgeSec: o.authAgeSec ?? 0 });
    const v = o.ifMatch === undefined ? await version(id) : o.ifMatch;
    const r = await t.app.inject({ method: "POST", url: `/api/v1/people/${id}/${action}`, headers: { ...s.headers, ...(v === null ? {} : { "if-match": String(v) }) }, payload: payload as object });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };
  const reason = "Left the company on Friday";
  const canWith = (key: string) => t.app.inject({ method: "POST", url: "/api/v1/can", headers: { authorization: `Bearer ${key}` }, payload: { checks: [] } });

  it("refuses a missing or short reason, a missing version and a stale sign-in", async () => {
    expect((await post(admin, leaver, "deactivate", {})).status).toBe(422);
    expect((await post(admin, leaver, "deactivate", { reason: "too short" })).status).toBe(422);
    expect((await post(admin, leaver, "deactivate", { reason }, { ifMatch: null })).status).toBe(409);
    expect((await post(admin, leaver, "deactivate", { reason }, { ifMatch: 9999 })).status).toBe(409);
    const stale = await post(admin, leaver, "deactivate", { reason }, { authAgeSec: 3 * 3600 });
    expect(stale.status).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("STEP-UP");
    expect((await q(`select status from people where id = $1`, [leaver]))[0].status).toBe("active");
  });

  it("refuses someone with only project rights", async () => {
    expect((await post(engineer, leaver, "deactivate", { reason })).status).toBe(403);
    expect((await q(`select status from people where id = $1`, [leaver]))[0].status).toBe("active");
  });

  it("refuses self and the last active Factory Admin, with the rule id", async () => {
    const self = await post(admin, admin, "deactivate", { reason });
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toContain("INV-14.4-SELF");
    expect((await q(`select status from people where id = $1`, [admin]))[0].status).toBe("active");
  });

  it("refuses to deactivate the last active Factory Admin through the endpoint, naming the rule", async () => {
    const others = (await q(`select person_id from role_assignments where role_id = 'factory_admin' and scope_type = 'factory' and revoked_at is null and person_id <> $1`, [admin])).map((r) => r.person_id as string);
    expect(others.length).toBeGreaterThan(0);
    await q(`update people set status = 'deactivated' where id = any($1::text[])`, [others]);
    try {
      const r = await post(manager, admin, "deactivate", { reason });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).toContain("INV-14.4-LAST");
      expect((await q(`select status from people where id = $1`, [admin]))[0].status).toBe("active");
    } finally {
      await q(`update people set status = 'active' where id = any($1::text[])`, [others]);
    }
  });

  it("only a Factory Admin can deactivate or reactivate a Factory Admin", async () => {
    const r = await post(manager, admin2, "deactivate", { reason });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain("Only a Factory Admin");
    expect((await q(`select status from people where id = $1`, [admin2]))[0].status).toBe("active");
    expect((await post(admin, admin2, "deactivate", { reason })).status).toBe(200);
    const back = await post(manager, admin2, "reactivate", { reason: "Returned from leave" });
    expect(back.status).toBe(403);
    expect(JSON.stringify(back.body)).toContain("Only a Factory Admin");
    expect((await q(`select status from people where id = $1`, [admin2]))[0].status).toBe("deactivated");
    expect((await post(admin, admin2, "reactivate", { reason: "Returned from leave" })).status).toBe(200);
    expect((await q(`select status from people where id = $1`, [admin2]))[0].status).toBe("active");
  });

  it("deactivates: ends sessions and keys, clears away and on-call links, lists open work, audits each effect", async () => {
    const cookie = await t.session(leaver);
    // Keys act only while their maker holds the right to make keys (S-51): both makers are project admins here.
    for (const who of [leaver, engineer]) await q(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, project_id, granted_by) values ($1,$2,$3,'project_admin','project','payments','test')`, [t.orgId, `ra-off-${who}`, who]);
    const k = generateApiKey();
    await q(`insert into api_keys (org_id, id, name, project_id, key_hash, key_prefix, scopes, created_by, expires_at) values ($1,'key-leaver','ci','payments',$2,$3,'["wo.submit"]',$4, now() + interval '30 days')`, [t.orgId, k.hash, k.prefix, leaver]);
    const k2 = generateApiKey();
    await q(`insert into api_keys (org_id, id, name, project_id, key_hash, key_prefix, scopes, created_by, expires_at) values ($1,'key-other','ci2','payments',$2,$3,'["wo.submit"]',$4, now() + interval '30 days')`, [t.orgId, k2.hash, k2.prefix, engineer]);
    await q(`update people set away = $2::jsonb where id = $1`, [engineer, JSON.stringify({ from: Date.now(), to: Date.now() + 86_400_000, delegate: leaver })]);
    await q(`update projects set config = jsonb_set(config, '{oncall}', $2::jsonb) where id = $1`, ['payments', JSON.stringify([leaver, engineer])]);
    const ins = (id: string, submitter: string, assignee: string | null) =>
      q(`insert into work_orders (org_id, id, project_id, repo_id, title, class, position, state, flow_version, submitter, assignee, data) values ($1,$2,'payments','payments-api','T','feature','build','running',1,$3,$4,$5::jsonb)`, [t.orgId, id, submitter, assignee, JSON.stringify({ history: [], log: [] })]);
    await q(`update people set oncall = true where id = $1`, [leaver]);
    await q(`insert into delegations (org_id, id, from_person, to_person, starts_at, ends_at) values ($1,'dg-1',$2,$3, now(), now() + interval '7 days'), ($1,'dg-2',$3,$2, now(), now() + interval '7 days'), ($1,'dg-3',$4,$2, now(), now() + interval '7 days')`, [t.orgId, engineer, leaver, "p-meera"]);
    await ins("WO-OFF-1", engineer, leaver);
    await ins("WO-OFF-2", leaver, null);
    await ins("WO-OFF-3", engineer, null);
    const wo = { id: "WO-OFF-1" };
    expect((await t.app.inject({ method: "GET", url: "/api/v1/me", headers: cookie.headers })).statusCode).toBe(200);
    expect((await canWith(k.key)).statusCode).toBe(200);

    const seq0 = (await q(`select coalesce(max(seq), 0) as s from events`))[0].s;
    const res = await post(admin, leaver, "deactivate", { reason });
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBeGreaterThan(0);
    expect(res.body.keys).toEqual({ revoked: ["key-leaver"], kept: [] });
    expect(res.body.delegatorsCleared).toEqual([engineer]);
    expect(res.body.oncallRemoved).toEqual(["payments"]);
    expect([...res.body.delegationsRevoked].sort()).toEqual(["dg-1", "dg-2"]);
    const work = Object.fromEntries(res.body.openWork.map((w: any) => [w.id, w.roles]));
    expect(work["WO-OFF-1"]).toEqual(["assignee"]);
    expect(work["WO-OFF-2"]).toEqual(["requester"]);
    expect(work["WO-OFF-3"]).toBeUndefined();

    // The old cookie and the key stop working at once.
    expect((await t.app.inject({ method: "GET", url: "/api/v1/me", headers: cookie.headers })).statusCode).toBe(401);
    expect((await canWith(k.key)).statusCode).toBe(401);
    // Other people's keys are untouched and nothing was reassigned.
    expect((await canWith(k2.key)).statusCode).toBe(200);
    expect((await q(`select assignee from work_orders where id = $1`, [wo.id]))[0].assignee).toBe(leaver);
    expect((await q(`select away from people where id = $1`, [engineer]))[0].away).toBeNull();
    expect((await q(`select config -> 'oncall' as o from projects where id = 'payments'`))[0].o).toEqual([engineer]);

    expect((await q(`select id from delegations where revoked_at is not null order by id`)).map((r) => r.id)).toEqual(["dg-1", "dg-2"]);
    expect((await q(`select oncall from people where id = $1`, [leaver]))[0].oncall).toBe(false);

    // One audit event per effect, each with the actor.
    const evs = await q(`select type, actor, subject, after from events where type in ('people.deactivate','people.sessions.revoke','api.key.revoke','approvers.delegate','project.oncall','people.oncall','delegation.revoke') and seq > $1 order by seq`, [seq0]);
    const count = (type: string) => evs.filter((e) => e.type === type).length;
    expect(count("people.deactivate")).toBe(1);
    expect(count("people.sessions.revoke")).toBe(1);
    expect(count("api.key.revoke")).toBe(1); // key-leaver only
    expect(count("approvers.delegate")).toBe(1); // the engineer's delegate link to the leaver
    expect(count("project.oncall")).toBe(1);
    expect(count("people.oncall")).toBe(1); // the person's own on-call flag
    expect(evs.filter((e) => e.type === "delegation.revoke").map((e) => e.subject.id).sort()).toEqual(["dg-1", "dg-2"]);
    expect(evs.every((e) => e.actor === admin)).toBe(true);
    expect(evs.find((e) => e.type === "people.deactivate")!.after.reason).toBe(reason);
    expect((await verifyChain(t.db.admin, t.orgId)).ok).toBe(true);

    expect((await post(admin, leaver, "deactivate", { reason })).status).toBe(409); // already deactivated
  });

  it("lists a waiting gate whose only eligible approver is the person", async () => {
    const who = "p-chloe"; // line lead on storefront
    await q(`insert into approver_rules (org_id, project_id, gate_id) values ($1,'storefront','G2') on conflict do nothing`, [t.orgId]);
    const v = (await q(`select coalesce(max(version), 0) + 1 as v from approver_rule_versions where project_id = 'storefront' and gate_id = 'G2'`))[0].v;
    await q(`insert into approver_rule_versions (org_id, project_id, gate_id, version, rule, published_at) values ($1,'storefront','G2',$2,$3::jsonb, now())`, [t.orgId, v, JSON.stringify({ roles: [], people: [who], required: 1, sod: false, conditions: [], escalateH: 0, fallback: null })]);
    await q(`update approver_rules set current_version = $1 where project_id = 'storefront' and gate_id = 'G2'`, [v]);
    await q(`insert into work_orders (org_id, id, project_id, title, class, position, state, flow_version, submitter, data) values ($1,'WO-OFF-G','storefront','Gate','feature','spec','waiting',1,'p-arjun',$2::jsonb)`, [t.orgId, JSON.stringify({ history: [], log: [] })]);
    await q(`insert into gate_instances (org_id, id, wo_id, gate_id, station, flow_version, opened_at) values ($1,'WO-OFF-G:G2','WO-OFF-G','G2','spec',1, now())`, [t.orgId]);
    const res = await post(admin, who, "deactivate", { reason });
    expect(res.status).toBe(200);
    const item = res.body.openWork.find((w: { id: string }) => w.id === "WO-OFF-G");
    expect(item).toMatchObject({ roles: ["sole_approver"], gate: "G2" });
  });

  it("keepKeys leaves keys live and lists them in the audit event", async () => {
    const k = generateApiKey();
    // keepKeys is the explicit, audited choice to leave the key live although the maker no longer holds the right.
    await q(`insert into api_keys (org_id, id, name, project_id, key_hash, key_prefix, scopes, created_by) values ($1,'key-kept','kept','payments',$2,$3,'["wo.submit"]','p-meera')`, [t.orgId, k.hash, k.prefix]);
    const cookie = await t.session("p-meera");
    expect((await t.app.inject({ method: "GET", url: "/api/v1/me", headers: cookie.headers })).statusCode).toBe(200);
    const res = await post(admin2, "p-meera", "deactivate", { reason, keepKeys: true });
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBeGreaterThan(0);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/me", headers: cookie.headers })).statusCode).toBe(401);
    expect(res.body.keys).toEqual({ revoked: [], kept: ["key-kept"] });
    expect((await canWith(k.key)).statusCode).toBe(200);
    const ev = (await q(`select after from events where type = 'people.deactivate' and subject->>'id' = 'p-meera'`))[0];
    expect(ev.after.keysLeftLive).toEqual(["key-kept"]);
  });

  it("reactivates to active only: roles stay, revoked keys stay revoked", async () => {
    expect((await post(admin, leaver, "reactivate", { reason: "short" })).status).toBe(422);
    const res = await post(admin, leaver, "reactivate", { reason: "Returned from leave" });
    expect(res.status).toBe(200);
    expect((await q(`select status from people where id = $1`, [leaver]))[0].status).toBe("active");
    expect((await q(`select revoked_at from api_keys where id = 'key-leaver'`))[0].revoked_at).not.toBeNull();
    expect((await post(admin, leaver, "reactivate", { reason: "Returned from leave" })).status).toBe(409);
    expect((await q(`select 1 from events where type = 'people.reactivate' and subject->>'id' = $1`, [leaver])).length).toBe(1);
    expect((await verifyChain(t.db.admin, t.orgId)).ok).toBe(true);
  });
});
