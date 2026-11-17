import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// deploy/ci/compose-socket.mjs: no service but the socket proxies may hold the Docker socket.
const script = path.resolve(__dirname, "../../../deploy/ci/compose-socket.mjs");
const run = (config: object) => spawnSync("node", [script, "--stdin"], { input: JSON.stringify(config), encoding: "utf8" });
const sock = { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" };

describe("compose lint: the Docker socket", () => {
  it("passes when only the proxies mount it", () => {
    const r = run({ services: { "gantry-sockproxy": { volumes: [sock], group_add: ["973"] }, "gantry-sockproxy-ws": { volumes: [sock], group_add: ["973"] }, "gantry-github": { volumes: [] } } });
    expect(r.status).toBe(0);
  });
  it("fails when the broker mounts it, or joins the docker group", () => {
    expect(run({ services: { "gantry-github": { volumes: [sock] } } }).status).toBe(1);
    expect(run({ services: { "gantry-github": { group_add: ["973"] } } }).status).toBe(1);
    expect(run({ services: { "gantry-github": { volumes: ["/var/run/docker.sock:/var/run/docker.sock"] } } }).stderr).toContain("gantry-github");
  });
  it("fails on a privileged service or a host namespace", () => {
    expect(run({ services: { x: { privileged: true } } }).status).toBe(1);
    expect(run({ services: { x: { network_mode: "host" } } }).status).toBe(1);
  });
  it("the repository's own compose files pass", () => {
    const r = spawnSync("node", [script], { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8" });
    // Skipped quietly where Docker Compose is not installed.
    if (r.error || /docker.*(not found|ENOENT)/i.test(r.stderr)) return;
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
