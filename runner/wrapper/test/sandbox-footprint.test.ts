import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeInvocation, GIT_FRONT_DIR, GIT_PATH_DENIES } from "../src/adapters/claude.js";
import { stubAdapter } from "../src/adapters/stub.js";
import { EdgeClient } from "../src/edge.js";
import { readEnv } from "../src/env.js";
import { runWrapper } from "../src/main.js";
import { RunSpec } from "../src/spec.js";
import { duBytes, watchWorkspace, workspaceMessage } from "../src/workspace-cap.js";
import { startFakeEdge, type FakeEdge } from "./helpers.js";

const TOKEN = "run-token-abcdef123456";
const dirs: string[] = [];
let edge: FakeEdge | undefined;
afterEach(async () => {
  await edge?.close();
  edge = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sbx-"));
  dirs.push(d);
  return d;
};

describe("S-90: the wrapper stops a run whose workspace is over its cap", () => {
  it("reads the cap from the environment the launcher sets", () => {
    const env = { EDGE_URL: "http://gantry-edge:8443", GANTRY_RUN_ID: "r1", GANTRY_WORKSPACE_MAX_MB: "10240" };
    const r = readEnv(TOKEN, env);
    expect(r.ok && r.value.workspaceMaxBytes).toBe(10240 * 1024 * 1024);
    const none = readEnv(TOKEN, { EDGE_URL: "http://gantry-edge:8443", GANTRY_RUN_ID: "r1" });
    expect(none.ok && none.value.workspaceMaxBytes).toBeUndefined();
  });

  it("measures real disk use", async () => {
    const d = tmp();
    writeFileSync(join(d, "big"), Buffer.alloc(3 * 1024 * 1024, 1));
    expect(await duBytes(d)).toBeGreaterThanOrEqual(3 * 1024 * 1024);
  });

  it("reports a breach once and says how big the cap is", async () => {
    let seen = 0;
    const stop = watchWorkspace({ dir: "/x", maxBytes: 100, intervalMs: 5, measure: async () => 500, onOver: () => void seen++ });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(seen).toBe(1);
    expect(workspaceMessage(10 * 2 ** 30, 11 * 2 ** 30)).toMatch(/workspace over 10\.0 GB/);
  });

  it("a run that fills its workspace is aborted and fails with workspace_over_limit", async () => {
    const spec = RunSpec.parse({ adapter: "stub", station: "spec", instructions: "x", input: {} });
    edge = await startFakeEdge(spec, TOKEN);
    const hang = { ...stubAdapter, run: (ctx: { signal: AbortSignal }) => new Promise((res) => { const done = () => res({ status: "interrupted", usage: [] }); if (ctx.signal.aborted) done(); else ctx.signal.addEventListener("abort", done); }) } as unknown as typeof stubAdapter;
    const env = { edgeUrl: edge.url, runToken: TOKEN, runId: "r1", workspace: "/workspace", workspaceMaxBytes: 1000 };
    const code = await runWrapper({ env, edge: new EdgeClient(env), adapters: { stub: hang, claude: hang }, log: () => undefined, stationDir: tmp(), onSignal: () => () => undefined, workspaceCheck: { intervalMs: 5, measure: async () => 5000 } });
    expect(code).toBe(0);
    const result = edge.calls.find((c) => c.path === "/run/v1/result")!;
    expect(result.body.status).toBe("failed");
    expect(result.body.error.code).toBe("workspace_over_limit");
    expect(result.body.error.msg).toMatch(/workspace over/);
  });
});

describe("S-91: a write-only agent cannot run commands through git config", () => {
  const spec = RunSpec.parse({ adapter: "claude", station: "build", model: "m", toolAllowList: ["Read", "Edit", "Write", "NotebookEdit", "Bash(git add:*)", "Bash(git commit:*)"] });
  const env = { edgeUrl: "http://gantry-edge:8443", runToken: TOKEN, runId: "r1", workspace: "/workspace" };
  const inv = buildClaudeInvocation(spec, env, "http://127.0.0.1:1", { PATH: "/usr/bin:/bin" });
  const denies = inv.args[inv.args.indexOf("--disallowedTools") + 1]!.split(",");

  it("denies every file tool on .git, in every spelling, even when the tool is granted", () => {
    for (const t of ["Edit", "Write", "NotebookEdit"]) for (const p of [".git/**", "**/.git/**", "/workspace/.git/**", "**/.gitattributes", "**/.gitmodules"]) expect(denies).toContain(`${t}(${p})`);
    expect(GIT_PATH_DENIES.length).toBeGreaterThan(0);
  });

  it("runs git hardened: no system or global config, hooks, fsmonitor, external diff and ssh command off, the git front first on PATH", () => {
    expect(inv.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(inv.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    const cfg = Object.fromEntries(Array.from({ length: Number(inv.env.GIT_CONFIG_COUNT) }, (_, i) => [inv.env[`GIT_CONFIG_KEY_${i}`], inv.env[`GIT_CONFIG_VALUE_${i}`]]));
    expect(cfg).toMatchObject({ "core.hooksPath": "/dev/null", "core.fsmonitor": "false", "diff.external": "", "core.sshCommand": "false" });
    expect(inv.env.PATH!.split(":")[0]).toBe(GIT_FRONT_DIR);
    expect(existsSync(join(GIT_FRONT_DIR, "git"))).toBe(true);
  });

  // The probe of the sandbox review (probe3-git-filter): a filter and a textconv in .git/config, then `git add` and `git diff`.
  describe("the git front, against real git (replay of the probe)", () => {
    const front = join(GIT_FRONT_DIR, "git");
    const base = () => ({ PATH: process.env.PATH!, HOME: tmp(), GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a" });
    const run = (cwd: string, args: string[]) => {
      try {
        return { code: 0, out: execFileSync(front, args, { cwd, env: base(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        const x = e as { status: number; stderr: string };
        return { code: x.status, out: x.stderr };
      }
    };
    const repo = () => {
      const d = tmp();
      execFileSync("git", ["init", "-q", "."], { cwd: d });
      writeFileSync(join(d, "f"), "hi\n");
      expect(run(d, ["add", "f"]).code).toBe(0);
      expect(run(d, ["commit", "-qm", "init"]).code).toBe(0);
      return d;
    };

    it("works for add, commit, status, diff and log on a clean repository", () => {
      const d = repo();
      writeFileSync(join(d, "f"), "changed\n");
      expect(run(d, ["diff", "HEAD"]).out).toContain("+changed");
      expect(run(d, ["status", "--short"]).out).toContain("f");
      expect(run(d, ["log", "--oneline"]).code).toBe(0);
    });

    it("refuses to run when .git/config holds a filter or textconv, and the script never runs", () => {
      const d = repo();
      const c = join(d, "c.sh");
      writeFileSync(c, `#!/bin/sh\nid > ${d}/PWN_CLEAN\ncat\n`);
      chmodSync(c, 0o755);
      const t = join(d, "t.sh");
      writeFileSync(t, `#!/bin/sh\nid > ${d}/PWN_TEXTCONV\ncat "$1"\n`);
      chmodSync(t, 0o755);
      appendFileSync(join(d, ".git", "config"), `\n[filter "x"]\n\tclean = ${c}\n[diff "x"]\n\ttextconv = ${t}\n`);
      writeFileSync(join(d, ".gitattributes"), "* filter=x diff=x\n");
      writeFileSync(join(d, "f"), "changed\n");
      const add = run(d, ["add", "-A"]);
      const diff = run(d, ["diff", "HEAD"]);
      expect([add.code, diff.code]).toEqual([126, 126]);
      expect(add.out).toMatch(/refused by the Gantry sandbox/);
      expect(existsSync(join(d, "PWN_CLEAN"))).toBe(false);
      expect(existsSync(join(d, "PWN_TEXTCONV"))).toBe(false);
    });

    it("refuses an alias, an ssh command and an include in the repository config", () => {
      for (const block of ["[alias]\n\tx = !id\n", "[core]\n\tsshCommand = id\n", "[include]\n\tpath = /tmp/x\n", "[diff]\n\texternal = /bin/id\n"]) {
        const d = repo();
        appendFileSync(join(d, ".git", "config"), `\n${block}`);
        expect(run(d, ["status"]).code, block).toBe(126);
      }
    });

    it("refuses -c, --output and the options that run or write", () => {
      const d = repo();
      for (const args of [["-c", "core.pager=id", "status"], ["--git-dir=/x", "status"], ["log", "--output=.git/config"], ["log", "--outp=x"], ["diff", "--ext-diff"], ["diff", "--textconv"], ["show", "--output", "x"]]) {
        expect(run(d, args).code, args.join(" ")).toBe(126);
      }
      expect(existsSync(join(d, ".git", "x"))).toBe(false);
    });

    it("does not run a hook", () => {
      const d = repo();
      mkdirSync(join(d, ".git", "hooks"), { recursive: true });
      writeFileSync(join(d, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${d}/HOOK_RAN\n`);
      chmodSync(join(d, ".git", "hooks", "pre-commit"), 0o755);
      writeFileSync(join(d, "g"), "x\n");
      run(d, ["add", "g"]);
      expect(run(d, ["commit", "-qm", "two"]).code).toBe(0);
      expect(existsSync(join(d, "HOOK_RAN"))).toBe(false);
    });
  });
});
