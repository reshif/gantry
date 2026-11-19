/**
 * Regression: dockerode puts the whole createContainer options object in the query string as well as the body. For a runner that
 * leaks its env (the run token) into a URL, and for the broker's helper the proxy refuses it. This captures the real outgoing request.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BIG_HOST } from "./host.js";
import { DEFAULT_LIMITS, checkContainer } from "../src/sockpolicy.js";
import { createRequest, runnerContainerOptions } from "../src/template.js";

const cfgR = loadConfig({ RUNNER_VARIANTS: "base=gantry-runner:dev", EDGE_URL: "http://gantry-edge:8443" }, BIG_HOST);
if (!cfgR.ok) throw new Error(cfgR.error.msg);
let server: http.Server;
let seen: { url: string; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ Id: "c1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the launcher's runner create, as the socket proxy sees it", () => {
  it("has only `name` in the query, no token in the URL, and a body the policy accepts", async () => {
    seen = [];
    const docker = new Docker({ host: "127.0.0.1", port: (server.address() as AddressInfo).port });
    const input = { runId: "r1", workspaceRef: "repo/acme@abc123", variant: "base", runToken: "tok_0123456789abcdef" };
    await docker.createContainer(createRequest(runnerContainerOptions(cfgR.value, input)));
    expect(seen).toHaveLength(1);
    const query = new URLSearchParams(seen[0]!.url.split("?")[1] ?? "");
    expect([...query.keys()]).toEqual(["name"]);
    expect(decodeURIComponent(seen[0]!.url)).not.toContain("tok_0123456789abcdef");
    expect(checkContainer(JSON.parse(seen[0]!.body), query, new Set(["gantry-runner:dev"]), DEFAULT_LIMITS)).toEqual({ ok: true });
  });
});
