import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BIG_HOST } from "./host.js";
import { runnerContainerOptions, names } from "../src/template.js";
import { checkContainer, checkHelperCreate, checkList, DEFAULT_LIMITS, isHelper, route, routeWorkspace, slimNetworks } from "../src/sockpolicy.js";

const cfgR = loadConfig({ RUNNER_VARIANTS: "base=gantry-runner:dev", EDGE_URL: "http://gantry-edge:8443" }, BIG_HOST);
if (!cfgR.ok) throw new Error(cfgR.error.msg);
const cfg = cfgR.value;
const input = { runId: "r1", workspaceRef: "repo/acme@abc123", variant: "base", runToken: "tok_0123456789abcdef" };
const images = new Set(["gantry-runner:dev"]);
const q = new URLSearchParams({ name: names.container("r1") });
const tpl = () => JSON.parse(JSON.stringify(runnerContainerOptions(cfg, input))) as Record<string, any>;
const withHost = (patch: Record<string, unknown>) => { const o = tpl(); Object.assign(o.HostConfig, patch); return o; };
const without = (k: string) => { const o = tpl(); delete o.HostConfig[k]; return o; };

describe("socket proxy: default-deny on the fields that used to be deny-listed", () => {
  const bad: Array<[string, Record<string, any>]> = [
    ["user 00", { ...tpl(), User: "00" }],
    ["user +0:0", { ...tpl(), User: "+0:0" }],
    ["gid 0", { ...tpl(), User: "10001:0" }],
    ["user by name", { ...tpl(), User: "nobody" }],
    ["inline seccomp allow-all", withHost({ SecurityOpt: ["no-new-privileges:true", 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'] })],
    ["selinux type", withHost({ SecurityOpt: ["no-new-privileges:true", "label=type:spc_t"] })],
    ["apparmor", withHost({ SecurityOpt: ["no-new-privileges:true", "apparmor=foo"] })],
    ["extra compose label", { ...tpl(), Labels: { ...tpl().Labels, "com.docker.compose.service": "gantry-edge" } }],
    ["another run's network", withHost({ NetworkMode: "run-b" })],
    ["another run's volume", withHost({ Mounts: [{ Type: "volume", Source: "ws-b", Target: "/workspace", ReadOnly: false }] })],
    ["run label not matching the name", { ...tpl(), Labels: { ...tpl().Labels, "gantry.run": "b" } }],
    ["shareable ipc", withHost({ IpcMode: "shareable" })],
    ["no ipc mode", without("IpcMode")],
    ["no memory limit", without("Memory")],
    ["no swap limit", without("MemorySwap")],
    ["no pids limit", without("PidsLimit")],
    ["no cpu limit", without("NanoCpus")],
    ["memory above the ceiling", withHost({ Memory: 2 ** 40, MemorySwap: 2 ** 40 })],
    ["pids above the ceiling", withHost({ PidsLimit: 1_000_000 })],
    ["unlimited pids", withHost({ PidsLimit: -1 })],
    ["extra capdrop entry", withHost({ CapDrop: ["ALL", "NET_RAW"] })],
  ];
  for (const [what, body] of bad) it(`refuses ${what}`, () => expect(checkContainer(body, q, images).ok, what).toBe(false));
  it("still passes the real template", () => expect(checkContainer(tpl(), q, images)).toEqual({ ok: true }));
  it("takes the uid from the launcher's configuration", () => {
    const o = tpl();
    o.User = "20000:20000";
    expect(checkContainer(o, q, images).ok).toBe(false);
    expect(checkContainer(o, q, images, { ...DEFAULT_LIMITS, uid: 20000, gid: 20000 }).ok).toBe(true);
  });
});

describe("socket proxy: reads are owned-only", () => {
  it("asks for an ownership check on inspect of containers, networks and volumes", () => {
    expect(route("GET", "/containers/gantry-gantry-github-1/json").owned).toMatchObject({ kind: "container", id: "gantry-gantry-github-1" });
    expect(route("GET", "/networks/x").owned).toMatchObject({ kind: "network" });
    expect(route("GET", "/volumes/x").owned).toMatchObject({ kind: "volume" });
  });
  it("refuses an unfiltered container or volume list, and a filter on someone else's label", () => {
    const f = (o: object) => new URLSearchParams({ filters: JSON.stringify(o) });
    expect(checkList("containers", new URLSearchParams({ all: "1" }), "gantry-edge").ok).toBe(false);
    expect(checkList("containers", f({ label: ["app=db"] }), "gantry-edge").ok).toBe(false);
    expect(checkList("volumes", f({ label: ["com.docker.compose.service=gantry-edge"] }), "gantry-edge").ok).toBe(false);
    expect(checkList("containers", f({ label: ["gantry.managed-by=gantry-launcher"] }), "gantry-edge").ok).toBe(true);
    expect(checkList("containers", f({ label: ["com.docker.compose.service=gantry-edge", "com.docker.compose.project=gantry"], status: ["running"] }), "gantry-edge").ok).toBe(true);
  });
  it("drops endpoints and options from the network list", () => {
    const out = slimNetworks([{ Id: "1", Name: "n", Driver: "bridge", Internal: false, Labels: null, Options: { a: "b" }, Containers: { x: { IPv4Address: "10.0.0.2/24" } }, IPAM: { Driver: "default", Config: [{ Subnet: "10.1.0.0/16", Gateway: "10.1.0.1" }] } }]) as any[];
    expect(out[0]).toEqual({ Id: "1", Name: "n", Driver: "bridge", Internal: false, Labels: null, IPAM: { Config: [{ Subnet: "10.1.0.0/16" }] } });
  });
});

describe("socket proxy: workspace profile (gantry-github)", () => {
  const helper = (patch: Record<string, unknown> = {}, host: Record<string, unknown> = {}) => ({
    Image: "gantry-github:dev", Entrypoint: ["/bin/true"], Cmd: [], User: "10001:10001", NetworkDisabled: true,
    Labels: { "gantry.managed-by": "gantry-github", "gantry.purpose": "workspace-helper" },
    HostConfig: { Binds: ["ws-r1:/workspace"], NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Memory: 64 * 1024 * 1024, PidsLimit: 16, AutoRemove: false, ...host },
    ...patch,
  });
  const nq = new URLSearchParams();
  it("allows exactly what workspace.ts does", () => {
    for (const [m, p] of [["GET", "/v1.43/volumes/ws-r1"], ["POST", "/v1.43/containers/create"], ["PUT", "/containers/abc/archive?path=%2Fworkspace"], ["GET", "/containers/abc/archive?path=%2Fworkspace%2F.git%2Fobjects"], ["HEAD", "/containers/abc/archive?path=%2Fworkspace%2F.git"], ["DELETE", "/containers/abc?force=1&v=0"]] as const) {
      expect(routeWorkspace(m, p).decision.ok, `${m} ${p}`).toBe(true);
    }
    expect(checkHelperCreate(helper(), nq, "gantry-github:dev")).toEqual({ ok: true });
    expect(checkHelperCreate(helper({}, { Binds: ["ws-r1:/workspace:ro"] }), nq, "gantry-github:dev")).toEqual({ ok: true });
  });
  it("refuses everything else: start, exec, other volumes, a path outside /workspace, and the launcher's runner calls", () => {
    for (const [m, p] of [["POST", "/containers/abc/start"], ["POST", "/containers/abc/exec"], ["POST", "/networks/create"], ["POST", "/volumes/create"], ["GET", "/volumes/gantry_pgdata"], ["GET", "/containers/abc/json"], ["GET", "/containers/json"], ["GET", "/info"], ["GET", "/containers/abc/archive?path=%2Fetc"], ["GET", "/containers/abc/archive?path=%2Fworkspace%2F..%2Fetc"], ["GET", "/containers/abc/archive"], ["PUT", "/containers/abc/archive?path=%2F"], ["DELETE", "/volumes/ws-r1"], ["DELETE", "/containers/abc/../x"], ["POST", "/containers/abc/kill"]] as const) {
      expect(routeWorkspace(m, p).decision.ok, `${m} ${p}`).toBe(false);
    }
  });
  it("asks for a label check on the helper before any archive or removal", () => {
    expect(routeWorkspace("PUT", "/containers/abc/archive?path=%2Fworkspace").owned).toEqual({ kind: "helper", id: "abc" });
    expect(routeWorkspace("DELETE", "/containers/abc").owned).toEqual({ kind: "helper", id: "abc" });
    expect(isHelper({ "gantry.managed-by": "gantry-launcher" })).toBe(false);
  });
  const badHelper: Array<[string, Record<string, any>]> = [
    ["root bind", helper({}, { Binds: ["/:/workspace"] })],
    ["target outside /workspace", helper({}, { Binds: ["ws-r1:/host"] })],
    ["two binds", helper({}, { Binds: ["ws-r1:/workspace", "ws-r2:/workspace2"] })],
    ["privileged", helper({}, { Privileged: true })],
    ["host network", helper({}, { NetworkMode: "host" })],
    ["another image", helper({ Image: "alpine" })],
    ["a command", helper({ Cmd: ["sh"] })],
    ["another entrypoint", helper({ Entrypoint: ["/bin/sh"] })],
    ["root", helper({ User: "0:0" })],
    ["a runner label", helper({ Labels: { "gantry.managed-by": "gantry-launcher" } })],
    ["extra label", helper({ Labels: { "gantry.managed-by": "gantry-github", "gantry.purpose": "workspace-helper", x: "y" } })],
    ["writable root", helper({}, { ReadonlyRootfs: false })],
    ["cap add", helper({}, { CapAdd: ["SYS_ADMIN"] })],
    ["no memory limit", helper({}, { Memory: undefined })],
    ["env", helper({ Env: ["A=b"] })],
  ];
  it("keeps a helper's name out of the runner namespace", () => {
    for (const n of ["gantry-runner-r1", "gantry-ws-helper-", "other", "gantry-ws-helper-a/b"]) expect(checkHelperCreate(helper(), new URLSearchParams({ name: n }), "gantry-github:dev").ok, n).toBe(false);
    expect(checkHelperCreate(helper(), new URLSearchParams({ name: "gantry-ws-helper-r1" }), "gantry-github:dev").ok).toBe(true);
    expect(checkHelperCreate(helper(), new URLSearchParams("name=gantry-ws-helper-a&name=gantry-runner-b"), "gantry-github:dev").ok).toBe(false);
  });
  for (const [what, body] of badHelper) it(`refuses a helper with ${what}`, () => expect(checkHelperCreate(body, nq, "gantry-github:dev").ok, what).toBe(false));
});
