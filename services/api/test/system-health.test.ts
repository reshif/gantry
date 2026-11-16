import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, enqueueOutbox, withTx } from "@gantry/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGateFor } from "../src/core/read-gates.js";
import { readBackup, readDrill, redactError, shownDestination, type Probe } from "../src/areas/system/health.js";
import { systemOverrides } from "../src/routes/system.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const ADMIN = "p-asha";
const NOBODY = "p-tomas";
const HOUR = 3_600_000;

describe("system health read gate", () => {
  it("is gated by a factory-level read right", () => {
    expect(readGateFor("/api/v1/system/health")).toEqual({ action: "integrations.view", project: null });
    expect(readGateFor("/api/v1/system/outbox/x/retry")).toEqual({ action: "integrations.view", project: null });
  });
});

describe("dead letter masking", () => {
  it("masks urls, addresses and token-like strings in a factory row", () => {
    const out = redactError("POST https://hooks.slack.com/services/T000/B000/abcdefghijklmnopqrstuvwx failed 500 for a@b.example", false)!;
    expect(out).not.toContain("hooks.slack.com");
    expect(out).not.toContain("a@b.example");
    expect(out).toContain("[url]");
    expect(redactError("token abcdefghijklmnopqrstuvwxyz0123456789", false)).toContain("[redacted]");
  });
  it("gives a project's own delivery only a generic reason, and no target", () => {
    expect(redactError("HTTP 502 from https://x.example/hook?k=secret", true)).toBe("Delivery failed (HTTP 502). See the project's delivery log.");
    expect(shownDestination("slack:team:#private-channel", true)).toBe("slack");
    expect(shownDestination("slack:team:#private-channel", false)).toBe("slack:team");
    expect(shownDestination("smtp", false)).toBe("smtp");
  });
});

describe("backup and drill status files", () => {
  let dir: string;
  const now = new Date("2026-11-16T12:00:00Z");
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "gantry-bk-")); });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("is unknown when the files are absent", async () => {
    expect((await readBackup(dir, now)).status).toBe("unknown");
    expect((await readDrill(dir, now)).status).toBe("unknown");
  });
  it("is ok when recent, stale past 26 hours, failed when the attempt failed", async () => {
    await writeFile(join(dir, "last-backup.json"), JSON.stringify({ set: "20261116T020000Z", at: "2026-11-16T02:00:00Z", ok: true }));
    expect(await readBackup(dir, now)).toMatchObject({ status: "ok", ageHours: 10, set: "20261116T020000Z" });
    await writeFile(join(dir, "last-backup.json"), JSON.stringify({ set: "s", at: "2026-11-15T08:00:00Z", ok: true }));
    expect(await readBackup(dir, now)).toMatchObject({ status: "stale", ageHours: 28 });
    await writeFile(join(dir, "last-backup.json"), JSON.stringify({ at: "2026-11-16T11:00:00Z", ok: false }));
    expect((await readBackup(dir, now)).status).toBe("failed");
    await writeFile(join(dir, "last-backup.json"), "not json");
    expect((await readBackup(dir, now)).status).toBe("unknown");
  });
  it("reads the drill result and counts failed checks", async () => {
    await writeFile(join(dir, "last-drill.json"), JSON.stringify({ set: "s", at: "2026-11-16T03:00:00Z", ok: false, seconds: 41, checks: [{ ok: true }, { ok: false }] }));
    expect(await readDrill(dir, now)).toMatchObject({ status: "failed", seconds: 41, failedChecks: 1, ageHours: 9 });
    await writeFile(join(dir, "last-drill.json"), JSON.stringify({ set: "s", at: "2026-11-16T03:00:00Z", ok: true, seconds: 30, checks: [] }));
    expect((await readDrill(dir, now)).status).toBe("ok");
  });
});

const d = TEST_URL ? describe : describe.skip;

d("GET /api/v1/system/health and the dead letter retry", () => {
  let t: TestApp;
  let dir: string;
  const probe: Probe = async (url) => {
    if (url.includes("github")) return { ok: true, status: 200, ms: 4, body: { ok: true, configured: false, reason: "GitHub App is not configured" } };
    return { ok: true, status: 200, ms: 3 };
  };
  const targets = { edge: "http://edge", broker: "http://github", objectStore: "http://objects" };
  const q = (sql: string, args: unknown[] = []) => t.db.admin.query(sql, args);

  beforeAll(async () => {
    t = await startApp();
    dir = await mkdtemp(join(tmpdir(), "gantry-bk-"));
    await writeFile(join(dir, "last-backup.json"), JSON.stringify({ set: "s1", at: new Date(Date.now() - 30 * HOUR).toISOString(), ok: true }));
    Object.assign(systemOverrides, { probe, targets, backupsDir: dir });
  });
  afterAll(async () => {
    for (const k of Object.keys(systemOverrides)) delete (systemOverrides as Record<string, unknown>)[k];
    await rm(dir, { recursive: true, force: true });
    await t.close();
  });

  const event = (i: number) => withTx(t.db.admin, (tx) => appendEvent(tx, { orgId: t.orgId, type: "test.event", category: "integrations", actor: "test", channel: "system", subject: { type: "test", id: `e${i}` } } as never));
  async function deadRow(i: number, dest = "slack"): Promise<string> {
    const ev = await event(i);
    const r = await withTx(t.db.admin, (tx) => enqueueOutbox(tx, { orgId: t.orgId, eventId: ev.id, destination: dest, payload: { secret: "never-shown" } }));
    await q(`update outbox set status = 'dead', attempts = 8, last_error = 'HTTP 500 from slack' where id = $1`, [r.id]);
    return r.id;
  }

  it("refuses a person with only project roles (no factory-level right), and anyone not signed in", async () => {
    const s = await t.session(NOBODY);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/system/health", headers: s.headers })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/system/health" })).statusCode).toBe(401);
    const post = await t.app.inject({ method: "POST", url: "/api/v1/system/outbox/x/retry", headers: s.headers });
    expect([403, 404]).toContain(post.statusCode);
  });

  it("reports services, backup status, outbox counts with dead letters, and stuck jobs, without payloads", async () => {
    const id = await deadRow(1);
    await q(`delete from worker_heartbeats`);
    await q(`insert into worker_heartbeats (org_id, worker_id, seen_at, launcher_ok, launcher_checked_at) select id, 'w-test', now() - interval '12 seconds', false, now() - interval '5 seconds' from orgs`);
    await q(`insert into jobs (org_id, id, kind, status, lease_owner, lease_until, started_at, attempts) values ($1, 'j-expired', 'flow.advance', 'running', 'w1', now() - interval '5 minutes', now() - interval '10 minutes', 1)`, [t.orgId]);
    await q(`insert into jobs (org_id, id, kind, status, lease_owner, lease_until, started_at) values ($1, 'j-long', 'attempt.dispatch', 'running', 'w1', now() + interval '1 minute', now() - interval '3 hours')`, [t.orgId]);
    await q(`insert into jobs (org_id, id, kind, status, lease_owner, lease_until, started_at) values ($1, 'j-fine', 'attempt.dispatch', 'running', 'w1', now() + interval '1 minute', now() - interval '3 minutes')`, [t.orgId]);
    const res = await t.app.inject({ method: "GET", url: "/api/v1/system/health", headers: (await t.session(ADMIN)).headers });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    const svc = Object.fromEntries(b.services.map((s: { id: string }) => [s.id, s]));
    expect(svc.api.status).toBe("ok");
    expect(svc.db.status).toBe("ok");
    expect(svc.edge.status).toBe("ok");
    expect(svc.objects.status).toBe("ok");
    expect(svc.launcher.status).toBe("down");
    expect(svc.github).toMatchObject({ status: "degraded", detail: "GitHub App is not configured" });
    expect(svc.worker.status).toBe("ok");
    expect(svc.worker.heartbeatAgeSeconds).toBeGreaterThanOrEqual(12);
    expect(svc.worker.heartbeatAgeSeconds).toBeLessThan(40);
    expect(b.backup).toMatchObject({ status: "stale", set: "s1" });
    expect(b.drill.status).toBe("unknown");
    expect(b.outbox.counts.dead).toBe(1);
    expect(b.outbox.dead[0]).toMatchObject({ id, destination: "slack", attempts: 8, lastError: "HTTP 500 from slack" });
    expect(JSON.stringify(b)).not.toContain("never-shown");
    expect(b.jobs.stuck.map((j: { id: string; reason: string }) => [j.id, j.reason]).sort()).toEqual([["j-expired", "lease_expired"], ["j-long", "running_long"]]);
  });

  it("lists at most the 20 newest dead letters", async () => {
    for (let i = 10; i < 32; i++) await deadRow(i, `d${i}`);
    const b = (await t.app.inject({ method: "GET", url: "/api/v1/system/health", headers: (await t.session(ADMIN)).headers })).json();
    expect(b.outbox.dead).toHaveLength(20);
    expect(b.outbox.counts.dead).toBeGreaterThanOrEqual(23);
  });

  it("reports the launcher as the worker last saw it: answering, down, or unknown when stale or never reported", async () => {
    const launcher = async () => (await t.app.inject({ method: "GET", url: "/api/v1/system/health", headers: (await t.session(ADMIN)).headers })).json().services.find((s: { id: string }) => s.id === "launcher");
    await q(`delete from worker_heartbeats`);
    expect((await launcher()).status).toBe("unknown");
    await q(`insert into worker_heartbeats (org_id, worker_id, launcher_ok, launcher_checked_at) select id, 'w1', true, now() - interval '4 seconds' from orgs`);
    expect((await launcher()).status).toBe("ok");
    await q(`update worker_heartbeats set launcher_ok = false`);
    expect((await launcher()).status).toBe("down");
    await q(`update worker_heartbeats set launcher_checked_at = now() - interval '10 minutes'`);
    expect((await launcher()).status).toBe("unknown");
  });

  it("judges the worker by its heartbeat age: late, gone, never seen", async () => {
    const worker = async () => (await t.app.inject({ method: "GET", url: "/api/v1/system/health", headers: (await t.session(ADMIN)).headers })).json().services.find((s: { id: string }) => s.id === "worker");
    await q(`delete from jobs where org_id = $1`, [t.orgId]);
    await q(`update worker_heartbeats set seen_at = now() - interval '45 seconds'`);
    expect((await worker()).status).toBe("degraded");
    await q(`update worker_heartbeats set seen_at = now() - interval '10 minutes'`);
    const gone = await worker();
    expect(gone.status).toBe("down");
    expect(gone.heartbeatAgeSeconds).toBeGreaterThanOrEqual(600);
    await q(`delete from worker_heartbeats`);
    const never = await worker();
    expect(never.status).toBe("unknown");
    expect(never.heartbeatAgeSeconds).toBeNull();
  });

  it("says the worker is down when work is due and nothing runs and no heartbeat exists", async () => {
    await q(`delete from worker_heartbeats`);
    await q(`delete from jobs where org_id = $1`, [t.orgId]);
    await q(`insert into jobs (org_id, id, kind, status, run_at) values ($1, 'j-due', 'flow.advance', 'queued', now() - interval '10 minutes')`, [t.orgId]);
    const b = (await t.app.inject({ method: "GET", url: "/api/v1/system/health", headers: (await t.session(ADMIN)).headers })).json();
    expect(b.services.find((s: { id: string }) => s.id === "worker").status).toBe("down");
  });

  it("requeues one dead delivery, audits it, and refuses a delivery that is not dead", async () => {
    const id = await deadRow(100, "teams");
    const admin = await t.session(ADMIN);
    const res = await t.app.inject({ method: "POST", url: `/api/v1/system/outbox/${id}/retry`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    const row = (await q(`select status, attempts, last_error, lease_owner from outbox where id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "pending", attempts: 0, last_error: null, lease_owner: null });
    const ev = (await q(`select actor, after from events where type = 'system.outbox.retry' and subject->>'id' = $1`, [id])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].actor).toBe(ADMIN);
    expect(ev[0].after).toMatchObject({ destination: "teams" });
    const again = await t.app.inject({ method: "POST", url: `/api/v1/system/outbox/${id}/retry`, headers: admin.headers });
    expect(again.statusCode).toBe(409);
    const missing = await t.app.inject({ method: "POST", url: "/api/v1/system/outbox/nope/retry", headers: admin.headers });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses the retry to a person with only project roles, leaving the row dead", async () => {
    const id = await deadRow(101, "email");
    const s = await t.session(NOBODY);
    const res = await t.app.inject({ method: "POST", url: `/api/v1/system/outbox/${id}/retry`, headers: s.headers });
    expect(res.statusCode).toBe(403);
    expect((await q(`select status from outbox where id = $1`, [id])).rows[0].status).toBe("dead");
  });

  it("masks the error text and target of a dead letter, and shows a project's delivery only generically", async () => {
    const f = await event(200);
    const fr = await withTx(t.db.admin, (tx) => enqueueOutbox(tx, { orgId: t.orgId, eventId: f.id, destination: "slack:main:#ops", payload: {} }));
    await q(`update outbox set status = 'dead', last_error = 'POST https://hooks.slack.com/services/T0/B0/abcdefghijklmnopqrstuvwx answered 404' where id = $1`, [fr.id]);
    const pe = await withTx(t.db.admin, (tx) => appendEvent(tx, { orgId: t.orgId, type: "test.event", category: "integrations", actor: "test", channel: "system", projectId: "p-atlas", subject: { type: "test", id: "e201" } } as never));
    const pr = await withTx(t.db.admin, (tx) => enqueueOutbox(tx, { orgId: t.orgId, eventId: pe.id, destination: "slack:main:#secret-project-room", payload: {} }));
    await q(`update outbox set status = 'dead', last_error = 'POST https://hooks.example/private-hook answered 503' where id = $1`, [pr.id]);
    const b = (await t.app.inject({ method: "GET", url: "/api/v1/system/health", headers: (await t.session(ADMIN)).headers })).json();
    const text = JSON.stringify(b);
    expect(text).not.toContain("hooks.slack.com");
    expect(text).not.toContain("private-hook");
    expect(text).not.toContain("#secret-project-room");
    const byId = Object.fromEntries(b.outbox.dead.map((r: { id: string }) => [r.id, r]));
    expect(byId[fr.id]).toMatchObject({ scope: "factory", destination: "slack:main" });
    expect(byId[pr.id]).toMatchObject({ scope: "project", destination: "slack", lastError: "Delivery failed (HTTP 503). See the project's delivery log." });
  });

  it("keeps the reason a delivery died in the audit record when it is retried", async () => {
    const id = await deadRow(300, "teams");
    await q(`update outbox set last_error = 'HTTP 410 gone' where id = $1`, [id]);
    const admin = await t.session(ADMIN);
    expect((await t.app.inject({ method: "POST", url: `/api/v1/system/outbox/${id}/retry`, headers: admin.headers })).statusCode).toBe(200);
    const ev = (await q(`select before from events where type = 'system.outbox.retry' and subject->>'id' = $1`, [id])).rows[0];
    expect(ev.before).toMatchObject({ status: "dead", attempts: 8, lastError: "HTTP 410 gone" });
  });
});
