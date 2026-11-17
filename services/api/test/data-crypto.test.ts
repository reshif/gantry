import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@gantry/db";
import { logUrl } from "../src/core/app.js";
import { TEST_URL, startApp, SESSION_KEY, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";
import { anchorKeyFor, checkAnchors, writeAnchor } from "../src/core/audit-anchor.js";

const d = TEST_URL ? describe : describe.skip;
const DATA_KEY = Buffer.alloc(32, 7);
const EDGE = { authorization: "Bearer edge-token-for-tests" };

/** Wave 6 (data and crypto): the ledger cannot be grown without bound by callers who are refused, vendor-key reads are audited, and the chain is held to signed checkpoints. */
d("data and crypto hardening", () => {
  let t: TestApp;
  let anchorFile: string;
  beforeAll(async () => {
    anchorFile = join(await mkdtemp(join(tmpdir(), "gantry-anchor-")), "anchors.jsonl");
    t = await startApp({ config: { secrets: { sessionKey: SESSION_KEY, dataKey: DATA_KEY, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" }, auditAnchorFile: anchorFile } });
  });
  afterAll(() => t.close());
  const w = world(() => t);
  const count = async (sql: string, params: unknown[] = []) => Number((await t.db.admin.query(sql, params)).rows[0].n);

  it("anonymous failed callbacks write a bounded number of permanent rows", async () => {
    for (let i = 0; i < 40; i++) {
      const r = await t.app.inject({ method: "GET", url: "/auth/callback?code=x&state=y" });
      expect(r.statusCode).toBe(302);
    }
    expect(await count(`select count(*) n from events where type = 'auth.signin_failed' and actor = 'anonymous'`)).toBeLessThanOrEqual(5);
    expect(await count(`select count(*) n from signins where outcome = 'failed' and reason = 'state_missing'`)).toBeLessThanOrEqual(5);
    expect(await count(`select count(*) n from events where type = 'auth.signin_failed'`)).toBeGreaterThanOrEqual(1);
  });

  it("a signed-in person's refused requests write a bounded number of rows, and every answer is still 403", async () => {
    for (let i = 0; i < 40; i++) expect((await w.call("p-tomas", "GET", "/api/v1/audit/verify")).status).toBe(403);
    const n = await count(`select count(*) n from events where outcome = 'denied' and actor = 'p-tomas'`);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(5);
  });

  it("audits vendor-key reads (sampled, fingerprint only) and seals legacy envelopes to their row", async () => {
    const o = t.orgId;
    await t.db.admin.query(`insert into vendors (org_id, id, name, product, connected, endpoint, secret_enc) values ($1,'dc-legacy','L','x',true,'',$2), ($1,'dc-bound','B','x',true,'',$3), ($1,'dc-swap','S','x',true,'',$3)`, [o, encrypt("sk-legacy-secret-aaaa", DATA_KEY), encrypt("sk-bound-secret-bbbb", DATA_KEY, "vendor:dc-bound")]);
    const get = (id: string) => t.app.inject({ method: "GET", url: `/internal/v1/vendors/${id}/key`, headers: EDGE });
    // a ciphertext bound to one vendor does not open under another
    expect((await get("dc-swap")).statusCode).toBeGreaterThanOrEqual(400);
    for (let i = 0; i < 3; i++) expect((await get("dc-bound")).json()).toEqual({ ok: true, key: "sk-bound-secret-bbbb" });
    const rows = (await t.db.admin.query(`select actor, outcome, after from events where type = 'vendor.key.read' and subject->>'id' = 'dc-bound'`)).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].after)).not.toContain("sk-bound-secret-bbbb");
    expect(rows[0].after.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // legacy: still readable once, then re-sealed so it can no longer be opened without its row binding
    expect((await get("dc-legacy")).json().key).toBe("sk-legacy-secret-aaaa");
    const sealed = (await t.db.admin.query(`select secret_enc from vendors where id = 'dc-legacy'`)).rows[0].secret_enc as string;
    expect(decrypt(sealed, DATA_KEY).ok).toBe(false);
    expect(decrypt(sealed, DATA_KEY, "vendor:dc-legacy")).toMatchObject({ ok: true, value: "sk-legacy-secret-aaaa" });
    expect(await count(`select count(*) n from events where type = 'vendor.key.read' and subject->>'id' = 'dc-legacy' and after->>'resealed' = 'true'`)).toBe(1);
  });

  it("a rewritten or truncated ledger fails the signed checkpoints even though the chain is internally consistent", async () => {
    const key = anchorKeyFor(SESSION_KEY);
    const n0 = await writeAnchor(t.db.admin, t.orgId, anchorFile, key);
    expect(n0).toBeGreaterThan(0);
    expect(await writeAnchor(t.db.admin, t.orgId, anchorFile, key)).toBeNull(); // unchanged head: no new line
    expect(await checkAnchors(t.db.admin, t.orgId, anchorFile, key)).toEqual({ checked: 1 });
    const ok = await w.call("p-asha", "GET", "/api/v1/audit/verify");
    expect(ok.body).toMatchObject({ ok: true, checkpoints: 1 });
    // the database owner drops the tail and resets the counter: the chain still verifies on its own
    await t.db.admin.query(`alter table events disable trigger events_no_update_delete`);
    await t.db.admin.query(`alter table events disable trigger events_before_insert`);
    try {
      await t.db.admin.query(`delete from events where org_id = $1 and seq = $2`, [t.orgId, n0]);
      await t.db.admin.query(`update event_counters set last_seq = (select max(seq) from events where org_id = $1), last_hash = (select hash from events where org_id = $1 order by seq desc limit 1) where org_id = $1`, [t.orgId]);
    } finally {
      await t.db.admin.query(`alter table events enable trigger events_no_update_delete`);
      await t.db.admin.query(`alter table events enable trigger events_before_insert`);
    }
    expect(await checkAnchors(t.db.admin, t.orgId, anchorFile, key)).toEqual({ broken: { kind: "missing", seq: n0 } });
    const bad = await w.call("p-asha", "GET", "/api/v1/audit/verify");
    expect(bad.body).toMatchObject({ ok: false, anchorBroken: { kind: "missing" } });
    // a forged checkpoint (wrong key) is not accepted either
    const lines = (await readFile(anchorFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    await writeFile(anchorFile, `${JSON.stringify({ ...lines[0], hash: "0".repeat(64) })}\n`);
    expect(await checkAnchors(t.db.admin, t.orgId, anchorFile, key)).toEqual({ broken: { kind: "bad_mac", seq: n0 } });
  });

  it("a temp table named event_counters cannot hijack the ledger's counter", async () => {
    // Where the database owner is not the migration role (as here) the TEMP revoke cannot apply, so grant it and prove the functions hold anyway.
    await t.db.admin.query(`grant temporary on database ${(await t.db.admin.query(`select current_database() d`)).rows[0].d} to gantry_app`);
    const c = await t.db.app.connect();
    try {
      await c.query(`create temp table event_counters (org_id uuid, last_seq bigint, last_hash text)`);
      const ins = () => c.query(`insert into events (org_id, type, category, actor, channel) values ($1, 'x.shadow', 'config', 'tester', 'system') returning seq, prev_hash`, [t.orgId]);
      const a = (await ins()).rows[0];
      const b = (await ins()).rows[0];
      expect(Number(b.seq)).toBe(Number(a.seq) + 1);
      expect(b.prev_hash).not.toBe("0".repeat(64));
      expect((await c.query(`select count(*)::int n from pg_temp.event_counters`)).rows[0].n).toBe(0);
    } finally {
      c.release(true);
    }
    expect((await t.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    const cfg = (await t.db.admin.query(`select proconfig from pg_proc where proname in ('gantry_events_before_insert','gantry_event_head')`)).rows;
    expect(cfg).toHaveLength(2);
    for (const r of cfg) expect(String(r.proconfig)).toMatch(/search_path=pg_catalog, public, pg_temp/);
  });

  it("log lines never carry sign-in credentials", () => {
    expect(logUrl("/auth/login?invite=AAAAAAAAAAAAAAAAAAAAAAAA&login_hint=a%40b.c")).toBe("/auth/login?[redacted]");
    expect(logUrl("/auth/callback?code=abc&state=def&session_state=x")).toBe("/auth/callback?[redacted]");
    expect(logUrl("/api/v1/x?id_token_hint=eyJ&limit=5")).toBe("/api/v1/x?id_token_hint=[redacted]&limit=5");
    expect(logUrl("/api/v1/projects?limit=5")).toBe("/api/v1/projects?limit=5");
  });
});
