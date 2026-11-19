import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { withVersion } from "./versions.js";

const d = TEST_URL ? describe : describe.skip;
const admin = "p-asha";

d("round 2: invites that expire (S-15)", () => {
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
    const r = await call("POST", "/api/v1/invites", { name: "Late Joiner", email, teams: [], roles: [{ role: "engineer", scope: "payments" }] }, { extra: { "idempotency-key": `r2p-${Date.now()}-${n++}` } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.person.id as string;
  };
  const expire = (id: string) => q(`update invites set expires_at = now() - interval '1 day' where id = $1`, [id]);

  it("S-15: an expired invite says it expired, and inviting the address again issues a new token and expiry, audited", async () => {
    const id = await invite("late.joiner@acme.dev");
    await expire(id);
    const old = (await q(`select token_hash from invites where id = $1`, [id]))[0].token_hash;
    const acc = await call("POST", `/api/v1/invites/${id}/accept`);
    expect(acc.status).toBe(409);
    expect(acc.body.msg).toMatch(/invite has expired; ask for a new one/);
    expect(acc.body.msg).not.toMatch(/stays pending/);
    const again = await call("POST", "/api/v1/invites", { name: "Late Joiner", email: "late.joiner@acme.dev", teams: [], roles: [] }, { extra: { "idempotency-key": `r2p-${Date.now()}-${n++}` } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const row = (await q(`select token_hash, status, expires_at > now() as fresh from invites where id = $1`, [id]))[0];
    expect(row.token_hash).not.toBe(old);
    expect(row).toMatchObject({ status: "pending", fresh: true });
    expect((await q(`select 1 from events where type = 'people.invite.resend' and subject->>'id' = $1`, [id])).length).toBe(1);
    expect((await q(`select 1 from outbox where payload->>'to' = 'late.joiner@acme.dev'`)).length).toBe(2);
  });
  it("S-15: the resend route does the same", async () => {
    const id = await invite("resend.me@acme.dev");
    await expire(id);
    const r = await call("POST", `/api/v1/invites/${id}/resend`, undefined, { extra: { "idempotency-key": `r2p-${Date.now()}-${n++}` } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await q(`select expires_at > now() as fresh from invites where id = $1`, [id]))[0].fresh).toBe(true);
  });
});
