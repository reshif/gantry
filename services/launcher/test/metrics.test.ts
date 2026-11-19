import Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BIG_HOST } from "./host.js";
import { RunManager } from "../src/manager.js";
import { buildServer } from "../src/server.js";

const cfgR = loadConfig({}, BIG_HOST);
if (!cfgR.ok) throw new Error(cfgR.error.msg);
const TOKEN = "t".repeat(40);
const MT = "m".repeat(24);
const manager = () => new RunManager(new Docker({ socketPath: "/nonexistent.sock" }), cfgR.value);
const withToken = buildServer({ cfg: cfgR.value, manager: manager(), token: TOKEN, metricsToken: MT, logger: false });
const without = buildServer({ cfg: cfgR.value, manager: manager(), token: TOKEN, logger: false });
const scrape = (a: typeof withToken, remoteAddress: string, headers: Record<string, string> = {}) => a.inject({ method: "GET", url: "/metrics", remoteAddress, headers });

describe("launcher /metrics", () => {
  it("serves the Prometheus format to the internal network", async () => {
    const r = await scrape(withToken, "172.20.0.4");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain; version=0.0.4");
    expect(r.body).toContain("gantry_launcher_run_capacity");
    expect(r.body).toContain("gantry_launcher_docker_up 0");
  });
  it("counts requests by route pattern", async () => {
    await withToken.inject({ method: "GET", url: "/v1/runs" });
    const r = await scrape(withToken, "172.20.0.4");
    expect(r.body).toMatch(/gantry_launcher_requests_total\{method="GET",route="\/v1\/runs",status="4xx"\} 1/);
  });
  it("refuses outside peers and proxied requests, accepts either token", async () => {
    expect((await scrape(withToken, "203.0.113.5")).statusCode).toBe(401);
    expect((await scrape(withToken, "203.0.113.5", { authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await scrape(withToken, "172.20.0.4", { "x-forwarded-for": "203.0.113.5" })).statusCode).toBe(401);
    expect((await scrape(withToken, "203.0.113.5", { authorization: `Bearer ${MT}` })).statusCode).toBe(200);
    expect((await scrape(withToken, "203.0.113.5", { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(200);
  });
  it("with no metrics token configured, a stray token opens nothing from outside", async () => {
    expect((await scrape(without, "203.0.113.5", { authorization: "Bearer m" })).statusCode).toBe(401);
  });
});
