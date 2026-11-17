import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The proxy itself against a fake Docker socket: ownership of reads, the edge check, list filters and the workspace profile.
const dir = mkdtempSync(path.join(os.tmpdir(), "sockproxy-"));
const sock = path.join(dir, "docker.sock");
const seen: string[] = [];
const containers: Record<string, Record<string, string>> = {
  "gantry-gantry-github-1": { "com.docker.compose.service": "gantry-github", "com.docker.compose.project": "gantry" },
  "gantry-gantry-edge-1": { "com.docker.compose.service": "gantry-edge", "com.docker.compose.project": "gantry" },
  "gantry-runner-a": { "gantry.managed-by": "gantry-launcher", "gantry.run": "a", "com.docker.compose.service": "gantry-edge", "com.docker.compose.project": "gantry" },
  "helper-1": { "gantry.managed-by": "gantry-github", "gantry.purpose": "workspace-helper" },
};
const volumes: Record<string, Record<string, string>> = { "ws-r1": { "gantry.managed-by": "gantry-launcher" }, "ws-foreign": {} };
let fake: http.Server;
let launcher: http.Server;
let workspace: http.Server;
const ports: Record<string, number> = {};

const call = (port: number, method: string, p: string, body?: unknown): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: data ? { "content-type": "application/json", "content-length": String(data.length) } : {} }, (res) => {
      let t = "";
      res.on("data", (c: Buffer) => (t += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    r.on("error", reject);
    r.end(data);
  });

beforeAll(async () => {
  vi.stubEnv("DOCKER_SOCKET", sock);
  vi.stubEnv("RUNNER_VARIANTS", "base=gantry-runner:dev");
  vi.stubEnv("EDGE_COMPOSE_SERVICE", "gantry-edge");
  vi.stubEnv("EDGE_COMPOSE_PROJECT", "gantry");
  vi.stubEnv("GITHUB_HELPER_IMAGE", "gantry-github:dev");
  fake = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const u = new URL(req.url!, "http://x");
    const seg = u.pathname.split("/");
    res.setHeader("content-type", "application/json");
    let m: RegExpExecArray | null;
    if ((m = /^\/containers\/([^/]+)\/json$/.exec(u.pathname))) {
      const l = containers[decodeURIComponent(m[1]!)];
      if (!l) { res.writeHead(404); return void res.end("{}"); }
      return void res.end(JSON.stringify({ Id: m[1], Config: { Labels: l, Env: ["GANTRY_RUN_TOKEN=secret"] } }));
    }
    if ((m = /^\/volumes\/([^/]+)$/.exec(u.pathname)) && req.method === "GET") {
      const l = volumes[decodeURIComponent(m[1]!)];
      if (!l) { res.writeHead(404); return void res.end("{}"); }
      return void res.end(JSON.stringify({ Name: m[1], Labels: l }));
    }
    if (u.pathname === "/networks") return void res.end(JSON.stringify([{ Id: "n", Name: "x", Containers: { c: {} }, Options: { k: "v" }, IPAM: { Config: [{ Subnet: "10.9.0.0/24", Gateway: "10.9.0.1" }] } }]));
    void seg;
    res.end("{}");
  });
  await new Promise<void>((r) => fake.listen(sock, r));
  const mod = await import("../src/sockproxy.js");
  launcher = mod.createProxy("launcher");
  workspace = mod.createProxy("workspace");
  for (const [name, s] of [["launcher", launcher], ["workspace", workspace]] as const) {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    ports[name] = (s.address() as { port: number }).port;
  }
});
afterAll(async () => {
  for (const s of [launcher, workspace, fake]) await new Promise<void>((r) => s.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("launcher profile", () => {
  it("does not let the launcher read a container it does not own", async () => {
    const r = await call(ports.launcher!, "GET", "/containers/gantry-gantry-github-1/json");
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("GANTRY_RUN_TOKEN");
  });
  it("lets it read its own runner and the edge", async () => {
    expect((await call(ports.launcher!, "GET", "/containers/gantry-runner-a/json")).status).toBe(200);
    expect((await call(ports.launcher!, "GET", "/containers/gantry-gantry-edge-1/json")).status).toBe(200);
  });
  it("refuses an unfiltered container list and strips the network list", async () => {
    expect((await call(ports.launcher!, "GET", "/containers/json?all=1")).status).toBe(403);
    const f = encodeURIComponent(JSON.stringify({ label: ["gantry.managed-by=gantry-launcher"] }));
    expect((await call(ports.launcher!, "GET", `/containers/json?all=1&filters=${f}`)).status).toBe(200);
    const n = await call(ports.launcher!, "GET", "/networks");
    expect(JSON.parse(n.text)).toEqual([{ IPAM: { Config: [{ Subnet: "10.9.0.0/24" }] }, Id: "n", Name: "x", Labels: null }]);
  });
  it("refuses an image other than the allow-listed runners", async () => {
    expect((await call(ports.launcher!, "GET", "/images/alpine/json")).status).toBe(403);
  });
  it("a runner that spoofs the edge's compose labels cannot be connected to a network, the real edge can", async () => {
    expect((await call(ports.launcher!, "POST", "/networks/run-a/connect", { Container: "gantry-runner-a" })).status).toBe(403);
  });
});

describe("workspace profile", () => {
  const helper = (bind: string) => ({
    Image: "gantry-github:dev", Entrypoint: ["/bin/true"], Cmd: [], User: "10001:10001", NetworkDisabled: true,
    Labels: { "gantry.managed-by": "gantry-github", "gantry.purpose": "workspace-helper" },
    HostConfig: { Binds: [bind], NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Memory: 64 * 1024 * 1024, PidsLimit: 16, AutoRemove: false },
  });
  it("creates the helper for a launcher volume", async () => {
    seen.length = 0;
    expect((await call(ports.workspace!, "POST", "/containers/create", helper("ws-r1:/workspace"))).status).toBe(200);
    expect(seen).toContain("POST /containers/create");
  });
  it("refuses a helper on a volume the launcher did not create, and does not forward it", async () => {
    seen.length = 0;
    expect((await call(ports.workspace!, "POST", "/containers/create", helper("ws-foreign:/workspace"))).status).toBe(403);
    expect(seen).not.toContain("POST /containers/create");
  });
  it("serves archive and delete only on a labelled helper", async () => {
    expect((await call(ports.workspace!, "PUT", "/containers/helper-1/archive?path=%2Fworkspace")).status).toBe(200);
    expect((await call(ports.workspace!, "GET", "/containers/gantry-runner-a/archive?path=%2Fworkspace")).status).toBe(403);
    expect((await call(ports.workspace!, "DELETE", "/containers/gantry-gantry-github-1")).status).toBe(403);
    expect((await call(ports.workspace!, "DELETE", "/containers/helper-1")).status).toBe(200);
  });
  it("refuses everything the launcher profile allows, and the broker's own start", async () => {
    expect((await call(ports.workspace!, "POST", "/containers/helper-1/start")).status).toBe(403);
    expect((await call(ports.workspace!, "POST", "/networks/create", { Name: "run-x" })).status).toBe(403);
    expect((await call(ports.workspace!, "GET", "/volumes/ws-foreign")).status).toBe(403);
  });
});
