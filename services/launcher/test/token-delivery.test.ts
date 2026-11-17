/**
 * The run token never rides in the container's environment (/proc/1/environ is readable by every process of the runner uid). It is copied
 * into the workspace volume as a file the wrapper reads and unlinks. These tests pin the launcher side and the proxy policy for it.
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { RunManager } from "../src/manager.js";
import { DEFAULT_LIMITS, checkContainer, checkTokenArchive, route } from "../src/sockpolicy.js";
import { createRequest, names, runnerContainerOptions, tokenArchive, TOKEN_FILE_NAME } from "../src/template.js";

const TOKEN = "tok_0123456789abcdef";
const cfgR = loadConfig({ RUNNER_VARIANTS: "base=gantry-runner:dev", EDGE_URL: "http://gantry-edge:8443", EDGE_PROXY_URL: "http://run:x@gantry-edge:8444" });
if (!cfgR.ok) throw new Error(cfgR.error.msg);
const cfg = cfgR.value;
const input = { runId: "r1", workspaceRef: "repo/acme@abc123", variant: "base", runToken: TOKEN };
const images = new Set(["gantry-runner:dev"]);
const q = new URLSearchParams({ name: names.container("r1") });
const tpl = () => JSON.parse(JSON.stringify(runnerContainerOptions(cfg, input))) as Record<string, any>;
const check = (o: unknown) => checkContainer(o, q, images, DEFAULT_LIMITS);

describe("checkContainer and the run token", () => {
  it("accepts the template, which carries no token", () => {
    expect(check(tpl())).toEqual({ ok: true });
    expect(JSON.stringify(tpl())).not.toContain(TOKEN);
  });
  it("refuses an Env containing GANTRY_RUN_TOKEN", () => {
    const o = tpl();
    o.Env.push(`GANTRY_RUN_TOKEN=${TOKEN}`);
    const d = check(o);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.why).toMatch(/run token/);
    const lower = tpl();
    lower.Env.push(`gantry_run_token=${TOKEN}`);
    expect(check(lower).ok).toBe(false);
  });
  it("refuses proxy credentials in HTTPS_PROXY (the run token is the proxy password)", () => {
    const o = tpl();
    o.Env = o.Env.map((e: string) => (e.startsWith("HTTPS_PROXY=") ? `HTTPS_PROXY=http://run:${TOKEN}@gantry-edge:8444` : e));
    expect(check(o).ok).toBe(false);
  });
  it("refuses stdin and tty, and keeps the rest of the template exact", () => {
    for (const patch of [{ OpenStdin: true }, { AttachStdin: true }, { Tty: true }]) expect(check({ ...tpl(), ...patch }).ok).toBe(false);
    const o = tpl();
    o.HostConfig.ReadonlyRootfs = false;
    expect(check(o).ok).toBe(false);
  });
});

describe("the launcher's create", () => {
  it("carries the token nowhere in the create request, query or body", () => {
    const req = createRequest(runnerContainerOptions(cfg, input));
    expect(JSON.stringify(req)).not.toContain(TOKEN);
    expect(Buffer.from(JSON.stringify(req._body)).toString("base64")).not.toContain(Buffer.from(TOKEN).toString("base64"));
  });

  it("copies the token as a file after the create and before the start, and never in the create body", async () => {
    const calls: string[] = [];
    let created: unknown;
    let archive: { buf: Buffer; path: string } | undefined;
    const container = {
      start: vi.fn(async () => void calls.push("start")),
      putArchive: vi.fn(async (buf: Buffer, o: { path: string }) => {
        calls.push("putArchive");
        archive = { buf, path: o.path };
      }),
    };
    const docker = {
      getVolume: () => ({ inspect: async () => ({ Labels: { "gantry.run": "r1" } }) }),
      getNetwork: () => ({ inspect: async () => ({ Labels: { "gantry.run": "r1" }, IPAM: { Config: [{ Subnet: "10.0.0.0/28" }] }, Containers: { edge1: {} } }) }),
      getContainer: () => ({ inspect: async () => { throw Object.assign(new Error("no"), { statusCode: 404 }); } }),
      getImage: () => ({ inspect: async () => ({}) }),
      listContainers: async () => [{ Id: "edge1" }],
      createContainer: async (o: unknown) => {
        calls.push("create");
        created = o;
        return container;
      },
    };
    const r = await new RunManager(docker as never, cfg).start(input);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(calls).toEqual(["create", "putArchive", "start"]);
    expect(JSON.stringify(created)).not.toContain(TOKEN);
    expect(archive!.path).toBe("/workspace");
    expect(archive!.buf.toString("latin1")).toContain(TOKEN);
    expect(checkTokenArchive(new URLSearchParams({ path: archive!.path }), archive!.buf)).toEqual({ ok: true });
  });

  it("rolls back and reports an error when the token cannot be delivered", async () => {
    const removed: string[] = [];
    const container = { start: vi.fn(), putArchive: vi.fn(async () => { throw new Error("archive failed"); }) };
    const docker = {
      getVolume: () => ({ inspect: async () => ({ Labels: { "gantry.run": "r1" } }), remove: async () => void removed.push("volume") }),
      getNetwork: () => ({ inspect: async () => ({ Labels: { "gantry.run": "r1" }, IPAM: { Config: [{ Subnet: "10.0.0.0/28" }] }, Containers: {} }), remove: async () => void removed.push("network"), disconnect: async () => undefined }),
      getContainer: () => ({ inspect: async () => { throw Object.assign(new Error("no"), { statusCode: 404 }); }, remove: async () => void removed.push("container") }),
      getImage: () => ({ inspect: async () => ({}) }),
      listContainers: async () => [{ Id: "edge1" }],
      createContainer: async () => container,
    };
    const r = await new RunManager(docker as never, cfg).start(input);
    expect(r.ok).toBe(false);
    expect(container.start).not.toHaveBeenCalled();
  });
});

describe("the token archive and the proxy", () => {
  const ok = () => tokenArchive(TOKEN, 10001, 10001);
  const p = (path = "/workspace") => new URLSearchParams({ path });
  it("is a one-file tar: the template's name, mode 0400, runner uid", () => {
    const a = ok();
    expect(a.subarray(0, TOKEN_FILE_NAME.length).toString()).toBe(TOKEN_FILE_NAME);
    expect(a.subarray(100, 107).toString()).toBe("0000400");
    expect(a.length % 512).toBe(0);
    expect(checkTokenArchive(p(), a)).toEqual({ ok: true });
  });
  it("routes a PUT archive to an owned container, and nothing else under PUT", () => {
    expect(route("PUT", "/containers/abc/archive?path=/workspace")).toMatchObject({ decision: { ok: true }, owned: { kind: "container", id: "abc" }, body: "archive" });
    expect(route("PUT", "/containers/abc/start").decision.ok).toBe(false);
    expect(route("GET", "/containers/abc/archive?path=/").decision.ok).toBe(false);
  });
  it("refuses another path, extra parameters, another file name, a link, a loose mode and trailing entries", () => {
    expect(checkTokenArchive(p("/"), ok()).ok).toBe(false);
    expect(checkTokenArchive(p("/workspace/x"), ok()).ok).toBe(false);
    expect(checkTokenArchive(new URLSearchParams({ path: "/workspace", copyUIDGID: "1" }), ok()).ok).toBe(false);
    const bad = (mut: (b: Buffer) => void) => {
      const b = Buffer.from(ok());
      mut(b);
      return checkTokenArchive(p(), b).ok;
    };
    expect(bad((b) => void b.write("evil", 0))).toBe(false);
    expect(bad((b) => void b.write("2", 156))).toBe(false);
    expect(bad((b) => void b.write("/etc/passwd", 157))).toBe(false);
    expect(bad((b) => void b.write("0000644", 100))).toBe(false);
    expect(bad((b) => void b.write("x", b.length - 1))).toBe(false);
    expect(checkTokenArchive(p(), Buffer.concat([ok(), Buffer.alloc(512, 1)])).ok).toBe(false);
    expect(checkTokenArchive(p(), Buffer.alloc(0)).ok).toBe(false);
  });
});
