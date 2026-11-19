/** Sandbox review S-92 (per-source caps) and S-102 (failed-token attempt limit, a subnet that must parse). */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildGateway, type Gateway } from "../src/gateway.js";
import { buildProxy } from "../src/proxy.js";
import { SourceGuard } from "../src/source-guard.js";
import { baseConfig, FakeApi, makeToken } from "./helpers.js";

const warns: object[] = [];
const log = { info: () => undefined, warn: (o: object) => void warns.push(o), error: () => undefined };
// 127.0.0.1 is the "run" source in these tests
const RUNNET = "127.0.0.0/8";
const caps = (o: Partial<{ maxConnections: number; requestsPerMinute: number; tokenFailuresPerMinute: number }> = {}) => ({ maxConnections: 3, requestsPerMinute: 5, tokenFailuresPerMinute: 2, ...o });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  warns.length = 0;
});

const rawStatus = (port: number, req: string): Promise<string> =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(req));
    let b = "";
    s.on("data", (d) => (b += d.toString()));
    s.on("close", () => resolve(/^HTTP\/1\.1 (\d+)/.exec(b)?.[1] ?? "none"));
    s.on("error", () => resolve("error"));
    setTimeout(() => s.destroy(), 1500);
  });

describe("S-92: one run cannot starve the shared edge", () => {
  it("answers 429 and logs when a source holds too many connections, and recovers when they close", async () => {
    const g = new SourceGuard(caps(), RUNNET, log);
    const srv = http.createServer((_q, r) => r.end("ok"));
    g.attach(srv, "test");
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
    const port = (srv.address() as AddressInfo).port;
    const idle = await Promise.all([1, 2, 3].map(() => new Promise<net.Socket>((r) => { const s = net.connect(port, "127.0.0.1", () => r(s)); })));
    expect(await rawStatus(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")).toBe("429");
    expect(g.metrics.connectionsRefused).toBe(1);
    expect(warns).toContainEqual(expect.objectContaining({ kind: "connections:test", limit: 3 }));
    idle.forEach((s) => s.destroy());
    await new Promise((r) => setTimeout(r, 50));
    expect(await rawStatus(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")).toBe("200");
  });

  it("does not govern the control plane (a source outside the run subnet)", () => {
    const g = new SourceGuard(caps({ requestsPerMinute: 1 }), "10.213.0.0/16", log);
    for (let i = 0; i < 10; i++) expect(g.request("172.20.0.5")).toBe(true);
    expect(g.request("10.213.0.2")).toBe(true);
    expect(g.request("10.213.0.2")).toBe(false);
    expect(g.request("::ffff:10.213.0.2")).toBe(false);
  });

  it("the model gateway answers 429 over the per-source request rate, and /healthz stays up", async () => {
    const api = new FakeApi();
    await api.start();
    const gw: Gateway = buildGateway({ cfg: baseConfig({ apiUrl: api.url, runSubnet: RUNNET, sourceCaps: caps({ requestsPerMinute: 4 }) }), logger: false });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    closers.push(async () => { await gw.app.close(); await new Promise<void>((r) => api.server.close(() => r())); });
    const base = `http://127.0.0.1:${(gw.app.server.address() as AddressInfo).port}`;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await fetch(`${base}/run/v1/spec`, { headers: { authorization: `Bearer ${makeToken("r1")}` } })).status);
    expect(codes.slice(0, 4).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(4)).toEqual([429, 429, 429]);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(gw.guard.metrics.requestsRefused).toBe(3);
    const r = await fetch(`${base}/run/v1/spec`);
    expect(r.headers.get("retry-after")).toBe("5");
  });

  it("the proxy answers 429 over the per-source rate and keys tunnel slots by source, not by the claimed run id", async () => {
    const api = new FakeApi();
    await api.start();
    const px = buildProxy({ cfg: baseConfig({ apiUrl: api.url, runSubnet: RUNNET, sourceCaps: caps({ maxConnections: 1000, requestsPerMinute: 1000 }) }), logger: log, limits: { maxTunnelsPerRun: 2 } });
    await new Promise<void>((r) => px.server.listen(0, "127.0.0.1", r));
    closers.push(async () => { px.server.closeAllConnections(); await new Promise<void>((r) => px.server.close(() => r())); await new Promise<void>((r) => api.server.close(() => r())); });
    const port = (px.server.address() as AddressInfo).port;
    api.hosts = []; // admit stays pending-free: every CONNECT is refused after its slot was taken
    const hold: net.Socket[] = [];
    const open = (runId: string) => new Promise<number>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from(`run:${makeToken(runId)}`).toString("base64")}\r\n\r\n`));
      hold.push(s);
      let b = "";
      s.on("data", (d) => (b += d.toString()));
      s.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(b)?.[1] ?? 0)));
      s.on("error", () => resolve(0));
    });
    // each CONNECT carries a different forged run id from the same source
    const results = await Promise.all(["a", "b", "c", "d"].map((id) => open(`forged-${id}`)));
    hold.forEach((s) => s.destroy());
    // with per-id buckets none would be 429; keyed by source, the cap of 2 applies across the ids
    expect(results.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});

describe("G-S2: a new run on a reused address", () => {
  it("is not refused for the earlier run's requests once the address has been quiet", () => {
    let t = 1_000_000;
    const g = new SourceGuard(caps({ requestsPerMinute: 3 }), "10.213.0.0/16", log, () => t);
    for (let i = 0; i < 3; i++) expect(g.request("10.213.0.2")).toBe(true);
    expect(g.request("10.213.0.2")).toBe(false);
    t += 1000;
    expect(g.request("10.213.0.2")).toBe(false); // a flooding run that keeps calling keeps its count
    t += 6000; // run A is gone; run B gets the same address
    expect(g.request("10.213.0.2")).toBe(true);
  });
});

describe("S-102: attempts on the edge-token routes, and a subnet that must parse", () => {
  it("blocks a source after its failed token attempts, even for a later correct token, on /service/v1 and /mcp-admin/v1", async () => {
    const api = new FakeApi();
    await api.start();
    const gw = buildGateway({ cfg: baseConfig({ apiUrl: api.url, edgeToken: "the-real-edge-token", runSubnet: RUNNET, sourceCaps: caps({ requestsPerMinute: 1000, tokenFailuresPerMinute: 2 }) }), logger: false });
    await gw.app.listen({ host: "127.0.0.1", port: 0 });
    closers.push(async () => { await gw.app.close(); await new Promise<void>((r) => api.server.close(() => r())); });
    const base = `http://127.0.0.1:${(gw.app.server.address() as AddressInfo).port}`;
    const get = (path: string, tok: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.status);
    expect(await get("/service/v1/ready", "guess-1")).toBe(401);
    expect(await get("/service/v1/ready", "guess-2")).toBe(401);
    expect(await get("/service/v1/ready", "guess-3")).toBe(429);
    expect(await get("/service/v1/ready", "the-real-edge-token")).toBe(429);
    const admin = await fetch(`${base}/mcp-admin/v1/discover`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: "{}" });
    expect(admin.status).toBe(429);
    expect(gw.guard.metrics.tokenAttemptsRefused).toBeGreaterThanOrEqual(3);
  });

  it("refuses to start with an EDGE_RUN_SUBNET that does not parse (every caller would be 'system')", async () => {
    const env = { GANTRY_SECRETS_DIR: "/nonexistent" } as NodeJS.ProcessEnv;
    await expect(loadConfig({ ...env, EDGE_RUN_SUBNET: "10.213.0.0" })).rejects.toThrow(/EDGE_RUN_SUBNET/);
    await expect(loadConfig({ ...env, EDGE_RUN_SUBNET: "not-a-cidr" })).rejects.toThrow(/EDGE_RUN_SUBNET/);
    await expect(loadConfig({ ...env, EDGE_RUN_SUBNET: "10.213.0.0/16" })).rejects.toThrow(/secret edge_token/); // past the subnet check
  });
});
