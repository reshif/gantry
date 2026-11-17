import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProxy, hostAllowed, inCidr, isPrivateAddress, type RunLimits } from "../src/proxy.js";
import { baseConfig, close, FakeApi, makeToken } from "./helpers.js";

const RUN = "run-w3-px";
const basic = (token: string): string => `Basic ${Buffer.from(`run:${token}`).toString("base64")}`;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Sends a CONNECT and returns the status line plus, when tunnelled, what the target echoed back. */
function connect(port: number, target: string, auth?: string, send = "ping"): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    let tunnelled = false;
    s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`));
    s.on("data", (d) => {
      buf += d.toString();
      if (!tunnelled && buf.startsWith("HTTP/1.1 200")) {
        tunnelled = true;
        buf = "";
        s.write(send);
      } else if (tunnelled && buf.length >= send.length + 5) s.end();
    });
    const done = (): void => resolve({ status: tunnelled ? 200 : Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0), body: buf });
    s.on("close", done);
    s.on("error", done);
  });
}

describe("forward proxy", () => {
  const api = new FakeApi();
  let echo: net.Server;
  let echoPort = 0;
  let web: http.Server;
  let webPort = 0;
  let px: ReturnType<typeof buildProxy>;
  let pxPort = 0;
  const TOKEN = makeToken(RUN);

  const startProxy = async (cfg = baseConfig({ apiUrl: api.url, allowedPorts: [echoPort, webPort], runSubnet: "10.213.0.0/16" }), resolve = async () => "127.0.0.1", limits?: Partial<RunLimits>): Promise<void> => {
    if (px) await new Promise<void>((r) => px.server.close(() => r()));
    px = buildProxy({ cfg, logger: log, resolve, ...(limits ? { limits } : {}) });
    await new Promise<void>((r) => px.server.listen(0, "127.0.0.1", r));
    pxPort = (px.server.address() as AddressInfo).port;
  };

  beforeAll(async () => {
    await api.start();
    echo = net.createServer((c) => c.on("data", (d) => c.write(`echo:${d.toString()}`)).on("error", () => undefined));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    echoPort = (echo.address() as AddressInfo).port;
    web = http.createServer((req, res) => res.end(`web ${req.headers.host} ${req.url} ${req.headers["proxy-authorization"] ?? "no-proxy-auth"}`));
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
    webPort = (web.address() as AddressInfo).port;
    await startProxy();
  });
  afterAll(async () => {
    await new Promise<void>((r) => px.server.close(() => r()));
    echo.close();
    await Promise.all([close(api.server), close(web)]);
  });
  beforeEach(async () => {
    api.calls = [];
    api.down = false;
    api.override = undefined;
    api.hosts = ["registry.npmjs.org", "*.allowed.example", "127.0.0.1"];
    await new Promise((r) => setTimeout(r, 250)); // let the 200ms allow-list cache lapse
  });

  it("matches host patterns", () => {
    expect(hostAllowed("registry.npmjs.org", ["registry.npmjs.org"])).toBe(true);
    expect(hostAllowed("Registry.NPMJS.org.", ["registry.npmjs.org"])).toBe(true);
    expect(hostAllowed("a.b.allowed.example", ["*.allowed.example"])).toBe(true);
    expect(hostAllowed("allowed.example", ["*.allowed.example"])).toBe(false);
    expect(hostAllowed("evilallowed.example", ["*.allowed.example"])).toBe(false);
    expect(hostAllowed("registry.npmjs.org.evil.com", ["registry.npmjs.org"])).toBe(false);
  });

  it("knows private and run-subnet addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "140.82.112.3"]) expect(isPrivateAddress(a), a).toBe(false);
    // IPv6 spellings that embed or alias a private IPv4 address (DNS rebinding of an allowed name to an AAAA record).
    for (const a of ["::ffff:7f00:1", "0:0:0:0:0:ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "2002:7f00:1::", "fe80::1%eth0", "fec0::1", "ff02::1", "::", "not-an-ip"]) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) expect(isPrivateAddress(a), a).toBe(false);
    expect(inCidr("10.213.4.9", "10.213.0.0/16")).toBe(true);
    expect(inCidr("::ffff:10.213.4.9", "10.213.0.0/16")).toBe(true);
    expect(inCidr("10.214.4.9", "10.213.0.0/16")).toBe(false);
  });

  it("T8: tunnels HTTPS CONNECT to a listed host for a run with a valid token", async () => {
    const r = await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN));
    expect(r.status).toBe(200);
    expect(r.body).toBe("echo:ping");
    const c = api.of("/egress")[0]!;
    expect(c.url).toBe(`/internal/v1/runs/${RUN}/egress`);
    expect(JSON.parse(c.body)).toEqual({ token: TOKEN });
    expect(px.metrics.allowed).toBeGreaterThan(0);
  });

  it("T8: refuses an unlisted host with 403, logs it, and reports the refusal to the API", async () => {
    const before = px.metrics.denied;
    const r = await connect(pxPort, `evil.example.com:${echoPort}`, basic(TOKEN));
    expect(r.status).toBe(403);
    expect(r.body).toContain("not on the allow-list");
    expect(px.metrics.denied).toBe(before + 1);
    await new Promise((res) => setTimeout(res, 50));
    const rep = JSON.parse(api.of("/egress/denied")[0]!.body);
    expect(rep).toMatchObject({ runId: RUN, caller: "run", host: "evil.example.com", port: echoPort });
    // Deduplicated: the same refusal again within a minute is not reported twice.
    await connect(pxPort, `evil.example.com:${echoPort}`, basic(TOKEN));
    await new Promise((res) => setTimeout(res, 50));
    expect(api.of("/egress/denied")).toHaveLength(1);
  });

  it("refuses a listed host on a port that is not allowed", async () => {
    const r = await connect(pxPort, "registry.npmjs.org:22", basic(TOKEN));
    expect(r.status).toBe(403);
    expect(r.body).toContain("Port 22");
  });

  it("refuses a stopped or revoked run (API refuses the allow-list)", async () => {
    api.override = (c) => (c.url.endsWith("/egress") ? [409, { ok: false, msg: "Killed at wo scope." }] : undefined);
    const r = await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN));
    expect(r.status).toBe(403);
    expect(r.body).toContain("Killed");
  });

  it("cuts an established CONNECT tunnel when the run is refused after it was opened (revoked token, stop)", async () => {
    await startProxy(baseConfig({ apiUrl: api.url, allowedPorts: [echoPort, webPort], runSubnet: "10.213.0.0/16", tunnelCheckMs: 100 }));
    const s = net.connect(pxPort, "127.0.0.1");
    let buf = "";
    let closed = false;
    s.on("data", (d) => (buf += d.toString()));
    s.on("close", () => (closed = true));
    s.on("error", () => undefined);
    await new Promise<void>((r) => s.on("connect", r));
    s.write(`CONNECT registry.npmjs.org:${echoPort} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basic(TOKEN)}\r\n\r\n`);
    await vi.waitFor(() => expect(buf).toContain("200 Connection Established"));
    s.write("hello");
    await vi.waitFor(() => expect(buf).toContain("echo:hello"));
    // still allowed: the tunnel survives a re-check
    await new Promise((r) => setTimeout(r, 350));
    expect(closed).toBe(false);
    // the run is stopped: the next re-check cuts it
    api.override = (c) => (c.url.endsWith("/egress") ? [409, { ok: false, msg: "Killed at wo scope." }] : undefined);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 3000 });
    expect(px.metrics.cut).toBe(1);
    await startProxy();
  });

  it("fails closed with 503 when the API is down", async () => {
    api.down = true;
    const r = await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN));
    expect(r.status).toBe(503);
    expect(px.metrics.allowed).toBeGreaterThanOrEqual(0);
  });

  it("caches the allow-list briefly, then asks again", async () => {
    await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN));
    await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN));
    expect(api.of("/egress")).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 250));
    await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN));
    expect(api.of("/egress")).toHaveLength(2);
  });

  it("refuses bad credentials (407)", async () => {
    expect((await connect(pxPort, `registry.npmjs.org:${echoPort}`, "Basic !!!notbase64")).status).toBe(407);
    expect((await connect(pxPort, `registry.npmjs.org:${echoPort}`, `Basic ${Buffer.from("run:not-a-token").toString("base64")}`)).status).toBe(407);
    expect((await connect(pxPort, `registry.npmjs.org:${echoPort}`, "Bearer abc")).status).toBe(407);
    expect(api.of("/egress")).toHaveLength(0);
  });

  it("the worker (no credentials, outside the run subnet) gets the system allow-list only", async () => {
    api.systemHosts = ["hooks.slack.com", "127.0.0.1"];
    const ok = await connect(pxPort, `127.0.0.1:${echoPort}`);
    expect(ok.status).toBe(200);
    expect(api.of("/egress/system")).toHaveLength(1);
    const no = await connect(pxPort, `registry.npmjs.org:${echoPort}`);
    expect(no.status).toBe(403);
    expect(JSON.parse(api.of("/egress/denied")[0]!.body)).toMatchObject({ caller: "system", host: "registry.npmjs.org" });
  });

  it("a caller inside the run subnet without a token is refused with 407", async () => {
    await startProxy(baseConfig({ apiUrl: api.url, allowedPorts: [echoPort], runSubnet: "127.0.0.0/8" }));
    try {
      const r = await connect(pxPort, `127.0.0.1:${echoPort}`);
      expect(r.status).toBe(407);
      expect(r.body).toContain("run network");
      expect(api.of("/egress/system")).toHaveLength(0);
    } finally {
      await startProxy();
    }
  });

  it("blocks a listed name that resolves to a private address (SSRF guard), and a literal private IP", async () => {
    await startProxy(baseConfig({ apiUrl: api.url, allowedPorts: [echoPort], blockPrivateAddresses: true }));
    try {
      expect((await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN))).status).toBe(403); // the test resolver maps it to 127.0.0.1
      expect((await connect(pxPort, `127.0.0.1:${echoPort}`, basic(TOKEN))).status).toBe(403);
    } finally {
      await startProxy();
    }
  });

  it("forwards plain HTTP to a listed host and strips the proxy credentials", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve) => {
      const rq = http.request({ host: "127.0.0.1", port: pxPort, method: "GET", path: `http://127.0.0.1:${webPort}/pkg/x?y=1`, headers: { host: `127.0.0.1:${webPort}`, "proxy-authorization": basic(TOKEN) } }, (r) => {
        let b = "";
        r.on("data", (d) => (b += d));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: b }));
      });
      rq.end();
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(`web 127.0.0.1:${webPort} /pkg/x?y=1 no-proxy-auth`);
  });

  it("refuses plain HTTP to an unlisted host and answers 400 to a non-proxy request", async () => {
    const get = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve) => http.request({ host: "127.0.0.1", port: pxPort, path, headers }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).end());
    expect(await get(`http://nope.example.org:${webPort}/`, { "proxy-authorization": basic(TOKEN) })).toBe(403);
    expect(await get("/anything")).toBe(400);
    expect(await get("/healthz")).toBe(200);
  });

  describe("per-run limits (one run cannot starve the shared edge or bloat the audit ledger)", () => {
    afterAll(async () => { await startProxy(); });

    it("records at most N denied-egress events a minute per run, then one summary, and counts the rest", async () => {
      await startProxy(undefined, undefined, { deniedEventsPerMinute: 3 });
      for (let i = 0; i < 8; i++) await connect(pxPort, `evil${i}.example.com:${echoPort}`, basic(TOKEN));
      await new Promise((res) => setTimeout(res, 100));
      const events = api.of("/egress/denied").map((c) => JSON.parse(c.body) as { host: string; reason: string });
      expect(events).toHaveLength(3);
      expect(events[2]!.host).toBe("(many hosts)");
      expect(events[2]!.reason).toContain("further denials");
      expect(px.metrics.deniedSuppressed).toBe(5);
      expect(px.metrics.denied).toBe(8); // still refused and logged, only the ledger write is capped
    });

    it("refuses a run's tunnels past the per-run cap with 429, and frees the slot when one closes", async () => {
      await startProxy(undefined, undefined, { maxTunnelsPerRun: 2 });
      const open = async (): Promise<net.Socket> => {
        const sk = net.connect(pxPort, "127.0.0.1");
        let buf = "";
        sk.on("error", () => undefined);
        sk.on("data", (d) => (buf += d.toString()));
        await new Promise<void>((r) => sk.on("connect", r));
        sk.write(`CONNECT registry.npmjs.org:${echoPort} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basic(TOKEN)}\r\n\r\n`);
        await vi.waitFor(() => expect(buf).toContain("200 Connection Established"));
        return sk;
      };
      const a = await open();
      const b = await open();
      expect((await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN))).status).toBe(429);
      expect(px.metrics.tunnelRefused).toBe(1);
      a.destroy();
      await vi.waitFor(async () => expect((await connect(pxPort, `registry.npmjs.org:${echoPort}`, basic(TOKEN))).status).toBe(200));
      b.destroy();
    });

    it("keys the caps on the source address, so a forged token naming another run cannot spend that run's tunnel slots or denied-event budget", async () => {
      await startProxy(undefined, undefined, { maxTunnelsPerRun: 2, deniedEventsPerMinute: 3 });
      const raw = (from: string, target: string): Promise<{ sk: net.Socket; status: () => number }> => new Promise((resolve) => {
        const sk = net.connect({ host: "127.0.0.1", port: pxPort, localAddress: from });
        let buf = "";
        sk.on("error", () => undefined);
        sk.on("data", (d) => (buf += d.toString()));
        sk.on("connect", () => {
          sk.write(`CONNECT ${target} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basic(TOKEN)}\r\n\r\n`);
          const t = setInterval(() => { if (buf.includes("\r\n\r\n")) { clearInterval(t); resolve({ sk, status: () => Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0) }); } }, 10);
        });
      });
      // The "attacker" (127.0.0.2) presents run A's id and fills its own bucket.
      const held = [await raw("127.0.0.2", `registry.npmjs.org:${echoPort}`), await raw("127.0.0.2", `registry.npmjs.org:${echoPort}`)];
      expect((await raw("127.0.0.2", `registry.npmjs.org:${echoPort}`)).status()).toBe(429);
      // Run A's real address is unaffected.
      const real = await raw("127.0.0.1", `registry.npmjs.org:${echoPort}`);
      expect(real.status()).toBe(200);
      // Forged denials do not use up the victim's denied-event budget.
      api.calls.length = 0;
      for (let i = 0; i < 6; i++) (await raw("127.0.0.2", `forged${i}.example.com:${echoPort}`)).sk.destroy();
      (await raw("127.0.0.1", `real.example.com:${echoPort}`)).sk.destroy();
      await new Promise((r) => setTimeout(r, 100));
      const hosts = api.of("/egress/denied").map((c) => (JSON.parse(c.body) as { host: string }).host);
      expect(hosts).toContain("real.example.com");
      for (const h of held) h.sk.destroy();
      real.sk.destroy();
    });

    it("opens no upstream, and holds no slot, when the client resets while admit is pending", async () => {
      let connections = 0;
      echo.on("connection", () => connections++);
      await startProxy(undefined, async () => { await new Promise((r) => setTimeout(r, 150)); return "127.0.0.1"; }, { maxTunnelsPerRun: 1 });
      const sk = net.connect(pxPort, "127.0.0.1");
      sk.on("error", () => undefined);
      await new Promise<void>((r) => sk.on("connect", r));
      sk.write(`CONNECT registry.npmjs.org:${echoPort} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basic(TOKEN)}\r\n\r\n`);
      await new Promise((r) => setTimeout(r, 30));
      sk.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 400));
      expect(connections).toBe(0);
      await startProxy();
    });

    it("ends a tunnel at its absolute lifetime even while traffic keeps it busy", async () => {
      await startProxy(undefined, undefined, { tunnelLifetimeMs: 300 });
      const sk = net.connect(pxPort, "127.0.0.1");
      let buf = "";
      let closed = false;
      sk.on("data", (d) => (buf += d.toString()));
      sk.on("close", () => (closed = true));
      sk.on("error", () => undefined);
      await new Promise<void>((r) => sk.on("connect", r));
      sk.write(`CONNECT registry.npmjs.org:${echoPort} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${basic(TOKEN)}\r\n\r\n`);
      await vi.waitFor(() => expect(buf).toContain("200 Connection Established"));
      const keepalive = setInterval(() => { if (!closed) sk.write("k"); }, 50);
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
      clearInterval(keepalive);
    });

    it("refuses an oversized request body on the plain HTTP path", async () => {
      await startProxy(undefined, undefined, { maxHttpBodyBytes: 1024 });
      const status = await new Promise<number>((resolve) => {
        const rq = http.request({ host: "127.0.0.1", port: pxPort, method: "POST", path: `http://127.0.0.1:${webPort}/up`, headers: { host: `127.0.0.1:${webPort}`, "proxy-authorization": basic(TOKEN) } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
        rq.on("error", () => resolve(0));
        rq.end(Buffer.alloc(64 * 1024, 1));
      });
      expect(status).toBe(413);
    });
  });
});
