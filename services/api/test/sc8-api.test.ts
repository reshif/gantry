import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, SESSION_KEY, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { signIn } from "../src/core/auth/signin.js";

const d = TEST_URL ? describe : describe.skip;
const KEY = "sk-" + "Zq9".repeat(8);

d("S-68 vendor endpoints, S-69 NUL bytes, S-71 first sign-in", () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: randomBytes(32), edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } }); });
  afterAll(() => t.close());
  const w = world(() => t);
  let n = 0;
  const idem = () => ({ "idempotency-key": `c-${Date.now()}-${n++}-xxxx` });

  it("S-68: a vendor endpoint on the control plane, loopback, link-local, metadata or a private address is refused with 422", async () => {
    for (const ep of ["http://gantry-api:8000", "http://169.254.169.254/latest", "https://10.89.17.2:8443", "https://localhost:5432", "https://127.0.0.1/v1", "https://[::1]/v1"]) {
      const r = await w.call("p-asha", "PATCH", "/api/v1/vendors/local", { patch: { endpoint: ep } });
      expect(r.status, `${ep}: ${JSON.stringify(r.body)}`).toBe(422);
    }
    const v = await w.call("p-asha", "POST", "/api/v1/vendors", { name: "Priv", endpoint: "https://10.0.0.5/v1", key: KEY, region: "eu", retention: "zero" }, idem());
    expect(v.status, JSON.stringify(v.body)).toBe(422);
    const ok = await w.call("p-asha", "POST", "/api/v1/vendors", { name: "Public", endpoint: "https://llm.example.com/v1", key: KEY, region: "eu", retention: "zero" }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("S-68: an on-prem vendor may use a LAN range a Factory Admin listed, with a fresh sign-in and an audit row; never loopback or metadata", async () => {
    const set = async (value: unknown, o: { authAgeSec?: number } = {}) => {
      const cur = (await w.call("p-asha", "GET", "/api/v1/security")).body;
      return w.call("p-asha", "PATCH", "/api/v1/security", { path: "vendorLanRanges", value }, { "if-match": String(cur.version) }, o);
    };
    const stale = await set(["192.168.50.0/24"], { authAgeSec: 36000 });
    expect(stale.status).toBe(403);
    expect(stale.body.needs).toBe("step_up");
    expect((await set(["127.0.0.0/8"])).status, "loopback is not a LAN range").toBe(422);
    expect((await set(["0.0.0.0/0"])).status).toBe(422);
    const ok = await set(["192.168.50.0/24"]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await w.events("security.saved")).some((e: { after: Record<string, unknown> }) => JSON.stringify(e.after).includes("192.168.50.0/24"))).toBe(true);
    const lan = await w.call("p-asha", "PATCH", "/api/v1/vendors/local", { patch: { endpoint: "http://192.168.50.7:11434/v1" } });
    expect(lan.status, JSON.stringify(lan.body)).toBe(200);
    for (const ep of ["http://192.168.51.7/v1", "http://169.254.169.254/latest", "http://127.0.0.1:8000"]) {
      expect((await w.call("p-asha", "PATCH", "/api/v1/vendors/local", { patch: { endpoint: ep } })).status, ep).toBe(422);
    }
  });

  it("S-69: a NUL byte in a path id or in a body string is a 400, never a 500", async () => {
    const s = await t.session("p-tomas");
    const cases: Array<[string, string, object | undefined]> = [
      ["GET", "/api/v1/work-orders/a%00b", undefined],
      ["GET", "/api/v1/work-orders?q=a%00b", undefined],
      ["POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "a\u0000b", description: "x" }],
      ["POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "ok", description: "x", extra: { "k\u0000": ["v"] } }],
      ["PATCH", "/api/v1/saved-views/a%00b", { name: "xx" }],
    ];
    for (const [m, u, b] of cases) {
      const r = await t.app.inject({ method: m as "GET", url: u, headers: s.headers, ...(b ? { payload: b } : {}) });
      expect(r.statusCode, `${m} ${u}: ${r.body.slice(0, 100)}`).toBe(400);
    }
  });

  it("S-71: with no sign-in domain list, a first sign-in creates a pending person and no session; an admin approves", async () => {
    const claims = { sub: "kc-stranger", email: "stranger@elsewhere.example", emailVerified: true, authTime: Math.floor(Date.now() / 1000), acr: "2", gantryId: undefined };
    const req = { ip: "203.0.113.9", userAgent: "vitest", requestId: "r", method: "sso" as const };
    const setDomains = async (value: string[]) => w.call("p-asha", "PATCH", "/api/v1/security", { path: "domains", value }, { "if-match": String((await w.call("p-asha", "GET", "/api/v1/security")).body.version) });
    expect((await setDomains([])).status).toBe(200);
    const first = await signIn(t.app.gantry, claims, req);
    expect(first).toMatchObject({ ok: false, reason: "pending_approval" });
    const row = (await w.q(`select id, status, idp_subject from people where email = $1`, [claims.email]))[0];
    expect(row).toMatchObject({ status: "invited", idp_subject: "kc-stranger" });
    expect(await w.q(`select 1 from sessions where person_id = $1`, [row.id])).toHaveLength(0);
    const again = await signIn(t.app.gantry, claims, req);
    expect(again).toMatchObject({ ok: false, reason: "pending_approval" });
    expect((await w.q(`select status from people where id = $1`, [row.id]))[0].status).toBe("invited");
    const acc = await w.call("p-asha", "POST", `/api/v1/invites/${row.id}/accept`, {});
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect((await signIn(t.app.gantry, claims, req)).ok).toBe(true);
    // With a domain list the organisation has said who may join: a listed address is provisioned active, as before.
    expect((await setDomains(["listed.example"])).status).toBe(200);
    expect((await signIn(t.app.gantry, { ...claims, sub: "kc-listed", email: "someone@listed.example" }, req)).ok).toBe(true);
  });
});
