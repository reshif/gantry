/** Sandbox review S-90 (workspace cap, free-disk guard), S-93 (sizing against the host), S-96 (no token file left after a failed start). */
import { describe, expect, it, vi } from "vitest";
import { loadConfig, type HostCapacity } from "../src/config.js";
import { RunManager } from "../src/manager.js";
import { checkContainer, checkVolume, DEFAULT_LIMITS } from "../src/sockpolicy.js";
import { createRequest, names, runLabels, runnerContainerOptions, volumeDriverOpts } from "../src/template.js";
import { BIG_HOST } from "./host.js";

const GiB = 2 ** 30;
const load = (env: Record<string, string>, host: HostCapacity = BIG_HOST) => {
  const r = loadConfig({ RUNNER_VARIANTS: "base=gantry-runner:dev", EDGE_URL: "http://gantry-edge:8443", ...env }, host);
  if (!r.ok) throw new Error(r.error.msg);
  return r.value;
};
const input = { runId: "r1", workspaceRef: "repo/acme@abc123", variant: "base", runToken: "tok_0123456789abcdef" };

describe("S-90: the workspace cap", () => {
  it("defaults to 10 GiB on a plain disk volume, and the template tells the wrapper the cap", () => {
    const cfg = load({});
    expect(cfg.workspace).toEqual({ maxMb: 10240, backing: "disk" });
    expect(volumeDriverOpts(cfg)).toBeUndefined();
    expect(runnerContainerOptions(cfg, input).Env).toContain("GANTRY_WORKSPACE_MAX_MB=10240");
    expect(checkContainer(JSON.parse(JSON.stringify(runnerContainerOptions(cfg, input))), new URLSearchParams({ name: names.container("r1") }), new Set(["gantry-runner:dev"]), DEFAULT_LIMITS)).toEqual({ ok: true });
  });

  it("the proxy refuses any other value in the cap variable", () => {
    const cfg = load({});
    const o = JSON.parse(JSON.stringify(runnerContainerOptions(cfg, input)));
    o.Env = o.Env.map((e: string) => (e.startsWith("GANTRY_WORKSPACE_MAX_MB=") ? "GANTRY_WORKSPACE_MAX_MB=1;rm" : e));
    expect(checkContainer(o, new URLSearchParams({ name: names.container("r1") }), new Set(["gantry-runner:dev"]), DEFAULT_LIMITS).ok).toBe(false);
  });

  it("is configurable, and a tmpfs backing makes it a size-limited volume the proxy allows", () => {
    const cfg = load({ WORKSPACE_MAX_MB: "2048", WORKSPACE_BACKING: "tmpfs" });
    const opts = volumeDriverOpts(cfg)!;
    expect(opts).toEqual({ type: "tmpfs", device: "tmpfs", o: "size=2048m,uid=10001,gid=10001,mode=0755" });
    const vol = { Name: names.volume("r1"), Driver: "local", Labels: runLabels(input), DriverOpts: opts };
    expect(checkVolume(vol, { maxMb: 2048, uid: 10001, gid: 10001 })).toEqual({ ok: true });
  });

  it("checkVolume still refuses every other driver option, and a size over the ceiling", () => {
    const base = { Name: "ws-r1", Driver: "local", Labels: runLabels(input) };
    const lim = { maxMb: 1024, uid: 10001, gid: 10001 };
    const tm = (o: string) => ({ type: "tmpfs", device: "tmpfs", o });
    const good = "size=1024m,uid=10001,gid=10001,mode=0755";
    expect(checkVolume({ ...base, DriverOpts: tm(good) }, lim).ok).toBe(true);
    for (const bad of [
      { type: "none", o: "bind", device: "/etc" },
      { type: "tmpfs", device: "/etc", o: good },
      { ...tm(good), extra: "x" },
      tm("size=2048m,uid=10001,gid=10001,mode=0755"),
      tm("size=1024m,uid=0,gid=0,mode=0755"),
      tm("size=1024m,uid=10001,gid=10001,mode=0755,bind"),
      tm("size=1024m,uid=10001,gid=10001,mode=0777"),
      tm("size=1024g,uid=10001,gid=10001,mode=0755"),
      tm("size=1024m,uid=10001,gid=10001,mode=0755,exec"),
      { type: "tmpfs", device: "tmpfs" },
    ]) expect(checkVolume({ ...base, DriverOpts: bad }, lim).ok, JSON.stringify(bad)).toBe(false);
  });

  it("creates the volume with the size-limited options when the backing is tmpfs, and plain otherwise", async () => {
    for (const backing of ["tmpfs", "disk"] as const) {
      const cfg = load({ WORKSPACE_BACKING: backing, WORKSPACE_MAX_MB: "512" });
      const createVolume = vi.fn(async () => ({}));
      const docker = {
        getVolume: () => ({ inspect: async () => { throw Object.assign(new Error("no"), { statusCode: 404 }); } }),
        getNetwork: () => ({ inspect: async () => ({ Labels: { "gantry.run": "r1" }, IPAM: { Config: [{ Subnet: "10.0.0.0/28" }] } }) }),
        getContainer: () => ({ inspect: async () => { throw Object.assign(new Error("no"), { statusCode: 404 }); } }),
      };
      const r = await new RunManager({ ...docker, createVolume } as never, cfg).start({ ...input, seedComplete: false });
      expect(r.ok).toBe(true);
      const arg = (createVolume.mock.calls[0] as unknown[])[0] as { DriverOpts?: unknown };
      if (backing === "tmpfs") expect(arg.DriverOpts).toEqual({ type: "tmpfs", device: "tmpfs", o: "size=512m,uid=10001,gid=10001,mode=0755" });
      else expect(arg.DriverOpts).toBeUndefined();
    }
  });
});

describe("S-90: no new run on a nearly full disk", () => {
  const dockerNoVolume = () => ({
    getVolume: () => ({ inspect: async () => { throw Object.assign(new Error("no"), { statusCode: 404 }); } }),
    getNetwork: () => ({ inspect: async () => ({ Labels: { "gantry.run": "r1" } }) }),
    getContainer: () => ({ inspect: async () => { throw Object.assign(new Error("no"), { statusCode: 404 }); } }),
    createVolume: vi.fn(async () => ({})),
  });

  it("answers capacity (a deferral, not a failure) with the numbers when free disk is under the floor", async () => {
    const cfg = load({ DISK_PROBE_PATH: "/", MIN_FREE_DISK_GB: "1000000" });
    const d = dockerNoVolume();
    const r = await new RunManager(d as never, cfg).start({ ...input, seedComplete: false });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe("capacity");
    expect(!r.ok && r.error.msg).toMatch(/free disk is [\d.]+ GB, under the [\d.]+ GB floor/);
    expect(d.createVolume).not.toHaveBeenCalled();
  });

  it("fails closed when the disk cannot be measured, and starts when there is room", async () => {
    const bad = await new RunManager(dockerNoVolume() as never, load({ DISK_PROBE_PATH: "/nonexistent-probe", MIN_FREE_DISK_GB: "1" })).lowDisk();
    expect(bad).toMatch(/cannot be measured/);
    expect(await new RunManager(dockerNoVolume() as never, load({ DISK_PROBE_PATH: "/", MIN_FREE_DISK_GB: "0.001" })).lowDisk()).toBeUndefined();
    expect(await new RunManager(dockerNoVolume() as never, load({})).lowDisk()).toBeUndefined(); // no probe path: guard off
  });
});

describe("S-93: concurrency and per-run limits against the host", () => {
  const host14: HostCapacity = { memBytes: 14 * GiB, cpus: 12 };

  it("derives the default from the host: a 14 GiB, 12 CPU host gets 3 runs of 4 GiB beside the control plane, not 32", () => {
    const cfg = load({}, host14);
    expect(cfg.maxConcurrentRuns).toBe(3);
    expect(cfg.sizing.source).toBe("derived");
    expect(load({}, { memBytes: 256 * GiB, cpus: 64 }).maxConcurrentRuns).toBe(32); // the ceiling
    expect(load({ MAX_CONCURRENT_RUNS: "" }, host14).maxConcurrentRuns).toBe(3);
  });

  it("refuses an explicit value that overcommits memory, with a message that says why", () => {
    const r = loadConfig({ RUNNER_VARIANTS: "base=x:y", MAX_CONCURRENT_RUNS: "32" }, host14);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.msg).toMatch(/MAX_CONCURRENT_RUNS 32 x 4096 MB = 128\.0 GiB overcommits this host: 14\.0 GiB minus 4096 MB for the control plane, times ratio 1\.5, allows 15\.0 GiB \(at most 3 runs\)/);
    expect(loadConfig({ RUNNER_VARIANTS: "base=x:y", MAX_CONCURRENT_RUNS: "3" }, host14).ok).toBe(true);
    expect(loadConfig({ RUNNER_VARIANTS: "base=x:y", MAX_CONCURRENT_RUNS: "4" }, host14).ok).toBe(false);
  });

  it("refuses CPU overcommit, honours a stated ratio, and refuses a host too small for one run", () => {
    expect(loadConfig({ RUNNER_VARIANTS: "base=x:y", MAX_CONCURRENT_RUNS: "3", RUNNER_CPUS: "8" }, host14).ok).toBe(false);
    expect(loadConfig({ RUNNER_VARIANTS: "base=x:y", MAX_CONCURRENT_RUNS: "4", RUN_MEMORY_OVERCOMMIT_RATIO: "2" }, host14).ok).toBe(true);
    const tiny = loadConfig({ RUNNER_VARIANTS: "base=x:y" }, { memBytes: 4 * GiB, cpus: 2 });
    expect(tiny.ok).toBe(false);
    expect(!tiny.ok && tiny.error.msg).toMatch(/cannot hold one run/);
  });
});

describe("S-96: a failed start leaves no live token file in the kept volume", () => {
  it("overwrites the token file before it removes the container", async () => {
    const cfg = load({});
    const calls: string[] = [];
    const archives: Buffer[] = [];
    const container = {
      putArchive: vi.fn(async (b: Buffer) => { calls.push("putArchive"); archives.push(b); }),
      start: vi.fn(async () => { throw new Error("start failed"); }),
    };
    const docker = {
      getVolume: () => ({ inspect: async () => ({ Labels: { "gantry.run": "r1" } }) }),
      getNetwork: () => ({ inspect: async () => ({ Labels: { "gantry.run": "r1" }, IPAM: { Config: [{ Subnet: "10.0.0.0/28" }] }, Containers: { edge1: {} } }), remove: async () => undefined, disconnect: async () => undefined }),
      getContainer: () => ({ inspect: async () => { throw Object.assign(new Error("no"), { statusCode: 404 }); }, remove: async () => { calls.push("remove"); } }),
      getImage: () => ({ inspect: async () => ({}) }),
      listContainers: async () => [{ Id: "edge1" }],
      createContainer: async (o: unknown) => { void createRequest(o as never); return container; },
    };
    const r = await new RunManager(docker as never, cfg).start(input);
    expect(r.ok).toBe(false);
    expect(calls.slice(0, 2)).toEqual(["putArchive", "putArchive"]);
    expect(archives[0]!.toString("latin1")).toContain(input.runToken);
    expect(archives[1]!.toString("latin1")).not.toContain(input.runToken);
  });
});

describe("S-102: the run pool must lie inside the edge's run subnet", () => {
  it("refuses to start when the two drifted apart, and accepts equal or wider", () => {
    const base = { RUNNER_VARIANTS: "base=x:y", RUN_SUBNET_POOL: "10.213.0.0/16" };
    expect(loadConfig({ ...base, EDGE_RUN_SUBNET: "10.214.0.0/16" }, BIG_HOST).ok).toBe(false);
    expect(loadConfig({ ...base, EDGE_RUN_SUBNET: "10.213.0.0/24" }, BIG_HOST).ok).toBe(false);
    expect(loadConfig({ ...base, EDGE_RUN_SUBNET: "garbage" }, BIG_HOST).ok).toBe(false);
    const drift = loadConfig({ ...base, EDGE_RUN_SUBNET: "10.214.0.0/16" }, BIG_HOST);
    expect(!drift.ok && drift.error.msg).toMatch(/treated as a system caller/);
    expect(loadConfig({ ...base, EDGE_RUN_SUBNET: "10.213.0.0/16" }, BIG_HOST).ok).toBe(true);
    expect(loadConfig({ ...base, EDGE_RUN_SUBNET: "10.0.0.0/8" }, BIG_HOST).ok).toBe(true);
    expect(loadConfig(base, BIG_HOST).ok).toBe(true);
  });
});
