import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runnerContainerOptions, startRunSchema, networkOptions, names } from "../src/template.js";
import { blockCount, firstFreeBlock, formatCidr, parseCidr } from "../src/cidr.js";

const cfgR = loadConfig({ RUNNER_VARIANTS: "base=gantry-runner:dev,node=gantry-runner:node", EDGE_URL: "http://gantry-edge:8443" });
if (!cfgR.ok) throw new Error(cfgR.error.msg);
const cfg = cfgR.value;
const input = { runId: "r1", workspaceRef: "repo/acme@abc123", variant: "base", runToken: "tok_0123456789abcdef" };

describe("runner template (spec 4.1)", () => {
  const o = runnerContainerOptions(cfg, input);
  const h = o.HostConfig!;

  it("uses the fixed hardening", () => {
    expect(o.User).toBe("10001:10001");
    expect(h.Privileged).toBe(false);
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.CapDrop).toEqual(["ALL"]);
    expect(h.CapAdd).toBeUndefined();
    expect(h.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(h.Tmpfs?.["/tmp"]).toMatch(/noexec/);
    expect(h.Tmpfs?.["/tmp"]).toMatch(/nosuid/);
    expect(h.Tmpfs?.["/tmp"]).toMatch(/size=\d+/);
    expect(h.Memory).toBeGreaterThan(0);
    expect(h.MemorySwap).toBe(h.Memory);
    expect(h.NanoCpus).toBeGreaterThan(0);
    expect(h.PidsLimit).toBeGreaterThan(0);
    expect(h.RestartPolicy?.Name).toBe("no");
  });

  it("never grants host namespaces, devices, sockets or bind mounts", () => {
    expect(h.NetworkMode).toBe("run-r1");
    expect(h.PidMode).toBe("");
    expect(h.IpcMode).toBe("private");
    expect(h.UsernsMode).toBe("");
    expect(h.Devices).toEqual([]);
    expect(h.Binds).toEqual([]);
    expect(h.PublishAllPorts).toBe(false);
    expect(h.PortBindings).toBeUndefined();
    expect(JSON.stringify(o)).not.toContain("docker.sock");
    expect(o.ExposedPorts).toBeUndefined();
  });

  it("mounts exactly one named volume at /workspace", () => {
    expect(h.Mounts).toEqual([{ Type: "volume", Source: "ws-r1", Target: "/workspace", ReadOnly: false }]);
  });

  it("passes exactly four environment variables", () => {
    const keys = (o.Env ?? []).map((e) => e.split("=")[0]).sort();
    expect(keys).toEqual(["EDGE_URL", "GANTRY_RUN_ID", "GANTRY_RUN_TOKEN", "HTTPS_PROXY"]);
    expect(o.Env).toContain("HTTPS_PROXY=http://gantry-edge:8444");
    expect(o.Env).toContain("EDGE_URL=http://gantry-edge:8443");
  });

  it("is attached to its run network only and labelled", () => {
    expect(Object.keys(o.NetworkingConfig?.EndpointsConfig ?? {})).toEqual(["run-r1"]);
    expect(o.Labels?.["gantry.run"]).toBe("r1");
    expect(o.name).toBe(names.container("r1"));
  });

  it("resolves the image from the allow-list, not from the caller", () => {
    expect(runnerContainerOptions(cfg, { ...input, variant: "node" }).Image).toBe("gantry-runner:node");
    expect(() => runnerContainerOptions(cfg, { ...input, variant: "evil" })).toThrow();
  });

  it("creates an internal network with the allocated subnet", () => {
    const n = networkOptions(cfg, input, "10.213.0.0/28");
    expect(n.Internal).toBe(true);
    expect(n.Name).toBe("run-r1");
    expect(n.IPAM?.Config).toEqual([{ Subnet: "10.213.0.0/28" }]);
    expect(n.EnableIPv6).toBe(false);
  });
});

describe("start-run request schema", () => {
  const schema = startRunSchema(cfg);
  it("accepts the three caller inputs plus the run token", () => {
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, seedComplete: false }).success).toBe(true);
  });
  it.each([
    ["unknown variant", { variant: "other" }],
    ["image override", { image: "alpine" }],
    ["privileged", { Privileged: true }],
    ["binds", { Binds: ["/:/host"] }],
    ["command", { cmd: ["sh"] }],
    ["bad run id", { runId: "../x" }],
    ["short token", { runToken: "short" }],
  ])("refuses %s", (_n, patch) => {
    expect(schema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
});

describe("config", () => {
  it("refuses a concurrency cap above the pool capacity", () => {
    const r = loadConfig({ RUN_SUBNET_POOL: "10.213.0.0/24", RUN_SUBNET_PREFIX: "28", MAX_CONCURRENT_RUNS: "17" });
    expect(r.ok).toBe(false);
  });
  it("refuses a malformed variant list", () => {
    expect(loadConfig({ RUNNER_VARIANTS: "base" }).ok).toBe(false);
  });
});

describe("cidr", () => {
  it("allocates the first free /28 and skips used ranges", () => {
    const pool = parseCidr("10.213.0.0/16")!;
    expect(blockCount(pool, 28)).toBe(4096);
    const used = [parseCidr("10.213.0.0/28")!, parseCidr("10.213.0.16/28")!, parseCidr("10.213.0.0/24", { align: true })!];
    expect(formatCidr(firstFreeBlock(pool, 28, used)!)).toBe("10.213.1.0/28");
    expect(formatCidr(firstFreeBlock(pool, 28, [], new Set(["10.213.0.0/28"]))!)).toBe("10.213.0.16/28");
  });
  it("reports exhaustion", () => {
    const pool = parseCidr("10.213.0.0/30")!;
    expect(firstFreeBlock(pool, 30, [pool])).toBeUndefined();
  });
  it("rejects unaligned and malformed input", () => {
    expect(parseCidr("10.0.0.1/24")).toBeUndefined();
    expect(parseCidr("10.0.0.300/24")).toBeUndefined();
    expect(parseCidr("10.0.0.0/33")).toBeUndefined();
  });
});
