/** S-24: operator recovery for a Factory Admin locked out by the IP allow-list. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTx } from "@gantry/db";
import { signIn } from "../src/core/auth/signin.js";
import { csrfFor } from "../src/core/auth/sessions.js";
import { openRecoveryWindow } from "../src/core/auth/ip-recovery-open.js";
import { TEST_URL, SESSION_KEY, startApp, type TestApp } from "./helpers.js";

const d = TEST_URL ? describe : describe.skip;
const now = () => Math.floor(Date.now() / 1000);
const AWAY = "203.0.113.50";
const HOME = "198.51.100.7";

d("allow-list recovery (S-24)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ config: { adminMfaOptional: false } });
  });
  afterAll(() => t.close());
  const g = () => t.app.gantry;
  const q = async (sql: string, p: unknown[] = []) => (await t.db.admin.query(sql, p)).rows;
  const setAllow = async (ipAllow: string[]) => {
    const sec = (await q(`select body from security_settings order by version desc limit 1`))[0].body;
    await q(`insert into security_settings (org_id, version, body, published_at) select org_id, max(version) + 1, $1::jsonb, now() from security_settings group by org_id`, [JSON.stringify({ ...sec, ipAllow })]);
    g().security.invalidate();
  };
  const claimsFor = async (id: string, acr = "2") => {
    const p = (await q(`select email, idp_subject from people where id = $1`, [id]))[0];
    return { sub: p.idp_subject ?? `kc-${id}`, email: p.email as string, emailVerified: true, authTime: now(), acr, gantryId: id };
  };
  const req = (ip: string) => ({ ip, userAgent: "vitest", requestId: "r", method: "sso" as const });
  const open = (person: string, minutes = 30) => withTx(g().pool, (tx) => openRecoveryWindow(tx, t.orgId, person, minutes));

  it("lets the named admin in once from any address, expires, and lets nobody else in; MFA still applies", async () => {
    await setAllow([HOME + "/32"]);
    // locked out: refused from AWAY, nothing opened
    const locked = await signIn(g(), await claimsFor("p-asha"), req(AWAY));
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.reason).toBe("ip_not_allowed");

    // the operator command: bad input is refused, an unknown or non-admin person is refused
    await expect(open("p-asha", 61)).rejects.toThrow(/1 to 60/);
    await expect(open("p-nobody")).rejects.toThrow(/no person/);
    await expect(open("p-tomas")).rejects.toThrow(/not a Factory Admin/);
    const w = await open("p-asha", 30);
    expect(w.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    const ev = (await q(`select actor, category, after from events where type = 'auth.allowlist_recovery.opened' order by seq desc limit 1`))[0];
    expect(ev).toMatchObject({ actor: "operator", category: "auth" });

    // nobody else gets in from AWAY
    const other = await signIn(g(), await claimsFor("p-tomas"), req(AWAY));
    expect(other.ok).toBe(false);
    // the admin without MFA is refused and the window is NOT spent
    const weak = await signIn(g(), await claimsFor("p-asha", "1"), req(AWAY));
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.reason).toBe("mfa_required");
    expect((await q(`select status from allowlist_recovery where id = $1`, [w.id]))[0].status).toBe("open");

    // with MFA: in, once
    const ok = await signIn(g(), await claimsFor("p-asha"), req(AWAY));
    expect(ok.ok).toBe(true);
    const again = await signIn(g(), await claimsFor("p-asha"), req(AWAY));
    expect(again.ok).toBe(false);
    expect((await q(`select status from allowlist_recovery where id = $1`, [w.id]))[0].status).toBe("used");
    expect((await q(`select actor from events where type = 'auth.allowlist_recovery.used' order by seq desc limit 1`))[0].actor).toBe("p-asha");

    // the recovered session works from that address only; a held cookie from another address is still refused; the list is unchanged
    if (!ok.ok || !ok.token) throw new Error("no session");
    const cookie = `${t.config.sessionCookie}=${ok.token}`;
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie }, remoteAddress: AWAY })).statusCode).toBe(200);
    expect((await t.app.inject({ url: "/api/v1/me", headers: { cookie }, remoteAddress: "203.0.113.99" })).statusCode).toBe(403);
    const cur = (await t.app.inject({ url: "/api/v1/security", headers: { cookie }, remoteAddress: AWAY })).json();
    expect(cur.ipAllow).toEqual([HOME + "/32"]);

    // the admin is asked in the app; confirming adds the address (audited), step-up still applies
    const pend = (await t.app.inject({ url: "/api/v1/security/recovery", headers: { cookie }, remoteAddress: AWAY })).json();
    expect(pend).toMatchObject({ pending: true, address: AWAY });
    const hdr = { cookie, "x-csrf-token": csrfFor(SESSION_KEY, ok.sessionId) };
    const conf = await t.app.inject({ method: "POST", url: "/api/v1/security/recovery/confirm", headers: hdr, payload: { add: true }, remoteAddress: AWAY });
    expect(conf.statusCode, conf.body).toBe(200);
    expect((await q(`select body->'ipAllow' as a from security_settings order by version desc limit 1`))[0].a).toEqual([HOME + "/32", AWAY]);
    expect((await q(`select 1 from events where type = 'auth.allowlist_recovery.address_added'`)).length).toBe(1);
    expect((await t.app.inject({ method: "POST", url: "/api/v1/security/recovery/confirm", headers: hdr, payload: { add: true }, remoteAddress: AWAY })).statusCode).toBe(409);
    await setAllow([]);
  });

  it("an expired window lets nobody in, and a refused address is not added unless the admin says so", async () => {
    await setAllow([HOME + "/32"]);
    const w = await open("p-asha", 5);
    await q(`update allowlist_recovery set expires_at = now() - interval '1 minute' where id = $1`, [w.id]);
    const r = await signIn(g(), await claimsFor("p-asha"), req(AWAY));
    expect(r.ok).toBe(false);
    // a fresh window; declining leaves the list as it was
    await open("p-asha", 5);
    const ok = await signIn(g(), await claimsFor("p-asha"), req(AWAY));
    expect(ok.ok).toBe(true);
    if (!ok.ok || !ok.token) throw new Error("no session");
    const hdr = { cookie: `${t.config.sessionCookie}=${ok.token}`, "x-csrf-token": csrfFor(SESSION_KEY, ok.sessionId) };
    const no = await t.app.inject({ method: "POST", url: "/api/v1/security/recovery/confirm", headers: hdr, payload: { add: false }, remoteAddress: AWAY });
    expect(no.statusCode, no.body).toBe(200);
    expect((await q(`select body->'ipAllow' as a from security_settings order by version desc limit 1`))[0].a).toEqual([HOME + "/32"]);
    await setAllow([]);
  });

  it("is not reachable over HTTP: no route opens a window, and no route module imports the opener", async () => {
    for (const [method, url] of [["POST", "/api/v1/security/recovery"], ["PUT", "/api/v1/security/recovery"], ["POST", "/api/v1/security/recovery/open"], ["POST", "/api/v1/security/recovery-window"], ["POST", "/auth/recovery"]] as const) {
      const s = await t.session("p-asha");
      const r = await t.app.inject({ method, url, headers: s.headers, payload: { person: "p-asha", minutes: 30 } });
      expect(r.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400);
      expect(r.statusCode, `${method} ${url}`).not.toBe(422);
    }
    expect((await q(`select 1 from allowlist_recovery where status = 'open'`)).length).toBe(0);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
    const importers = walk(join(__dirname, "../src")).filter((f) => /ip-recovery-open/.test(readFileSync(f, "utf8")) && !f.endsWith("ip-recovery-open.ts"));
    expect(importers.map((f) => f.split("/src/")[1])).toEqual(["cli/allowlist-recovery.ts"]);
  });
});
