/** Merge gate G-S8 (continuous disk monitor, tmpfs size) and G-S10 (case-variant keys at the socket proxy). */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { RunManager } from "../src/manager.js";
import { checkNetwork, checkVolume, route } from "../src/sockpolicy.js";
import { runLabels } from "../src/template.js";
import { BIG_HOST } from "./host.js";

const input = { runId: "r1", workspaceRef: "x", variant: "base" };
const load = (env: Record<string, string>) => {
  const r = loadConfig({ RUNNER_VARIANTS: "base=x:y", ...env }, BIG_HOST);
  if (!r.ok) throw new Error(r.error.msg);
  return r.value;
};

describe("G-S10: keys that differ only by case", () => {
  const labels = runLabels(input);
  it("refuses a volume whose DriverOpts is spelled in another case (Docker decodes it all the same)", () => {
    expect(checkVolume({ Name: "ws-r1", driveropts: { type: "none", o: "bind", device: "/tmp" }, Labels: labels }).ok).toBe(false);
    expect(checkVolume({ Name: "ws-r1", DRIVEROPTS: { type: "none", o: "bind", device: "/tmp" }, Labels: labels }).ok).toBe(false);
    expect(checkVolume({ Name: "ws-r1", Driver: "local", Labels: labels, Extra: 1 }).ok).toBe(false);
    expect(checkVolume({ Name: "ws-r1", Driver: "local", Labels: labels }).ok).toBe(true);
  });
  it("refuses a network that repeats Internal in another case", () => {
    const net = { Name: "run-r1", Driver: "bridge", Internal: true, Labels: labels };
    expect(checkNetwork(net).ok).toBe(true);
    expect(checkNetwork({ ...net, internal: false }).ok).toBe(false);
    expect(checkNetwork({ ...net, INTERNAL: false }).ok).toBe(false);
    expect(checkNetwork({ ...net, ipam: { Config: [] } }).ok).toBe(false);
    expect(checkNetwork({ ...net, IPAM: { Driver: "default", Config: [{ Subnet: "10.0.0.0/28", Gateway: "10.0.0.1" }] } }).ok).toBe(false);
    expect(checkNetwork({ ...net, IPAM: { Driver: "default", Config: [{ Subnet: "10.0.0.0/28" }] } }).ok).toBe(true);
  });
});

describe("G-S8: the disk is watched continuously", () => {
  const mk = (env: Record<string, string>, df: unknown) => {
    const docker = { df: async () => df, listVolumes: async () => ({ Volumes: [] }) };
    const m = new RunManager(docker as never, load({ DISK_PROBE_PATH: "/", ...env }));
    const stop = vi.spyOn(m, "stop").mockResolvedValue({ ok: true } as never);
    return { m, stop };
  };
  const vol = (id: string, size: number) => ({ Name: `ws-${id}`, Labels: { "gantry.run": id, "gantry.managed-by": "gantry-launcher" }, UsageData: { Size: size } });

  it("does nothing while free disk is above the hard floor", async () => {
    const { m, stop } = mk({ MIN_FREE_DISK_GB: "0.002" }, { Volumes: [vol("a", 5)] });
    expect(await m.diskTick()).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
  });

  it("below the hard floor it stops the run whose workspace grew fastest, and says so", async () => {
    let sizes = [vol("slow", 100), vol("fast", 100)];
    const docker = { df: async () => ({ Volumes: sizes }), listVolumes: async () => ({ Volumes: [] }) };
    const m = new RunManager(docker as never, load({ DISK_PROBE_PATH: "/", MIN_FREE_DISK_GB: "1000000" }));
    const stop = vi.spyOn(m, "stop").mockResolvedValue({ ok: true } as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await m.diskTick(); // first look: no growth known, the biggest (a tie: the first) goes
    stop.mockClear();
    sizes = [vol("slow", 110), vol("fast", 5000)];
    expect(await m.diskTick()).toBe("fast");
    expect(stop).toHaveBeenCalledWith("fast", { keepWorkspace: true });
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/host disk critically low/);
    expect(m.criticalStops.at(-1)?.runId).toBe("fast");
    log.mockRestore();
  });

  it("R4: sizes are tracked before the disk is critical, so the first critical tick stops the fastest grower, and keeps its workspace", async () => {
    let sizes = [vol("slow", 100), vol("fast", 100)];
    const docker = { df: async () => ({ Volumes: sizes }), listVolumes: async () => ({ Volumes: [] }) };
    // soft zone: free is under twice the floor but above the hard floor (floor = 2 x free, hard = 0.5 x free)
    const m = new RunManager(docker as never, load({ DISK_PROBE_PATH: "/", MIN_FREE_DISK_GB: "0.0000001" }));
    const stop = vi.spyOn(m, "stop").mockResolvedValue({ ok: true } as never);
    expect(await m.diskTick()).toBeUndefined(); // not critical: tracked only (every 12th tick in the healthy zone)
    const crit = new RunManager(docker as never, load({ DISK_PROBE_PATH: "/", MIN_FREE_DISK_GB: "1000000" }));
    const stop2 = vi.spyOn(crit, "stop").mockResolvedValue({ ok: true } as never);
    (crit as unknown as { lastSizes: Map<string, number> }).lastSizes = new Map([["slow", 100], ["fast", 100]]);
    sizes = [vol("slow", 120), vol("fast", 9000)];
    expect(await crit.diskTick()).toBe("fast");
    expect(stop2).toHaveBeenCalledWith("fast", { keepWorkspace: true });
    expect(stop).not.toHaveBeenCalled();
  });

  it("the sockproxy allows the one read it needs for this, and only that path", () => {
    expect(route("GET", "/v1.43/system/df").decision.ok).toBe(true);
    expect(route("GET", "/system/events").decision.ok).toBe(false);
  });

  it("a run starts only when free space covers the floor plus the workspaces already held and its own", async () => {
    const m = new RunManager({ listVolumes: async () => ({ Volumes: [{}, {}] }) } as never, load({ DISK_PROBE_PATH: "/", MIN_FREE_DISK_GB: "0.001", WORKSPACE_MAX_MB: "4000000" }));
    expect(await m.lowDisk()).toMatch(/3 workspaces of up to .* need /);
  });

  it("refuses a tmpfs workspace bigger than the run's memory limit", () => {
    const r = loadConfig({ RUNNER_VARIANTS: "base=x:y", WORKSPACE_BACKING: "tmpfs", WORKSPACE_MAX_MB: "10240" }, BIG_HOST);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.msg).toMatch(/fit inside the run's memory limit/);
    expect(loadConfig({ RUNNER_VARIANTS: "base=x:y", WORKSPACE_BACKING: "tmpfs", WORKSPACE_MAX_MB: "2048" }, BIG_HOST).ok).toBe(true);
  });
});
