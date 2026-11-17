/**
 * Wave 6 (identity): address-only claiming of unlinked people, a refused step-up leaving writes behind, unauthenticated sign-in
 * failures growing the ledger, polling keeping a session alive, unbounded streams, and the IP allow-list parsing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signIn, recordSignInFailure } from "../src/core/auth/signin.js";
import { ipAllowed, validIpEntry } from "../src/core/security.js";
import { Hub, type Subscriber } from "../src/core/stream.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const req = { ip: "203.0.113.9", userAgent: "vitest", requestId: "r", method: "sso" as const };
const now = () => Math.floor(Date.now() / 1000);

describe("IP allow-list entries", () => {
  it("accepts addresses and in-range CIDR, rejects typos instead of silently skipping them", () => {
    for (const ok of ["10.0.0.0/8", "10.1.2.3", " 192.168.0.0/16 ", "::1", "fd00::/8"]) expect(validIpEntry(ok), ok).toBe(true);
    for (const bad of ["10.0.0.0/abc", "10.0.0.0/99", "10.0.0.0/8/8", "nope", "", "10.0.0.0/", "fd00::/129"]) expect(validIpEntry(bad), bad).toBe(false);
  });
  it("a malformed stored entry never throws and never widens the list", () => {
    expect(() => ipAllowed("10.1.1.1", ["10.0.0.0/99", "10.1.1.1"])).not.toThrow();
    expect(ipAllowed("10.2.2.2", ["10.0.0.0/abc", "10.1.1.1"])).toBe(false);
    expect(ipAllowed("10.1.1.1", ["10.0.0.0/abc", "10.1.1.1"])).toBe(true);
  });
});

describe("stream hub", () => {
  const sub = (personId: string): Subscriber & { closed: boolean } => {
    const s = { personId, sessionId: null, visible: "all" as const, closed: false, write: () => true, close() { s.closed = true; } };
    return s;
  };
  it("keeps at most MAX streams per person, closing the oldest, and does not touch other people", () => {
    const hub = new Hub({} as never, "o", { refresh: async () => "all" });
    const mine = Array.from({ length: Hub.MAX_STREAMS_PER_PERSON + 3 }, () => sub("p-a"));
    const other = sub("p-b");
    hub.add(other);
    for (const s of mine) hub.add(s);
    expect(mine.filter((s) => s.closed).length).toBe(3);
    expect(mine.slice(0, 3).every((s) => s.closed)).toBe(true);
    expect(other.closed).toBe(false);
  });
  it("loads policy once per sweep, however many streams are open", async () => {
    let loads = 0;
    const hub = new Hub({} as never, "o", {
      async refresh(_s, batch) {
        if (!batch.has("p")) { loads++; batch.set("p", true); }
        return "all";
      },
    });
    for (let i = 0; i < 4; i++) hub.add(sub(`p-${i}`));
    await hub.sweep();
    expect(loads).toBe(1);
  });
});

d("identity sign-in and sessions", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());
  const g = () => t.app.gantry;
  const q = async (sql: string, p: unknown[] = []) => (await t.db.admin.query(sql, p)).rows;

  it("an active person with no linked subject is not claimed by address alone (accepted invite, seed, import)", async () => {
    await q(`update people set idp_subject = null where id = 'p-sam'`);
    const email = (await q(`select email from people where id = 'p-sam'`))[0].email as string;
    const r = await signIn(g(), { sub: "kc-attacker", email, emailVerified: true, authTime: now() }, req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invite_required");
    expect((await q(`select idp_subject from people where id = 'p-sam'`))[0].idp_subject).toBeNull();
    // the provider-asserted Gantry id (with the same address) still links the seeded person
    const ok = await signIn(g(), { sub: "kc-sam", email, emailVerified: true, gantryId: "p-sam", authTime: now() }, req);
    expect(ok.ok).toBe(true);
    // and once linked, only that subject signs in
    const again = await signIn(g(), { sub: "kc-attacker", email, emailVerified: true, authTime: now() }, req);
    expect(again.ok).toBe(false);
  });

  it("a refused step-up (different person) leaves no provisioning behind", async () => {
    const s = await t.session("p-asha");
    const before = (await q(`select count(*)::int n from people`))[0].n as number;
    const r = await signIn(g(), { sub: "kc-stranger", email: "stranger@acme.dev", emailVerified: true, name: "Stranger", authTime: now() }, { ...req, stepUpOnly: true, existingSession: { id: s.id, personId: "p-asha" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("different_person");
    expect((await q(`select count(*)::int n from people`))[0].n).toBe(before);
    expect(await q(`select 1 from people where email = 'stranger@acme.dev'`)).toHaveLength(0);
    expect(await q(`select 1 from events where type = 'people.provisioned' and after::text like '%stranger@acme.dev%'`)).toHaveLength(0);
    // a different existing person is refused without linking them either
    await q(`update people set idp_subject = null where id = 'p-tomas'`);
    const email = (await q(`select email from people where id = 'p-tomas'`))[0].email as string;
    const r2 = await signIn(g(), { sub: "kc-tomas-new", email, emailVerified: true, gantryId: "p-tomas", authTime: now() }, { ...req, stepUpOnly: true, existingSession: { id: s.id, personId: "p-asha" } });
    expect(r2.ok).toBe(false);
    expect((await q(`select idp_subject from people where id = 'p-tomas'`))[0].idp_subject).toBeNull();
  });

  it("unauthenticated sign-in failures are sampled per source and a missing state cookie writes no ledger event", async () => {
    const meta = { ip: "198.51.100.77", userAgent: "probe", requestId: "x", method: "sso" as const };
    const events0 = (await q(`select count(*)::int n from events`))[0].n as number;
    for (let i = 0; i < 40; i++) await recordSignInFailure(g(), meta, "state_missing");
    expect((await q(`select count(*)::int n from signins where source_ip = '198.51.100.77'`))[0].n).toBeLessThanOrEqual(5);
    expect((await q(`select count(*)::int n from events`))[0].n).toBe(events0);
    const meta2 = { ...meta, ip: "198.51.100.78" };
    for (let i = 0; i < 40; i++) await recordSignInFailure(g(), meta2, "idp_rejected");
    const n = (await q(`select count(*)::int n from events where type = 'auth.signin_failed' and source_ip = '198.51.100.78'`))[0].n as number;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);
  });

  it("polling marked as background does not keep a session from going idle; real activity does", async () => {
    const s = await t.session("p-asha");
    const seen = async () => new Date((await q(`select last_seen_at from sessions where id = $1`, [s.id]))[0].last_seen_at).getTime();
    await q(`update sessions set last_seen_at = now() - interval '10 minutes' where id = $1`, [s.id]);
    const stale = await seen();
    const bg = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: s.cookie, "x-gantry-background": "1" } });
    expect(bg.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(await seen()).toBe(stale);
    const live = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: s.cookie } });
    expect(live.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(await seen()).toBeGreaterThan(stale);
  });

  it("the Security setting refuses a malformed IP allow-list entry, naming it", async () => {
    const s = await t.session("p-asha");
    const cur = (await t.app.inject({ method: "GET", url: "/api/v1/security", headers: s.headers })).json();
    const res = await t.app.inject({ method: "PATCH", url: "/api/v1/security", headers: { ...s.headers, "if-match": String(cur.version) }, payload: { path: "ipAllow", value: ["203.0.113.0/abc"] } });
    expect(res.statusCode).toBe(422);
    expect(res.json().msg).toContain("203.0.113.0/abc");
  });
});
