/**
 * Regression: the broker's helper create reached the socket proxy with the whole body in the query string (dockerode puts the
 * options object in both), and the proxy refused it with "Unexpected create parameters." This runs the broker's real
 * withHelper path against a local HTTP server standing in for the Docker socket and feeds the captured request to the proxy's policy.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerWorkspaceStore } from "../src/workspace.js";

/** The proxy's real policy lives in the launcher; it is loaded by path so this package's tsconfig rootDir does not have to span both. */
type Policy = { checkHelperCreate(body: unknown, query: URLSearchParams, image: string): { ok: boolean; why?: string } };
const policyPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "launcher", "src", "sockpolicy.ts");

const IMAGE = "gantry-github:dev";
interface Seen { method: string; url: string; body: string }
let server: http.Server;
let seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, body: Buffer.concat(chunks).toString("utf8") });
      res.setHeader("content-type", "application/json");
      if (/\/volumes\/ws-r1$/.test(url)) return void res.end(JSON.stringify({ Name: "ws-r1", Labels: { "gantry.managed-by": "gantry-launcher" } }));
      if (url.includes("/containers/create")) return void res.writeHead(201).end(JSON.stringify({ Id: "c1" }));
      if (req.method === "DELETE") return void res.writeHead(204).end();
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the broker's helper create, as the socket proxy sees it", () => {
  it("sends only allowed query keys and a body the proxy accepts", async () => {
    seen = [];
    const store = new DockerWorkspaceStore(new Docker({ host: "127.0.0.1", port: (server.address() as AddressInfo).port }), IMAGE);
    const src = mkdtempSync(join(tmpdir(), "gh-create-"));
    writeFileSync(join(src, "a.txt"), "x");
    await store.seed("ws-r1", src, { uid: 10001, gid: 10001 }).catch(() => undefined); // the archive upload may fail against the stub; only the create matters
    const create = seen.find((s) => s.method === "POST" && s.url.includes("/containers/create"));
    expect(create, "no create request captured").toBeDefined();
    const query = new URLSearchParams(create!.url.split("?")[1] ?? "");
    expect([...query.keys()].filter((k) => k !== "name")).toEqual([]);
    const { checkHelperCreate } = (await import(/* @vite-ignore */ policyPath)) as Policy;
    expect(checkHelperCreate(JSON.parse(create!.body), query, IMAGE)).toEqual({ ok: true });
  });
});
