import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;
d("sc6 api keys", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ seedAudit: true }); });
  afterAll(() => t.close());
  const w = world(() => t);
  const ADMIN = "p-daniel";
  let n = 0;
  const idem = () => ({ "idempotency-key": `k6-${Date.now()}-${n++}` });
  const asKey = async (secret: string, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const r = await t.app.inject({ method, url, headers: { authorization: `Bearer ${secret}`, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
    let body: Record<string, any> = {};
    try { body = r.json(); } catch { body = { text: r.body }; }
    return { status: r.statusCode, body };
  };
  const mk = async (project = "payments", actions = ["wo.submit", "wo.read", "wo.answer"], who = ADMIN) => {
    const r = await w.call(who, "POST", "/api/v1/api-keys", { name: "sc6", project, actions }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { id: r.body.key.id as string, secret: r.body.secret as string };
  };

  it("K1: a key cannot decide an assumption or resolve a comment but the scope wo.answer is offered for them", async () => {
    const k = await mk();
    const sub = await asKey(k.secret, "POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Key made order for sc6", description: "Keep it small." }, idem());
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const id = sub.body.id as string;
    await t.db.admin.query(`insert into wo_assumptions (org_id, id, wo_id, station, statement, status, made_by) values ($1,'as-1',$2,'plan','Assume X','open','agent')`, [t.orgId, id]).catch((e) => console.log("assumption insert", e.message));
    const r1 = await asKey(k.secret, "POST", `/api/v1/work-orders/${id}/assumptions/as-1`, { status: "confirmed" });
    // S-52: the scope is not offered on a route a key cannot finish, and no refusal reads "is is".
    expect(r1.status).toBe(403);
    expect(String(r1.body.msg)).not.toMatch(/\bis is\b/);
    const gate = await asKey(k.secret, "POST", `/api/v1/work-orders/${id}/confirm-brief`, {}, idem());
    console.log("K1 confirm-brief by key", gate.status);
    expect([401, 403]).toContain(gate.status);
  });

  it("S-52: a refusal for a signed-in-only step reads cleanly", async () => {
    const { person } = await import("../src/areas/workorders/ctx.js");
    expect(() => person({ personId: null } as never, "Deciding an assumption is")).toThrow(/Deciding an assumption is for signed-in people\./);
    expect(() => person({ personId: null } as never, "Moves are")).toThrow(/Moves are for signed-in people\./);
    expect(() => person({ personId: null } as never)).toThrow(/This is for signed-in people\./);
  });

  it("K2: a key made for a project that is archived afterwards still submits", async () => {
    const sfRepo = (await t.db.admin.query(`select id from repos where project_id = 'storefront' limit 1`)).rows[0].id;
    const k = await mk("storefront", ["wo.submit", "wo.read"]);
    const a = await w.call(ADMIN, "POST", "/api/v1/projects/storefront/archive", { confirmText: "Storefront" });
    console.log("archive", a.status, a.body.msg);
    const r = await asKey(k.secret, "POST", "/api/v1/projects/storefront/work-orders", { repo: sfRepo, title: "Submitted to an archived project", description: "x" }, idem());
    console.log("K2 submit on archived", r.status, JSON.stringify(r.body).slice(0, 200));
    expect(r.status, "an archived project is read-only for keys too").not.toBe(200);
    const tr = await t.db.admin.query(`select count(*) n from work_orders where title = 'Submitted to an archived project'`);
    expect(Number(tr.rows[0].n)).toBe(0);
  });

  it("K3: the key's creator loses every right, and the key keeps working in their name", async () => {
    const pa = (await t.db.admin.query(`select person_id, project_id from role_assignments where role_id = 'project_admin' and revoked_at is null`)).rows;
    console.log("project admins", JSON.stringify(pa));
    const who = pa.find((p: any) => p.project_id === "payments")?.person_id ?? ADMIN;
    const k = await mk("payments", ["wo.submit", "wo.read"], who);
    await t.db.admin.query(`update role_assignments set revoked_at = now() where person_id = $1`, [who]);
    const r = await asKey(k.secret, "POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Submitted by a key whose maker lost all roles", description: "x" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(String(r.body.msg)).toContain("owner no longer has access");
    const row = (await t.db.admin.query(`select submitter from work_orders where title like 'Submitted by a key whose maker%'`)).rows[0];
    console.log("submitter", row?.submitter);
    expect(Number((await t.db.admin.query(`select count(*) n from work_orders where title like 'Submitted by a key whose maker%'`)).rows[0].n)).toBe(0);
    const aud = await t.db.admin.query(`select 1 from events where type = 'api.key.maker-gone' and actor = $1`, [`apikey:${k.id}`]);
    expect(aud.rowCount, "the refusal is audited").toBeGreaterThan(0);
  });
});
