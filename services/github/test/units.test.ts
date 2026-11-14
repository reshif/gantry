import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AppSettings } from "../src/config.js";
import { redact } from "../src/git.js";
import { OPERATIONS } from "../src/github.js";
import { WriteLimiter } from "../src/ratelimit.js";
import { cloneBase } from "../src/seed.js";
import { TarError, extractTar, tarDirectory } from "../src/tar.js";
import { VOLUME_NAME } from "../src/workspace.js";

const tmp = () => mkdtemp(join(tmpdir(), "gh-unit-"));
const collect = async (r: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> => { const c: Buffer[] = []; for await (const x of r) c.push(Buffer.from(x)); return Buffer.concat(c); };
const block = (name: string, type: string, size = 0): Buffer => {
  const h = Buffer.alloc(512);
  h.write(name, 0); h.write("0000644\0", 100); h.write(size.toString(8).padStart(11, "0") + "\0", 124); h.write(type, 156); h.write("ustar\0", 257);
  return h;
};

describe("tar", () => {
  it("round-trips files, directories, long names and modes, owned by the given ids", async () => {
    const a = await tmp(), b = await tmp();
    const long = "d".repeat(60) + "/" + "e".repeat(60) + "/file.txt";
    await mkdir(join(a, "d".repeat(60), "e".repeat(60)), { recursive: true });
    await writeFile(join(a, long), "long path");
    await writeFile(join(a, "plain.txt"), "x".repeat(1000));
    await mkdir(join(a, "empty"));
    const tar = tarDirectory(a, { uid: 10001, gid: 10001 });
    const bytes = await collect(tar);
    expect(bytes.readUIntBE(0, 1)).toBeGreaterThan(0);
    const r = await extractTar(Readable.from([bytes]), b, { maxBytes: 1 << 20 });
    expect(r.files).toBe(2);
    expect(await readFile(join(b, long), "utf8")).toBe("long path");
    expect((await readFile(join(b, "plain.txt"))).length).toBe(1000);
    expect((await stat(join(b, "empty"))).isDirectory()).toBe(true);
    // The writer sets the runner's uid and gid in the headers.
    const hdr = bytes.subarray(0, 512);
    expect(parseInt(hdr.subarray(108, 115).toString("ascii"), 8)).toBe(10001);
    await rm(a, { recursive: true }); await rm(b, { recursive: true });
  });
  it("skips symlinks and refuses paths that escape the destination, and oversized archives", async () => {
    const a = await tmp(), b = await tmp();
    await writeFile(join(a, "f"), "1");
    await symlink("/etc/passwd", join(a, "link"));
    const r = await extractTar(tarDirectory(a, { uid: 0, gid: 0 }), b, { maxBytes: 1 << 20 });
    expect(r.files).toBe(1);
    await expect(stat(join(b, "link"))).rejects.toThrow();
    const evil = Buffer.concat([block("../escape", "0", 1), Buffer.from("x".padEnd(512, "\0")), Buffer.alloc(1024)]);
    await expect(extractTar(Readable.from([evil]), b, { maxBytes: 1000 })).rejects.toThrow(TarError);
    const abs = Buffer.concat([block("/etc/cron.d/x", "0", 1), Buffer.from("x".padEnd(512, "\0")), Buffer.alloc(1024)]);
    await expect(extractTar(Readable.from([abs]), b, { maxBytes: 1000 })).rejects.toThrow(/unsafe/);
    const big = Buffer.concat([block("big", "0", 5000), Buffer.alloc(5120), Buffer.alloc(1024)]);
    await expect(extractTar(Readable.from([big]), b, { maxBytes: 1000 })).rejects.toThrow(/larger/);
    await expect(extractTar(Readable.from([block("t", "0", 100)]), b, { maxBytes: 1000 })).rejects.toThrow(/truncated/);
  });
  it("only materialises what `map` selects (alternates and config are never copied)", async () => {
    const a = await tmp(), b = await tmp();
    await mkdir(join(a, "objects/info"), { recursive: true });
    await writeFile(join(a, "objects/info/alternates"), "/etc"); await writeFile(join(a, "objects/ab"), "o"); await writeFile(join(a, "config"), "[core]");
    await extractTar(tarDirectory(a, { uid: 0, gid: 0 }), b, { maxBytes: 1 << 20, map: (n) => ((n === "objects" || n.startsWith("objects/")) && !n.startsWith("objects/info") ? n : null) });
    expect(await readFile(join(b, "objects/ab"), "utf8")).toBe("o");
    await expect(stat(join(b, "config"))).rejects.toThrow();
    await expect(stat(join(b, "objects/info/alternates"))).rejects.toThrow();
  });
});

describe("write limiter", () => {
  it("lets a burst through, then spaces writes at the per-minute rate, per installation", async () => {
    let t = 0;
    const waited: number[] = [];
    const lim = new WriteLimiter(60, 2, () => t, async (ms) => { waited.push(ms); t += ms; });
    const order: string[] = [];
    await Promise.all([1, 2, 3, 4].map((i) => lim.write("inst-1", async () => { order.push(`a${i}`); })));
    expect(order).toEqual(["a1", "a2", "a3", "a4"]);
    expect(waited).toEqual([1000, 1000]); // 60/min = one per second after the burst of two
    waited.length = 0;
    await lim.write("inst-2", async () => undefined); // another installation has its own bucket
    expect(waited).toEqual([]);
  });
  it("a failing write does not block those queued behind it", async () => {
    const lim = new WriteLimiter(6000, 10);
    const r = await Promise.allSettled([lim.write("k", async () => { throw new Error("x"); }), lim.write("k", async () => "ok")]);
    expect(r.map((x) => x.status)).toEqual(["rejected", "fulfilled"]);
  });
});

describe("small things", () => {
  it("redacts credentials from git output", () => {
    expect(redact("fatal: Authorization: Basic eHh4OnNlY3JldA== failed")).toBe("fatal: Authorization: Basic [redacted] failed");
    expect(redact("https://x-access-token:ghs_abc123@github.com/o/r.git")).not.toMatch(/ghs_abc123/);
    expect(redact("token ghs_AbCdEf1234 here")).toBe("token [redacted] here");
  });
  it("derives the clone host from the API base URL (cloud and Enterprise Server)", () => {
    expect(cloneBase("https://api.github.com")).toBe("https://github.com");
    expect(cloneBase("https://ghe.example.com/api/v3")).toBe("https://ghe.example.com");
    expect(cloneBase("https://ghe.example.com/api/v3/")).toBe("https://ghe.example.com");
  });
  it("accepts only launcher workspace volume names", () => {
    for (const ok of ["ws-run1", "ws-a_b-c"]) expect(VOLUME_NAME.test(ok)).toBe(true);
    for (const bad of ["run1", "ws-", "ws-../x", "ws-a/b", "/var/lib/docker", "ws-" + "a".repeat(80), "ws-a b"]) expect(VOLUME_NAME.test(bad)).toBe(false);
  });
  it("parses the App settings file, with the cloud URL as the default", () => {
    expect(AppSettings.parse({ appId: "123" })).toEqual({ appId: 123, baseUrl: "https://api.github.com" });
    expect(AppSettings.parse({ appId: 5, baseUrl: "https://ghe.example.com/api/v3", installationId: "9" })).toMatchObject({ installationId: 9 });
    expect(() => AppSettings.parse({ baseUrl: "https://x" })).toThrow();
  });
  it("never asks for a permission outside spec 11.1, and never for administration write or secrets", () => {
    const allowed: Record<string, string[]> = { metadata: ["read"], contents: ["read", "write"], pull_requests: ["read", "write"], issues: ["read", "write"], checks: ["read", "write"], actions: ["read"], statuses: ["read"], administration: ["read"] };
    for (const [op, perms] of Object.entries(OPERATIONS)) for (const [k, v] of Object.entries(perms)) {
      // Workflows write is requested only for an onboarding pull request that adds a workflow file (spec 11.1).
      if (k === "workflows") { expect(op, "workflows may be requested only by the workflow-adding onboarding pull request").toBe("onboard_pr_workflows"); expect(v).toBe("write"); continue; }
      expect(allowed[k]?.includes(v), `${op}: ${k}=${v}`).toBe(true);
    }
  });
});
