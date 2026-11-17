import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEnv } from "../src/env.js";
import { takeToken } from "../src/token.js";

const TOKEN = "run-token-abcdef123456";
let dir: string;
afterEach(async () => {
  if (dir) {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
const mk = async () => (dir = await mkdtemp(join(tmpdir(), "gantry-token-")));

describe("the run token file", () => {
  it("is read once and removed", async () => {
    await mk();
    const f = join(dir, ".gantry-run-token");
    await writeFile(f, `${TOKEN}\n`, { mode: 0o400 });
    expect(await takeToken(f)).toEqual({ ok: true, value: TOKEN });
    expect(await readdir(dir)).toEqual([]);
    const again = await takeToken(f);
    expect(again.ok).toBe(false);
  });

  it("fails closed when the file cannot be removed, without echoing the token", async () => {
    if (process.getuid?.() === 0) return; // root ignores directory modes
    await mk();
    const f = join(dir, ".gantry-run-token");
    await writeFile(f, TOKEN);
    await chmod(dir, 0o500);
    const r = await takeToken(f);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("refuses an empty file", async () => {
    await mk();
    const f = join(dir, "t");
    await writeFile(f, "\n");
    expect((await takeToken(f)).ok).toBe(false);
  });

  it("is refused by readEnv when the token is also in the environment", () => {
    const base = { EDGE_URL: "http://edge:8443", GANTRY_RUN_ID: "r1" };
    expect(readEnv(TOKEN, base)).toMatchObject({ ok: true, value: { runToken: TOKEN, runId: "r1" } });
    expect(readEnv(TOKEN, { ...base, GANTRY_RUN_TOKEN: TOKEN }).ok).toBe(false);
  });
});

describe("after the wrapper has started, nothing a tool subprocess can read holds the token", () => {
  it("not /proc/<wrapper>/environ, cmdline, its own environ, /proc/1, or any file under the workspace", async () => {
    await mk();
    const ws = join(dir, "workspace");
    await mkdir(join(ws, "sub"), { recursive: true });
    const f = join(ws, ".gantry-run-token");
    await writeFile(f, TOKEN, { mode: 0o400 });
    await writeFile(join(ws, "sub", "other.txt"), "unrelated");
    // The launcher's environment for the wrapper: no token anywhere in it.
    const env = { PATH: process.env.PATH ?? "", HOME: dir, EDGE_URL: "http://edge:8443", GANTRY_RUN_ID: "r1" };
    const out = execFileSync(join(__dirname, "../../../node_modules/.bin/vite-node"), [join(__dirname, "fixtures/wrapper-sim.ts"), f, ws], { encoding: "utf8", env, cwd: join(__dirname, "..") });
    const r = JSON.parse(out.trim().split("\n").at(-1)!) as { token: string; hunt: { where: string[] } };
    expect(r.token).toBe(TOKEN); // the wrapper did get it (and holds it in memory)
    expect(r.hunt.where).toEqual([]);
    expect(await readdir(ws)).toEqual(["sub"]);
  });

  it("control: the same hunt does find a token left in the environment or in a file", async () => {
    await mk();
    await writeFile(join(dir, "leak"), TOKEN);
    const hunt = `const fs=require("fs");const T=process.env.T;console.log(JSON.stringify([fs.readFileSync("/proc/self/environ","latin1").includes(T), fs.readFileSync(process.argv[1],"latin1").includes(T)]))`;
    const o = execFileSync(process.execPath, ["-e", hunt, join(dir, "leak")], { encoding: "utf8", env: { T: TOKEN } });
    expect(JSON.parse(o)).toEqual([true, true]);
  });
});
