import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";

const TOKEN = "metrics-token-for-tests";
const run = TEST_URL ? describe : describe.skip;

run("/metrics", () => {
  let t: TestApp;
  let dir: string;
  const get = (over: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
    t.app.inject({ method: "GET", url: "/metrics", remoteAddress: over.remoteAddress ?? "172.20.0.9", headers: over.headers ?? {} });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gantry-metrics-"));
    await writeFile(join(dir, "last-backup.json"), JSON.stringify({ set: "s", at: new Date(Date.now() - 3 * 3_600_000).toISOString(), ok: true }));
    t = await startApp({ build: { metricsTokens: [TOKEN], backupsDir: dir } });
  });
  afterAll(async () => {
    await t?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the Prometheus format to a peer on the internal network", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; version=0.0.4");
    expect(res.headers["cache-control"]).toBe("no-store");
    for (const name of ["gantry_jobs{", "gantry_jobs_queue_depth", "gantry_jobs_stuck", "gantry_outbox_dead_letters", "gantry_spend_month_micros", "gantry_budget_halts_active", "gantry_runs_finished_24h{", "gantry_backup_age_seconds", "gantry_database_up 1"]) {
      expect(res.body).toContain(name);
    }
    const age = Number(/^gantry_backup_age_seconds (\S+)$/m.exec(res.body)?.[1]);
    expect(age).toBeGreaterThan(3 * 3600 - 60);
    expect(age).toBeLessThan(3 * 3600 + 600);
  });

  it("counts requests by route pattern, status class and latency, and never by raw path", async () => {
    await t.app.inject({ method: "GET", url: "/api/v1/me" });
    await t.app.inject({ method: "GET", url: "/no/such/path/12345" });
    const body = (await get()).body;
    expect(body).toMatch(/gantry_http_requests_total\{method="GET",route="[^"]*",status="[24]xx"\} \d+/);
    expect(body).toContain('route="unmatched"');
    expect(body).not.toContain("12345");
    expect(body).toContain("gantry_http_request_duration_seconds_bucket{");
  });

  it("reads the queue and dead letters from the database", async () => {
    await t.db.admin.query(`insert into jobs (org_id, kind, status, run_at) values ($1, 'test.kind', 'queued', now() - interval '5 minutes')`, [t.orgId]);
    const body = (await get()).body;
    expect(body).toMatch(/gantry_jobs_queue_depth\{queue="default"\} 1/);
    expect(Number(/^gantry_jobs_oldest_due_seconds (\S+)$/m.exec(body)?.[1])).toBeGreaterThan(250);
  });

  it("refuses a peer outside the internal network, with or without a wrong token", async () => {
    expect((await get({ remoteAddress: "203.0.113.5" })).statusCode).toBe(401);
    expect((await get({ remoteAddress: "203.0.113.5", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
  });

  it("refuses an internal peer that came through the ingress", async () => {
    expect((await get({ headers: { "x-forwarded-for": "203.0.113.5" } })).statusCode).toBe(401);
  });

  it("accepts the metrics token from anywhere", async () => {
    const res = await get({ remoteAddress: "203.0.113.5", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
  });

  it("is not a session route: a signed-in person's cookie does not open it from outside", async () => {
    const s = await t.session("p-asha");
    const res = await t.app.inject({ method: "GET", url: "/metrics", remoteAddress: "203.0.113.5", headers: s.headers });
    expect(res.statusCode).toBe(401);
  });
});
