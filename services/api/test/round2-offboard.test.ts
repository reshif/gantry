import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { withVersion } from "./versions.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";

d("round 2: reactivating someone who never signed in (S-16)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const q = async (sql: string, params: unknown[] = []) => (await t.db.admin.query(sql, params)).rows;
  const call = async (method: "GET" | "POST", url: string, payload?: unknown, o: { authAgeSec?: number; extra?: Record<string, string> } = {}) => {
    const s = await t.session(admin, { authAgeSec: o.authAgeSec ?? 0 });
    const r = await t.app.inject({ method, url, headers: { ...s.headers, ...(await withVersion(t.db.admin, method, url, o.extra ?? {})) }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };
  let n = 0;
  const invite = async (email: string) => {
    const r = await call("POST", "/api/v1/invites", { name: "Late Joiner", email, teams: [], roles: [{ role: "engineer", scope: "payments" }] }, { extra: { "idempotency-key": `r2o-${Date.now()}-${n++}` } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.person.id as string;
  };
  const expire = (id: string) => q(`update invites set expires_at = now() - interval '1 day' where id = $1`, [id]);

  it("S-16: reactivating a person who never signed in puts them back to invited with a fresh invite", async () => {
    const id = await invite("never.in@acme.dev");
    const dea = await call("POST", `/api/v1/people/${id}/deactivate`, { reason: "Offer withdrawn for now" }, { extra: { "if-match": String((await q(`select version from people where id = $1`, [id]))[0].version) } });
    expect(dea.status, JSON.stringify(dea.body)).toBe(200);
    await expire(id);
    const res = await call("POST", `/api/v1/people/${id}/reactivate`, { reason: "Offer back on the table" }, { extra: { "if-match": String((await q(`select version from people where id = $1`, [id]))[0].version) } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = (await q(`select status, idp_subject from people where id = $1`, [id]))[0];
    expect(p).toMatchObject({ status: "invited", idp_subject: null });
    expect((await q(`select status, expires_at > now() as fresh from invites where id = $1`, [id]))[0]).toMatchObject({ status: "pending", fresh: true });
  });
});
