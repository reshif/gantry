import { execFileSync } from "node:child_process";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RunManager } from "../src/manager.js";
import { buildServer } from "../src/server.js";

/** Real Docker. Resources use the prefix `w1plat-it` and are removed in afterAll. */
const P = "w1plat-it";
const IMAGE = `${P}-runner:test`;
const EDGE = `${P}-edge`;
const EDGE_NET = `${P}-edge-net`;
const TOKEN = "i".repeat(48);
const RUN_TOKEN = "run-token-0123456789";

function dockerUp(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const up = dockerUp();
const d = up ? describe : describe.skip;

const sh = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" });
const shOk = (...args: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: unknown }).stderr ?? e) };
  }
};
const exists = (kind: "container" | "network" | "volume", name: string) => shOk(kind, "inspect", name).ok;

d("launcher against real Docker", () => {
  const cfgR = loadConfig({
    RUNNER_VARIANTS: `base=${IMAGE}`,
    RUN_SUBNET_POOL: "10.213.200.0/24",
    MAX_CONCURRENT_RUNS: "2",
    EDGE_CONTAINER: EDGE,
    STOP_GRACE_SECONDS: "2",
    RUNNER_MEMORY_MB: "128",
    RUNNER_CPUS: "0.5",
    RUNNER_PIDS: "64",
    RUNNER_TMP_MB: "8",
  });
  if (!cfgR.ok) throw new Error(cfgR.error.msg);
  const cfg = cfgR.value;
  const docker = new Docker();
  const manager = new RunManager(docker, cfg);
  const app = buildServer({ cfg, manager, token: TOKEN, logger: false });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const body = (runId: string, extra: object = {}) => ({ runId, workspaceRef: "test/ref", variant: "base", runToken: RUN_TOKEN, ...extra });

  function cleanup() {
    for (const c of shOk("ps", "-aq", "--filter", `label=gantry.managed-by=gantry-launcher`).out.split("\n").filter(Boolean)) shOk("rm", "-fv", c);
    shOk("rm", "-fv", EDGE);
    for (const n of shOk("network", "ls", "-q", "--filter", "label=gantry.managed-by=gantry-launcher").out.split("\n").filter(Boolean)) shOk("network", "rm", n);
    shOk("network", "rm", EDGE_NET);
    for (const v of shOk("volume", "ls", "-q", "--filter", "label=gantry.managed-by=gantry-launcher").out.split("\n").filter(Boolean)) shOk("volume", "rm", v);
    shOk("rmi", IMAGE);
  }

  beforeAll(() => {
    cleanup();
    execFileSync("docker", ["build", "-t", IMAGE, "-"], { input: 'FROM node:22-alpine\nCMD ["sleep","3600"]\n', stdio: ["pipe", "ignore", "ignore"] });
    sh("network", "create", EDGE_NET);
    // Stands in for gantry-edge: any running container is attachable; the launcher only needs its name.
    sh("run", "-d", "--name", EDGE, "--network", EDGE_NET, IMAGE);
  });
  afterAll(() => cleanup());

  it("starts a run from the fixed template and isolates it", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: body("it1") });
    expect(r.statusCode, r.body).toBe(201);
    const out = r.json();
    expect(out.state).toBe("started");
    expect(out.subnet).toBe("10.213.200.0/28");

    const c = JSON.parse(sh("inspect", "gantry-runner-it1"))[0];
    const hc = c.HostConfig;
    expect(c.State.Running).toBe(true);
    expect(c.Config.User).toBe("10001:10001");
    expect(hc.Privileged).toBe(false);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toBeNull();
    expect(hc.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(hc.NetworkMode).toBe("run-it1");
    expect(hc.PidMode).toBe("");
    expect(hc.Devices ?? []).toEqual([]);
    expect(hc.Binds ?? []).toEqual([]);
    expect(hc.Memory).toBe(128 * 1024 * 1024);
    expect(hc.NanoCpus).toBe(5e8);
    expect(hc.PidsLimit).toBe(64);
    expect(hc.Tmpfs["/tmp"]).toMatch(/noexec/);
    expect(c.Mounts.map((m: { Type: string; Name: string; Destination: string }) => [m.Type, m.Name, m.Destination])).toEqual([["volume", "ws-it1", "/workspace"]]);
    const env = (c.Config.Env as string[]).map((e) => e.split("=")[0]);
    for (const k of ["EDGE_URL", "HTTPS_PROXY", "GANTRY_RUN_TOKEN", "GANTRY_RUN_ID"]) expect(env).toContain(k);
    expect(Object.keys(c.NetworkSettings.Networks)).toEqual(["run-it1"]);

    const net = JSON.parse(sh("network", "inspect", "run-it1"))[0];
    expect(net.Internal).toBe(true);
    expect(net.IPAM.Config[0].Subnet).toBe("10.213.200.0/28");
    const attached = Object.values(net.Containers as Record<string, { Name: string }>).map((x) => x.Name).sort();
    expect(attached).toEqual([EDGE, "gantry-runner-it1"].sort());

    // Behavioural isolation, from inside the runner (spec 5.4 T1, T4, T6).
    const run = (...cmd: string[]) => shOk("exec", "gantry-runner-it1", ...cmd);
    expect(run("wget", "-q", "-T", "3", "-O", "-", "http://1.1.1.1/").ok).toBe(false);
    expect(run("nslookup", "example.com").ok).toBe(false);
    expect(run("sh", "-c", "echo x > /etc/pwned").ok).toBe(false);
    expect(run("sh", "-c", "echo x > /tmp/ok").ok).toBe(true);
    expect(run("id", "-u").out.trim()).toBe("10001");
    expect(run("ls", "/var/run/docker.sock").ok).toBe(false);
    // The edge is reachable by its alias.
    expect(run("getent", "hosts", "gantry-edge").ok).toBe(true);
  });

  it("start-run is idempotent while the run is up", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: body("it1") });
    expect(r.statusCode).toBe(200);
    expect(r.json().state).toBe("running");
  });

  it("lists the run's container, network and volume", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/runs", headers: auth });
    expect(r.statusCode).toBe(200);
    const run = r.json().runs.find((x: { runId: string }) => x.runId === "it1");
    expect(run.container.state).toBe("running");
    expect(run.network.subnet).toBe("10.213.200.0/28");
    expect(run.volume.name).toBe("ws-it1");
    expect(r.json().capacity).toEqual({ max: 2, networks: 1 });
  });

  it("enforces the concurrency cap", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: body("it2") })).statusCode).toBe(201);
    const r = await app.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: body("it3") });
    expect(r.statusCode).toBe(429);
    expect(r.json().kind).toBe("capacity");
    expect(exists("network", "run-it3")).toBe(false);
    expect(exists("volume", "ws-it3")).toBe(false);
    // a second run gets a different subnet
    expect(JSON.parse(sh("network", "inspect", "run-it2"))[0].IPAM.Config[0].Subnet).toBe("10.213.200.16/28");
    expect((await app.inject({ method: "DELETE", url: "/v1/runs/it2?keepWorkspace=false", headers: auth })).statusCode).toBe(200);
  });

  it("stops a run: container, network gone; workspace kept by default", async () => {
    const r = await app.inject({ method: "DELETE", url: "/v1/runs/it1", headers: auth });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ container: "removed", network: "removed", volume: "kept" });
    expect(exists("container", "gantry-runner-it1")).toBe(false);
    expect(exists("network", "run-it1")).toBe(false);
    expect(exists("volume", "ws-it1")).toBe(true);
    // the edge container is untouched and no longer attached to the run network
    expect(exists("container", EDGE)).toBe(true);
  });

  it("removes the workspace when asked, and stop-run is idempotent", async () => {
    const r = await app.inject({ method: "DELETE", url: "/v1/runs/it1?keepWorkspace=false", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().volume).toBe("removed");
    expect(exists("volume", "ws-it1")).toBe(false);
    const again = await app.inject({ method: "DELETE", url: "/v1/runs/it1?keepWorkspace=false", headers: auth });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ found: false, container: "absent", network: "absent", volume: "absent" });
  });

  it("two-phase start: prepare (seedComplete false), then start", async () => {
    const p = await app.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: body("it4", { seedComplete: false }) });
    expect(p.statusCode).toBe(201);
    expect(p.json().state).toBe("prepared");
    expect(exists("network", "run-it4")).toBe(true);
    expect(exists("volume", "ws-it4")).toBe(true);
    expect(exists("container", "gantry-runner-it4")).toBe(false);
    const s = await app.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: body("it4", { seedComplete: true }) });
    expect(s.statusCode, s.body).toBe(201);
    expect(s.json().state).toBe("started");
    expect(JSON.parse(sh("inspect", "gantry-runner-it4"))[0].State.Running).toBe(true);
    const x = await app.inject({ method: "DELETE", url: "/v1/runs/it4?keepWorkspace=false", headers: auth });
    expect(x.statusCode).toBe(200);
    expect(exists("network", "run-it4")).toBe(false);
    expect(exists("volume", "ws-it4")).toBe(false);
  });

  it("refuses to start when the image is missing and leaves nothing behind", async () => {
    const cfg2 = loadConfig({ RUNNER_VARIANTS: `base=${P}-missing:none`, RUN_SUBNET_POOL: "10.213.200.0/24", MAX_CONCURRENT_RUNS: "2", EDGE_CONTAINER: EDGE });
    if (!cfg2.ok) throw new Error(cfg2.error.msg);
    const app2 = buildServer({ cfg: cfg2.value, manager: new RunManager(docker, cfg2.value), token: TOKEN, logger: false });
    const r = await app2.inject({ method: "POST", url: "/v1/runs", headers: auth, payload: body("it5") });
    expect(r.statusCode).toBe(503);
    expect(r.json().kind).toBe("image_missing");
    expect(exists("network", "run-it5")).toBe(false);
    expect(exists("volume", "ws-it5")).toBe(false);
  });
});
