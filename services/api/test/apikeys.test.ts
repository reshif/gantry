import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const d = TEST_URL ? describe : describe.skip;

d("API keys, public API and request log (spec 8.8, 8.10, 12.5)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  const w = world(() => t);
  const ADMIN = "p-asha";
  const NOBODY = "p-tomas";
  const mk = (o: Record<string, unknown> = {}, h: Record<string, string> = {}, who = ADMIN, authAgeSec = 0) =>
    w.call(who, "POST", "/api/v1/api-keys", { name: "Jira bridge", project: "payments", actions: ["wo.submit", "wo.read", "wo.answer"], ...o }, h, { authAgeSec });
  /** A real bearer request, as an external system would send it. */
  const asKey = async (secret: string | null, method: "GET" | "POST" | "DELETE" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const r = await t.app.inject({ method, url, headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
    let body: Record<string, any> = {};
    try { body = r.json(); } catch { body = { text: r.body }; }
    return { status: r.statusCode, body, headers: r.headers };
  };
  const q = w.q;
  let key: { id: string; secret: string };
  let n = 0;
  const idem = (): Record<string, string> => ({ "idempotency-key": `k-${Date.now()}-${n++}` });

  it("creates a key: the secret is shown once, only its hash is stored, and the audit entry carries no secret", async () => {
    const r = await mk({}, { "idempotency-key": "create-1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.secret).toMatch(/^gk_[0-9a-f]{8}_/);
    expect(r.body.key).toMatchObject({ name: "Jira bridge", project: "payments", actions: ["wo.submit", "wo.read", "wo.answer"], revoked: false, by: ADMIN, lastUsed: null });
    expect(r.body.key.prefix).toBe(r.body.secret.slice(0, 11));
    expect(r.body.key.expires).toBeGreaterThan(Date.now() + 80 * 86_400_000); // expires in 90 days unless told otherwise (spec 12.5)
    key = { id: r.body.key.id, secret: r.body.secret };
    const rows = await q(`select * from api_keys where id = $1`, [key.id]);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(key.secret);
    const evs = await q(`select * from events where type = 'api.key.create'`);
    expect(evs).toHaveLength(1);
    expect(JSON.stringify(evs)).not.toContain(key.secret);
    expect(evs[0]).toMatchObject({ category: "api", outcome: "ok" });
    // The stored idempotent response does not keep the secret either.
    const idemRows = await q(`select response from idempotency_keys where key = 'create-1'`);
    expect(JSON.stringify(idemRows)).not.toContain(key.secret);
    const list = await w.call(ADMIN, "GET", "/api/v1/api-keys");
    expect(list.body[0]).toMatchObject({ id: key.id, prefix: r.body.key.prefix });
    expect(JSON.stringify(list.body)).not.toContain(key.secret);
  });

  it("a retry with the same Idempotency-Key returns the first key without creating a second or showing the secret again", async () => {
    const r = await mk({}, { "idempotency-key": "create-1" });
    expect(r.status).toBe(200);
    expect(r.headers["idempotent-replayed"]).toBe("true");
    expect(r.body.secret).toBeUndefined();
    expect(r.body.key.id).toBe(key.id);
    expect(await q(`select 1 from api_keys`)).toHaveLength(1);
    const clash = await mk({ name: "Other" }, { "idempotency-key": "create-1" });
    expect(clash.status).toBe(409);
  });

  it("is refused for someone without the right (audited), and for a stale sign-in (step-up)", async () => {
    const denied = await mk({ name: "Nope" }, idem(), NOBODY);
    expect(denied.status).toBe(403);
    expect(denied.body.ok).toBe(false);
    const ev = await q(`select * from events where type = 'api.keys.denied' order by seq desc limit 1`);
    expect(ev[0]).toMatchObject({ outcome: "denied", category: "api", actor: NOBODY });
    const stale = await mk({ name: "Stale" }, idem(), ADMIN, 3600);
    expect(stale.status).toBe(403);
    expect(stale.body.needs).toBe("step_up");
    expect(await q(`select 1 from api_keys`)).toHaveLength(1);
  });

  it("validates: a name, a real project, scopes from the list", async () => {
    expect((await mk({ name: "  " }, idem())).status).toBe(422);
    expect((await mk({ actions: ["wo.delete"] }, idem())).status).toBe(422);
    expect((await mk({ project: "nope" }, idem())).status).toBe(404);
  });

  it("submits a work order through the public API with the key, by the same handler as the UI", async () => {
    const noKey = await asKey(key.secret, "POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Add idempotency keys to refunds" });
    expect(noKey.status).toBe(422);
    expect(noKey.body.needs).toBe("Idempotency-Key");
    const h = idem();
    const r = await asKey(key.secret, "POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Add idempotency keys to the refund endpoint", description: "Keep it backwards compatible.", class: "feature", priority: "P2", onBehalfOf: "p-asha", source: "slack" }, h);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.id).toMatch(/^WO-/);
    const row = (await q(`select * from work_orders where id = $1`, [r.body.id]))[0];
    expect(row).toMatchObject({ source: "api", submitter: ADMIN, class: "feature" }); // the creator of the key, never what the body claims
    expect(row.data.submittedBy).toBe(`apikey:${key.id}`);
    const sub = (await q(`select * from events where type = 'wo.submit' and wo_id = $1`, [r.body.id]))[0];
    expect(sub).toMatchObject({ actor: `apikey:${key.id}`, channel: "api" });
    const again = await asKey(key.secret, "POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Add idempotency keys to the refund endpoint", description: "Keep it backwards compatible.", class: "feature", priority: "P2", onBehalfOf: "p-asha", source: "slack" }, h);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(r.body.id);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(await q(`select 1 from work_orders where title like 'Add idempotency keys to the refund endpoint'`)).toHaveLength(1);
    // Track it and answer an intake question.
    const got = await asKey(key.secret, "GET", `/api/v1/work-orders/${r.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(r.body.id);
    expect((await asKey(key.secret, "GET", `/api/v1/work-orders/${r.body.id}/record`)).status).toBe(200);
    const ans = await asKey(key.secret, "POST", `/api/v1/work-orders/${r.body.id}/messages`, { text: "Only payments-api, refunds endpoint." });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
  });

  it("keeps a key inside its project, its scopes and the public endpoints; each refusal is audited", async () => {
    const other = await asKey(key.secret, "POST", "/api/v1/projects/storefront/work-orders", { repo: "storefront-web", title: "Something on another project" }, idem());
    expect(other.status).toBe(403);
    const read = await mk({ name: "Read only", actions: ["wo.read"] }, idem());
    const ro = read.body.secret as string;
    const sub = await asKey(ro, "POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Should not be created" }, idem());
    expect(sub.status).toBe(403);
    expect(sub.body.msg).toMatch(/not scoped for wo.submit/);
    expect((await asKey(ro, "GET", "/api/v1/projects/payments/work-orders")).status).toBe(200);
    const noRead = await asKey(key.secret, "GET", "/api/v1/projects/payments/work-orders");
    expect(noRead.status).toBe(200); // this key has wo.read
    const sneaky = await asKey(key.secret, "GET", "/api/v1/api-keys");
    expect(sneaky.status).toBe(403);
    expect((await asKey(key.secret, "POST", "/api/v1/api-keys", { name: "mine", project: "payments" }, idem())).status).toBe(403);
    expect((await asKey(key.secret, "GET", "/api/v1/me")).status).toBe(403);
    const denied = await q(`select type, outcome, actor from events where actor = $1 and outcome = 'denied' order by seq`, [`apikey:${key.id}`]);
    expect(denied.map((e) => e.type)).toEqual(expect.arrayContaining(["wo.submit.denied", "api.route.denied"]));
    expect(await q(`select 1 from work_orders where title = 'Should not be created'`)).toHaveLength(0);
    // A key with only wo.submit cannot read.
    const subOnly = await mk({ name: "Write only", actions: ["wo.submit"] }, idem());
    const r = await asKey(subOnly.body.secret, "GET", "/api/v1/projects/payments/work-orders");
    expect(r.status).toBe(403);
  });

  it("an unknown or malformed key is refused with 401", async () => {
    expect((await asKey("gk_00000000_" + "x".repeat(32), "GET", "/api/v1/projects/payments/work-orders")).status).toBe(401);
    expect((await asKey("not-a-key", "GET", "/api/v1/projects/payments/work-orders")).status).toBe(401);
  });

  it("logs every request with the key, method, path, status and duration, and filters the log", async () => {
    await new Promise((r) => setTimeout(r, 100));
    const all = await w.call(ADMIN, "GET", "/api/v1/api-requests");
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThan(5);
    expect(all.body.items[0]).toMatchObject({ key: expect.any(String), method: expect.any(String), path: expect.stringMatching(/^\/api\/v1\//), status: expect.any(Number), ms: expect.any(Number) });
    expect(all.body.items.some((x: any) => x.method === "POST" && x.status === 200 && x.key === key.id)).toBe(true);
    expect(all.body.items.some((x: any) => x.status === 403)).toBe(true);
    const only2 = await w.call(ADMIN, "GET", "/api/v1/api-requests?status=2xx&key=" + key.id);
    expect(only2.body.items.every((x: any) => x.status < 300 && x.key === key.id)).toBe(true);
    const page = await w.call(ADMIN, "GET", "/api/v1/api-requests?limit=2");
    expect(page.body.items).toHaveLength(2);
    expect(page.body.next).toBeTruthy();
    const next = await w.call(ADMIN, "GET", `/api/v1/api-requests?limit=2&cursor=${page.body.next}`);
    expect(next.body.items[0]).not.toEqual(page.body.items[0]);
    expect(JSON.stringify(all.body)).not.toContain(key.secret);
  });

  it("applies the rate limit per key: 429 with Retry-After, logged, and recovering once requests age out", async () => {
    const set = await w.call(ADMIN, "PATCH", "/api/v1/api-config", { rateLimit: 2, burst: 0 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const fresh = await mk({ name: "Limited", actions: ["wo.read"] }, idem());
    const s = fresh.body.secret as string;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await asKey(s, "GET", "/api/v1/projects/payments/work-orders")).status);
      await new Promise((r) => setTimeout(r, 60)); // let the log row land
    }
    expect(codes).toEqual([200, 200, 429, 429]);
    const lim = await asKey(s, "GET", "/api/v1/projects/payments/work-orders");
    expect(lim.status).toBe(429);
    expect(Number(lim.headers["retry-after"])).toBeGreaterThan(0);
    // Another key is not affected.
    const second = await mk({ name: "Second", actions: ["wo.read"] }, idem());
    expect((await asKey(second.body.secret, "GET", "/api/v1/projects/payments/work-orders")).status).toBe(200);
    // Age the log: the key works again.
    await q(`update api_requests set at = at - interval '2 minutes' where key_id = $1`, [fresh.body.key.id]);
    expect((await asKey(s, "GET", "/api/v1/projects/payments/work-orders")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));
    const log = await w.call(ADMIN, "GET", `/api/v1/api-requests?status=429&key=${fresh.body.key.id}`);
    expect(log.body.items.length).toBeGreaterThanOrEqual(2);
    await w.call(ADMIN, "PATCH", "/api/v1/api-config", { rateLimit: 600, burst: 100 });
  });

  it("revokes a key: it fails with 401 at once, and revoking twice or by someone without the right is refused", async () => {
    const stale = await w.call(NOBODY, "DELETE", `/api/v1/api-keys/${key.id}`);
    expect(stale.status).toBe(403);
    const r = await w.call(ADMIN, "DELETE", `/api/v1/api-keys/${key.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await q(`select revoked_by from api_keys where id = $1`, [key.id])).toEqual([{ revoked_by: ADMIN }]);
    expect((await asKey(key.secret, "GET", "/api/v1/projects/payments/work-orders")).status).toBe(401);
    expect((await w.call(ADMIN, "DELETE", `/api/v1/api-keys/${key.id}`)).status).toBe(409);
    expect((await w.call(ADMIN, "DELETE", `/api/v1/api-keys/key-nope`)).status).toBe(404);
    expect((await q(`select 1 from events where type = 'api.key.revoke'`))).toHaveLength(1);
    await new Promise((r2) => setTimeout(r2, 100));
    const log = await w.call(ADMIN, "GET", `/api/v1/api-requests?key=${key.id}&status=4xx`);
    expect(log.body.items.some((x: any) => x.status === 401)).toBe(true); // the refusal is recorded against the revoked key
    const list = await w.call(ADMIN, "GET", "/api/v1/api-keys");
    expect(list.body.find((k: any) => k.id === key.id)).toMatchObject({ revoked: true, revokedBy: ADMIN });
  });

  it("an expired key is refused", async () => {
    const e = await mk({ name: "Short", expiresInDays: 1, actions: ["wo.read"] }, idem());
    expect((await asKey(e.body.secret, "GET", "/api/v1/projects/payments/work-orders")).status).toBe(200);
    await q(`update api_keys set expires_at = now() - interval '1 minute' where id = $1`, [e.body.key.id]);
    expect((await asKey(e.body.secret, "GET", "/api/v1/projects/payments/work-orders")).status).toBe(401);
    expect((await w.call(ADMIN, "GET", "/api/v1/api-keys")).body.find((k: any) => k.id === e.body.key.id)).toMatchObject({ expired: true });
  });

  it("API settings: read, save with a version, refuse a stale save and a person without the right; the idempotency window is honoured", async () => {
    const g0 = await w.call(ADMIN, "GET", "/api/v1/api-config");
    expect(g0.body).toMatchObject({ rateLimit: 600, burst: 100, idempotencyHours: 24, webhookSigning: "HMAC-SHA256", triggersEnabled: false });
    const v = g0.body.version;
    const ok = await w.call(ADMIN, "PATCH", "/api/v1/api-config", { idempotencyHours: 1 }, { "if-match": String(v) });
    expect(ok.status).toBe(200);
    const stale = await w.call(ADMIN, "PATCH", "/api/v1/api-config", { idempotencyHours: 2 }, { "if-match": String(v) });
    expect(stale.status).toBe(409);
    expect((await w.call(NOBODY, "PATCH", "/api/v1/api-config", { burst: 5 })).status).toBe(403);
    expect((await w.call(ADMIN, "PATCH", "/api/v1/api-config", { rateLimit: 0 })).status).toBe(422);
    expect((await w.call(ADMIN, "PATCH", "/api/v1/api-config", { webhookSigning: "Ed25519" })).status).toBe(422);
    expect((await q(`select type, before, after from events where type = 'api.config' order by seq desc limit 1`))[0]).toMatchObject({ after: { idempotencyHours: 1 }, before: { idempotencyHours: 24 } });
    // Window of 1 hour: a remembered key older than that is new again.
    const k = await mk({ name: "Idem", actions: ["wo.submit"] }, idem());
    const h = { "idempotency-key": "win-1" };
    const body = { repo: "payments-api", title: "Window test work order here" };
    const a = await asKey(k.body.secret, "POST", "/api/v1/projects/payments/work-orders", body, h);
    const b = await asKey(k.body.secret, "POST", "/api/v1/projects/payments/work-orders", body, h);
    expect(b.body.id).toBe(a.body.id);
    expect((await q(`select (expires_at - created_at) as w from idempotency_keys where key = 'win-1'`))[0].w.hours).toBe(1);
    await q(`update idempotency_keys set expires_at = now() - interval '1 minute' where key = 'win-1'`);
    const c = await asKey(k.body.secret, "POST", "/api/v1/projects/payments/work-orders", body, h);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.id).not.toBe(a.body.id);
    await w.call(ADMIN, "PATCH", "/api/v1/api-config", { idempotencyHours: 24 });
  });

  it("a stopped project refuses submissions by key with the stop's reason", async () => {
    const k = await mk({ name: "Stopped", actions: ["wo.submit"] }, idem());
    const halt = await w.call(ADMIN, "POST", "/api/v1/stops", { scope: "project", id: "payments", mode: "kill", reason: "test kill", inFlight: "hold", confirmText: "Payments Platform" });
    expect(halt.status, JSON.stringify(halt.body)).toBe(200);
    const r = await asKey(k.body.secret, "POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Refused while killed" }, idem());
    expect(r.status).toBe(409);
    expect((await q(`select 1 from events where type = 'wo.submit.denied' and actor = $1`, [`apikey:${k.body.key.id}`])).length).toBeGreaterThan(0);
  });
});
