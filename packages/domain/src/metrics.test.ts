import { describe, expect, it } from "vitest";
import { MetricsRegistry, isInternalAddress, metricsAllowed } from "./metrics.js";

describe("MetricsRegistry", () => {
  it("renders counters, gauges and histograms in the Prometheus text format", async () => {
    const r = new MetricsRegistry();
    const c = r.counter("t_requests_total", "Requests.");
    const g = r.gauge("t_depth", "Depth.");
    const h = r.histogram("t_seconds", "Latency.", [0.1, 1]);
    c.inc({ route: '/a"b', status: "2xx" });
    c.inc({ route: '/a"b', status: "2xx" }, 2);
    g.set(4);
    h.observe(0.05, { route: "/x" });
    h.observe(0.5, { route: "/x" });
    const t = await r.render();
    expect(t).toContain("# TYPE t_requests_total counter");
    expect(t).toContain('t_requests_total{route="/a\\"b",status="2xx"} 3');
    expect(t).toContain("t_depth 4");
    expect(t).toContain('t_seconds_bucket{route="/x",le="0.1"} 1');
    expect(t).toContain('t_seconds_bucket{route="/x",le="1"} 2');
    expect(t).toContain('t_seconds_bucket{route="/x",le="+Inf"} 2');
    expect(t).toContain('t_seconds_count{route="/x"} 2');
  });
  it("runs collectors before rendering and survives one that throws", async () => {
    const r = new MetricsRegistry();
    const g = r.gauge("t_g", "G.");
    r.collect(() => { throw new Error("down"); });
    r.collect(() => g.set(7));
    expect(await r.render()).toContain("t_g 7");
  });
  it("caps the series per metric", async () => {
    const r = new MetricsRegistry();
    const c = r.counter("t_c", "C.");
    for (let i = 0; i < 2000; i++) c.inc({ id: String(i) });
    expect((await r.render()).split("\n").filter((l) => l.startsWith("t_c{")).length).toBe(500);
  });
});

describe("metricsAllowed", () => {
  const base = { remoteAddress: "172.20.0.5", headers: {}, tokens: ["s3cret"] };
  it("allows the internal network", () => expect(metricsAllowed(base)).toBe(true));
  it("refuses a public peer", () => expect(metricsAllowed({ ...base, remoteAddress: "203.0.113.9" })).toBe(false));
  it("refuses an internal peer that came through the ingress", () => expect(metricsAllowed({ ...base, headers: { "x-forwarded-for": "203.0.113.9" } })).toBe(false));
  it("allows a valid token from anywhere, refuses a wrong one", () => {
    expect(metricsAllowed({ ...base, remoteAddress: "203.0.113.9", headers: { authorization: "Bearer s3cret" } })).toBe(true);
    expect(metricsAllowed({ ...base, remoteAddress: "203.0.113.9", headers: { authorization: "Bearer nope" } })).toBe(false);
    expect(metricsAllowed({ remoteAddress: "203.0.113.9", headers: { authorization: "Bearer x" }, tokens: [""] })).toBe(false);
  });
  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.9.9", "192.168.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isInternalAddress(a)).toBe(true);
    for (const a of ["8.8.8.8", "172.32.0.1", "2001:db8::1", "", undefined]) expect(isInternalAddress(a)).toBe(false);
  });
});
