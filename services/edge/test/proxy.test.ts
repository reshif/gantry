import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildProxy, hostAllowed, inCidr, isPrivateAddress } from "../src/proxy.js";
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

  const startProxy = async (cfg = baseConfig({ apiUrl: api.url, allowedPorts: [echoPort, webPort], runSubnet: "10.213.0.0/16" }), resolve = async () => "127.0.0.1"): Promise<void> => {
    if (px) await new Promise<void>((r) => px.server.close(() => r()));
    px = buildProxy({ cfg, logger: log, resolve });
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
});
