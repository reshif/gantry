import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type Relay } from "../src/relay.js";
import { startFakeEdge, type FakeEdge } from "./helpers.js";

const TOKEN = "run-token-abcdef123456";
let relay: Relay | undefined;
let edge: FakeEdge | undefined;
afterEach(async () => {
  await relay?.close();
  await edge?.close();
  relay = edge = undefined;
});

describe("runner relay", () => {
  it("adds the run token on allowed edge paths, replaces a caller's own credentials, and refuses every other path", async () => {
    edge = await startFakeEdge({}, TOKEN);
    relay = await startRelay({ edgeUrl: edge.url, runToken: TOKEN, runId: "r1" });
    const ok = await fetch(`${relay.url}/model/v1/messages`, { method: "POST", headers: { authorization: "Bearer forged", "x-api-key": "k" } });
    expect(ok.status).toBe(200);
    expect(edge.calls.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    expect((await fetch(`${relay.url}/mcp/v1/srv`, { method: "POST" })).status).toBe(200);
    for (const p of ["/run/v1/spec", "/run/v1/result", "/healthz", "/modelx"]) expect((await fetch(`${relay.url}${p}`)).status, p).toBe(403);
  });

  it("opens HTTPS tunnels through the edge proxy with the run's credentials, which the caller never supplies", async () => {
    let seenAuth = "";
    const upstream = net.createServer((s) => {
      s.once("data", (d) => {
        seenAuth = /Proxy-Authorization: Basic (\S+)/.exec(d.toString())?.[1] ?? "";
        s.write("HTTP/1.1 200 OK\r\n\r\npong");
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = (upstream.address() as AddressInfo).port;
    relay = await startRelay({ edgeUrl: "http://127.0.0.1:1", runToken: TOKEN, runId: "r1", upstreamProxy: `http://run:${TOKEN}@127.0.0.1:${port}` });
    const rport = Number(new URL(relay.url).port);
    const got = await new Promise<string>((resolve) => {
      const c = net.connect(rport, "127.0.0.1", () => c.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n"));
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("pong")) {
          c.destroy();
          resolve(buf);
        }
      });
    });
    expect(got).toContain("200 Connection Established");
    expect(Buffer.from(seenAuth, "base64").toString()).toBe(`run:${TOKEN}`);
    upstream.close();
  });

  it("refuses a tunnel when no proxy is configured", async () => {
    relay = await startRelay({ edgeUrl: "http://127.0.0.1:1", runToken: TOKEN, runId: "r1" });
    const got = await new Promise<string>((resolve) => {
      const c = net.connect(Number(new URL(relay!.url).port), "127.0.0.1", () => c.write("CONNECT a.b:443 HTTP/1.1\r\nHost: a.b:443\r\n\r\n"));
      c.on("data", (d) => resolve(d.toString()));
    });
    expect(got).toContain("403");
  });
});
