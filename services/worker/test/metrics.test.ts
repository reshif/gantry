import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobsTotal, startMetricsServer } from "../src/metrics.js";

const PORT = 19000 + Math.floor(Math.random() * 3000);
const TOKEN = "worker-metrics-token";

describe("worker /metrics", () => {
  let server: Server | null;
  const url = `http://127.0.0.1:${PORT}/metrics`;
  beforeAll(async () => {
    server = await startMetricsServer(PORT, "127.0.0.1", [TOKEN]);
  });
  afterAll(() => {
    server?.close();
  });

  it("does not listen when the port is 0", async () => {
    expect(await startMetricsServer(0)).toBeNull();
  });

  it("serves the counters to a peer on the internal network", async () => {
    jobsTotal.inc({ kind: "test.kind", outcome: "done" });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const body = await res.text();
    expect(body).toContain('gantry_worker_jobs_total{kind="test.kind",outcome="done"} 1');
    expect(body).toContain("gantry_worker_up 1");
  });

  it("refuses a request that came through a proxy unless it holds the token", async () => {
    expect((await fetch(url, { headers: { "x-forwarded-for": "203.0.113.5" } })).status).toBe(401);
    expect((await fetch(url, { headers: { "x-forwarded-for": "203.0.113.5", authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(url, { headers: { "x-forwarded-for": "203.0.113.5", authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("serves nothing else", async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/`)).status).toBe(404);
  });
});
