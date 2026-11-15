import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildClaudeInvocation, composeSystemPrompt, createClaudeAdapter, extractStructuredOutput, parseStreamLine, usageFromResult } from "../src/adapters/claude.js";
import { EdgeClient } from "../src/edge.js";
import { EXIT, runWrapper } from "../src/main.js";
import { RunSpec } from "../src/spec.js";
import { startFakeEdge, type FakeEdge } from "./helpers.js";

const TOKEN = "run-token-abcdef123456";
const env = { edgeUrl: "http://gantry-edge:8443", runToken: TOKEN, runId: "r1", workspace: "/workspace" };
const spec = RunSpec.parse({
  adapter: "claude",
  station: "build",
  model: "claude-sonnet-4-5-20250929",
  instructions: "Base rules.",
  skills: [{ name: "git", content: "Commit small." }],
  mcpServers: { docs: { type: "http", url: "http://gantry-edge:8443/mcp/docs" } },
  toolAllowList: ["Read", "Edit", "Bash(npm test:*)"],
  limits: { turns: 12, wallClockSeconds: 600 },
  input: { title: "Do it" },
});

describe("claude invocation (flags unverified against a live CLI)", () => {
  const inv = buildClaudeInvocation(spec, env, { PATH: "/usr/bin", HTTPS_PROXY: "http://gantry-edge:8444", GANTRY_RUN_TOKEN: TOKEN, SECRET: "x" });
  const flag = (f: string) => inv.args[inv.args.indexOf(f) + 1];

  it("prevents repo-local settings, hooks and MCP config from loading", () => {
    expect(flag("--setting-sources")).toBe("user");
    expect(inv.args).toContain("--strict-mcp-config");
    expect(flag("--mcp-config")).toBe(inv.mcpConfigPath);
    expect(inv.args).toContain("--disable-slash-commands");
    expect(inv.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(inv.env.CLAUDE_CONFIG_DIR).toMatch(/claude-config$/);
    expect(inv.env.HOME).toMatch(/home$/);
  });

  it("points the harness at the edge's model gateway with the run token only", () => {
    expect(inv.env.ANTHROPIC_BASE_URL).toBe("http://gantry-edge:8443/model");
    expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
    expect(inv.env.NO_PROXY).toBe("gantry-edge");
    expect(inv.env.HTTPS_PROXY).toBe("http://gantry-edge:8444");
    expect(inv.env).not.toHaveProperty("SECRET");
    expect(inv.env).not.toHaveProperty("GANTRY_RUN_TOKEN");
    expect(inv.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("passes limits, model, tools and composed instructions explicitly", () => {
    expect(flag("--max-turns")).toBe("12");
    expect(flag("--model")).toBe("claude-sonnet-4-5-20250929");
    expect(flag("--allowedTools")).toBe("Read,Edit,Bash(npm test:*),mcp__gantry__write_document,mcp__gantry__ask,mcp__gantry__assume,mcp__gantry__propose_research_plan,mcp__gantry__web_fetch,mcp__gantry__spawn_scouts,mcp__gantry__object");
    expect(inv.mcpConfig.mcpServers.gantry).toMatchObject({ type: "stdio" });
    expect(flag("--append-system-prompt")).toContain("write_document");
    const sys = flag("--append-system-prompt")!;
    expect(sys).toContain("Base rules.");
    expect(sys.indexOf("Base rules.")).toBeLessThan(sys.indexOf("## Skill: git"));
    expect(sys).toBe(composeSystemPrompt(spec));
    expect(flag("--output-format")).toBe("stream-json");
  });

  it("gives MCP servers the run token as a header, in a file rather than argv", () => {
    expect(JSON.stringify(inv.args)).not.toContain(TOKEN);
    expect(inv.mcpConfig.mcpServers.docs).toMatchObject({ type: "http", url: "http://gantry-edge:8443/mcp/docs", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(inv.stdin).toContain("Station: build");
  });
});

describe("stream parsing", () => {
  it("extracts the last JSON object block", () => {
    expect(extractStructuredOutput('x\n```json\n{"a":1}\n```\ny\n```json\n{"b":2}\n```')).toEqual({ b: 2 });
    expect(extractStructuredOutput('```json\n[1]\n```')).toBeUndefined();
    expect(extractStructuredOutput('{"c":3}')).toEqual({ c: 3 });
    expect(extractStructuredOutput("no json")).toBeUndefined();
  });
  it("reads a result whose string values contain Markdown code fences (a design note with a ```python example)", () => {
    const result = {
      goal: "Report devices with no secrets group",
      designNotes: "### Interfaces\n`report.py`:\n```python\ndef find(devices):\n    return [d for d in devices if not d.secrets_group]\n```\nThen `jobs.py` wraps it.\n```\nplain fence\n```",
      risks: ["Braces { and } and \"quotes\" inside strings must not end the object"],
    };
    const text = `I've designed the job. Summary first.\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    expect(extractStructuredOutput(text)).toEqual(result);
    // A fence after the JSON (prose with a code sample) does not hide the object either.
    expect(extractStructuredOutput(`${text}\n\nExample:\n\`\`\`python\nprint(1)\n\`\`\``)).toEqual(result);
  });
  it("falls back to the last balanced object when the fence is missing or unlabeled", () => {
    expect(extractStructuredOutput('Done.\n```\n{"a":{"b":"x}y"}}\n```')).toEqual({ a: { b: "x}y" } });
    expect(extractStructuredOutput('prose {not json} then {"ok":true}')).toEqual({ ok: true });
  });
  it("ignores non-JSON lines", () => {
    expect(parseStreamLine("garbage")).toBeUndefined();
    expect(parseStreamLine('{"type":"assistant"}')?.type).toBe("assistant");
  });
  it("reads per-model usage, else aggregate usage", () => {
    const ev = parseStreamLine('{"type":"result","modelUsage":{"m":{"inputTokens":3,"outputTokens":4,"cacheReadInputTokens":1,"costUSD":0.5}}}')!;
    expect(usageFromResult(ev, "x")).toEqual([{ model: "m", inputTokens: 3, outputTokens: 4, cacheReadTokens: 1, costUsd: 0.5 }]);
    const ev2 = parseStreamLine('{"type":"result","usage":{"input_tokens":7,"output_tokens":8},"total_cost_usd":0.1}')!;
    expect(usageFromResult(ev2, "fallback")).toEqual([{ model: "fallback", inputTokens: 7, outputTokens: 8, costUsd: 0.1 }]);
  });
});

/** A stand-in executable that emits stream-json like the harness would. It exercises process handling only, not the model. */
describe("process handling with a stand-in harness executable", () => {
  let dir: string;
  let edge: FakeEdge | undefined;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gantry-fake-claude-"));
    process.env.GANTRY_SCRATCH = join(dir, "scratch");
  });
  afterEach(async () => {
    await edge?.close();
    edge = undefined;
  });

  async function fake(script: string): Promise<string> {
    const p = join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(p, `#!/usr/bin/env node\n${script}`);
    await chmod(p, 0o755);
    return p;
  }
  const run = async (bin: string, overrides: object = {}) => {
    edge = await startFakeEdge({ adapter: "claude", station: "spec", model: "m-1", instructions: "i", input: "go", heartbeatSeconds: 0.1, limits: { turns: 3, wallClockSeconds: 30 }, ...overrides }, TOKEN);
    const e = { edgeUrl: edge.url, runToken: TOKEN, runId: "r1", workspace: dir };
    const adapters = { stub: (await import("../src/adapters/stub.js")).stubAdapter, claude: createClaudeAdapter({ bin, killGraceMs: 300 }) };
    const code = await runWrapper({ env: e, edge: new EdgeClient(e), adapters, log: () => undefined, onSignal: () => () => undefined });
    return { code, calls: edge.calls };
  };

  it("checkpoints each turn and delivers the structured result", async () => {
    const out = join(dir, "argv.json");
    const bin = await fake(`
      import { writeFileSync } from "node:fs";
      let stdin = ""; for await (const c of process.stdin) stdin += c;
      writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), stdin, base: process.env.ANTHROPIC_BASE_URL, cwd: process.cwd() }));
      const emit = (o) => console.log(JSON.stringify(o));
      emit({ type: "system", subtype: "init" });
      emit({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } });
      emit({ type: "user", message: { content: [{ type: "tool_result" }] } });
      emit({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
      emit({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "ok\\n\`\`\`json\\n{\\"goal\\":\\"g\\"}\\n\`\`\`", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
    `);
    const { code, calls } = await run(bin);
    expect(code).toBe(EXIT.delivered);
    const result = calls.at(-1)!.body;
    expect(result).toMatchObject({ status: "succeeded", adapter: "claude", output: { goal: "g" }, usage: [{ model: "m-1", inputTokens: 10, outputTokens: 5, costUsd: 0.01 }] });
    const cps = calls.filter((c) => c.path === "/run/v1/checkpoint").map((c) => c.body);
    expect(cps.length).toBe(2);
    expect(cps[0]).toMatchObject({ kind: "transcript", turn: 1 });
    expect(cps[1].turn).toBe(2);
    const seen = JSON.parse(await readFile(out, "utf8"));
    expect(seen.stdin).toContain("Station: spec");
    expect(seen.base).toBe(`${edge!.url}/model`);
    expect(seen.cwd).toBe(dir);
    expect(seen.argv).toContain("--strict-mcp-config");
  });

  it("fails when the harness exits without a result", async () => {
    const bin = await fake(`console.error("no key"); process.exit(3);`);
    const { calls } = await run(bin);
    expect(calls.at(-1)!.body).toMatchObject({ status: "failed", error: { code: "harness_exit" } });
    expect(calls.at(-1)!.body.error.msg).toContain("no key");
  });

  it("fails when the final message has no structured output", async () => {
    const bin = await fake(`console.log(JSON.stringify({ type: "result", subtype: "success", result: "plain text" }));`);
    const { calls } = await run(bin);
    expect(calls.at(-1)!.body).toMatchObject({ status: "failed", error: { code: "no_structured_output" } });
  });

  it("maps the turn limit to a failure", async () => {
    const bin = await fake(`console.log(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));`);
    const { calls } = await run(bin);
    expect(calls.at(-1)!.body).toMatchObject({ status: "failed", error: { code: "max_turns" } });
  });

  it("kills a harness that ignores SIGTERM when the wall clock expires", async () => {
    const bin = await fake(`process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
    const t0 = Date.now();
    const { code, calls } = await run(bin, { limits: { turns: 3, wallClockSeconds: 1 } });
    expect(code).toBe(EXIT.delivered);
    expect(calls.at(-1)!.body).toMatchObject({ status: "failed", error: { code: "wall_clock" } });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("reports a missing harness binary", async () => {
    const { calls } = await run("/nonexistent/claude");
    expect(calls.at(-1)!.body).toMatchObject({ status: "failed", error: { code: "harness_unavailable" } });
  });
});
