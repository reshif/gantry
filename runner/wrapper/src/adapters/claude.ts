/**
 * Claude Code headless adapter (spec 10.1 first adapter).
 *
 * UNVERIFIED against a real model: no vendor key was available when this was written. The argument list follows the
 * documented headless options of the pinned CLI version, but the flags, the stream-json event shapes and the
 * repo-config isolation below must be confirmed by the spec 16.2 spikes. The process handling, stream parsing, limits and
 * edge reporting are exercised in tests against a stand-in executable that emits stream-json lines.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Adapter, AdapterContext, AdapterOutcome } from "../adapter.js";
import type { UsageEntry } from "../edge.js";
import type { RunEnv } from "../env.js";
import type { RunSpec } from "../spec.js";

/** Writable scratch space: the root filesystem is read-only, /tmp is a tmpfs. */
export const SCRATCH = process.env.GANTRY_SCRATCH ?? "/tmp/gantry";

const MAX_ARG_BYTES = 100_000;

export interface ClaudeInvocation {
  args: string[];
  env: Record<string, string>;
  /** Written to `mcpConfigPath` (mode 0600) before launch: it carries the run token for the edge's MCP gateway. */
  mcpConfig: { mcpServers: Record<string, unknown> };
  mcpConfigPath: string;
  stdin: string;
}

const RESULT_INSTRUCTION =
  "When the work is finished, end your final message with exactly one fenced ```json block holding the station result as a single JSON object. Do not put anything after it.";

export function composeSystemPrompt(spec: RunSpec): string {
  const parts = [spec.instructions.trim()];
  for (const s of spec.skills) parts.push(`## Skill: ${s.name}\n\n${s.content.trim()}`);
  parts.push(RESULT_INSTRUCTION);
  return parts.filter((p) => p !== "").join("\n\n");
}

/**
 * Builds the harness command line. Isolation of repository-controlled configuration (spec 4.2, test T9):
 *  - `--setting-sources user` with an empty CLAUDE_CONFIG_DIR: project and local settings (hooks, permissions, env) never load;
 *  - `--strict-mcp-config` with an explicit `--mcp-config`: `.mcp.json` in the repo is ignored; only edge-gateway servers are used;
 *  - CLAUDE_CODE_DISABLE_CLAUDE_MDS: the repository guidelines arrive through the composed instructions at the pinned commit;
 *  - `--disable-slash-commands`: repo-defined commands and skills are not discovered.
 */
export function buildClaudeInvocation(spec: RunSpec, env: RunEnv, baseEnv: NodeJS.ProcessEnv = process.env): ClaudeInvocation {
  const edgeHost = new URL(env.edgeUrl).hostname;
  const mcpServers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(spec.mcpServers)) {
    mcpServers[name] = { ...s, headers: { authorization: `Bearer ${env.runToken}` } };
  }
  const mcpConfigPath = join(SCRATCH, "mcp.json");
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "user",
    "--strict-mcp-config",
    "--mcp-config", mcpConfigPath,
    "--disable-slash-commands",
    "--max-turns", String(spec.limits.turns),
    "--append-system-prompt", composeSystemPrompt(spec),
  ];
  if (spec.model) args.push("--model", spec.model);
  if (spec.toolAllowList.length > 0) args.push("--allowedTools", spec.toolAllowList.join(","));

  const cloneEnv: Record<string, string> = {};
  for (const k of ["PATH", "LANG", "LC_ALL", "TZ"]) {
    const v = baseEnv[k];
    if (v !== undefined) cloneEnv[k] = v;
  }
  Object.assign(cloneEnv, {
    HOME: join(SCRATCH, "home"),
    CLAUDE_CONFIG_DIR: join(SCRATCH, "claude-config"),
    // The harness talks to the edge's model gateway with the run token; the vendor key never enters the runner.
    ANTHROPIC_BASE_URL: `${env.edgeUrl}/model`,
    ANTHROPIC_AUTH_TOKEN: env.runToken,
    // Package and other HTTPS goes through the edge proxy; the gateway itself is reached directly.
    HTTPS_PROXY: baseEnv.HTTPS_PROXY ?? "",
    NO_PROXY: edgeHost,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  });
  if (cloneEnv.HTTPS_PROXY === "") delete cloneEnv.HTTPS_PROXY;

  const input = spec.input === undefined ? "" : typeof spec.input === "string" ? spec.input : JSON.stringify(spec.input, null, 2);
  const stdin = `Station: ${spec.station}\n\n${input}`.trimEnd() + "\n";
  return { args, env: cloneEnv, mcpConfig: { mcpServers }, mcpConfigPath, stdin };
}

// ---- stream-json parsing -----------------------------------------------------------------------------------

const ModelUsage = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  costUSD: z.number().optional(),
});
const Event = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
  modelUsage: z.record(z.string(), ModelUsage).optional(),
});
export type StreamEvent = z.infer<typeof Event>;

export function parseStreamLine(line: string): StreamEvent | undefined {
  const t = line.trim();
  if (t === "") return undefined;
  let json: unknown;
  try {
    json = JSON.parse(t);
  } catch {
    return undefined;
  }
  const p = Event.safeParse(json);
  return p.success ? p.data : undefined;
}

/** The last fenced ```json block that parses to a JSON object; failing that, the whole text if it is a JSON object. */
export function extractStructuredOutput(text: string): Record<string, unknown> | undefined {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n?```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const v: unknown = JSON.parse(blocks[i]?.[1] ?? "");
      if (isObj(v)) return v;
    } catch {
      /* try the previous block */
    }
  }
  try {
    const v: unknown = JSON.parse(text.trim());
    if (isObj(v)) return v;
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function usageFromResult(ev: StreamEvent, fallbackModel: string): UsageEntry[] {
  if (ev.modelUsage && Object.keys(ev.modelUsage).length > 0) {
    return Object.entries(ev.modelUsage).map(([model, u]) => {
      const e: UsageEntry = { model, inputTokens: u.inputTokens, outputTokens: u.outputTokens };
      if (u.cacheReadInputTokens !== undefined) e.cacheReadTokens = u.cacheReadInputTokens;
      if (u.cacheCreationInputTokens !== undefined) e.cacheWriteTokens = u.cacheCreationInputTokens;
      if (u.costUSD !== undefined) e.costUsd = u.costUSD;
      return e;
    });
  }
  if (ev.usage) {
    const e: UsageEntry = { model: fallbackModel, inputTokens: ev.usage.input_tokens, outputTokens: ev.usage.output_tokens };
    if (ev.usage.cache_read_input_tokens !== undefined) e.cacheReadTokens = ev.usage.cache_read_input_tokens;
    if (ev.usage.cache_creation_input_tokens !== undefined) e.cacheWriteTokens = ev.usage.cache_creation_input_tokens;
    if (ev.total_cost_usd !== undefined) e.costUsd = ev.total_cost_usd;
    return [e];
  }
  return [];
}

// ---- the adapter -------------------------------------------------------------------------------------------

export interface ClaudeAdapterOptions {
  bin?: string;
  /** Grace between SIGTERM and SIGKILL when interrupting the harness. */
  killGraceMs?: number;
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions = {}): Adapter {
  const bin = opts.bin ?? "claude";
  const killGraceMs = opts.killGraceMs ?? 5_000;
  return {
    name: "claude",
    capabilities: { cancel: true, resume: false, mcp: true, usageDetail: true },
    async run(ctx: AdapterContext): Promise<AdapterOutcome> {
      const { spec, env } = ctx;
      if (!spec.model) return { status: "failed", usage: [], error: { code: "spec_invalid", msg: "claude adapter requires spec.model" } };
      const inv = buildClaudeInvocation(spec, env);
      if (inv.args.some((a) => Buffer.byteLength(a) > MAX_ARG_BYTES)) {
        return { status: "failed", usage: [], error: { code: "instructions_too_large", msg: "composed instructions exceed the command-line limit" } };
      }
      await mkdir(join(SCRATCH, "home"), { recursive: true, mode: 0o700 });
      await mkdir(join(SCRATCH, "claude-config"), { recursive: true, mode: 0o700 });
      await writeFile(inv.mcpConfigPath, JSON.stringify(inv.mcpConfig), { mode: 0o600 });

      const child = spawn(bin, inv.args, { cwd: env.workspace, env: inv.env, stdio: ["pipe", "pipe", "pipe"] });
      let spawnError: Error | undefined;
      child.on("error", (e) => (spawnError = e));
      child.stdin.on("error", () => undefined);
      child.stdin.end(inv.stdin);

      let stderrTail = "";
      child.stderr.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + d.toString("utf8")).slice(-4000);
      });

      let turn = 0;
      let pending: string[] = [];
      let finalEvent: StreamEvent | undefined;
      const flush = async () => {
        if (pending.length === 0) return;
        const content = pending.join("\n") + "\n";
        pending = [];
        await ctx.checkpoint({ turn, kind: "transcript", name: `transcript-turn-${String(turn).padStart(4, "0")}.jsonl`, contentType: "application/x-ndjson", content });
      };

      const aborted = () => {
        child.kill("SIGTERM");
        const t = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        t.unref();
        child.once("close", () => clearTimeout(t));
      };
      if (ctx.signal.aborted) aborted();
      else ctx.signal.addEventListener("abort", aborted, { once: true });

      // Consume stdout line by line; checkpoint at turn boundaries (an assistant message followed by its tool results, or the end).
      let buf = "";
      let chain: Promise<void> = Promise.resolve();
      const handleLine = async (line: string) => {
        const ev = parseStreamLine(line);
        if (!ev) return;
        pending.push(line.trim());
        if (ev.type === "assistant") {
          turn += 1;
          ctx.setTurn(turn);
        } else if (ev.type === "user") {
          await flush();
        } else if (ev.type === "result") {
          finalEvent = ev;
          await flush();
        }
      };
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          chain = chain.then(() => handleLine(line));
        }
      });

      const code = await new Promise<number | null>((resolve) => child.once("close", (c) => resolve(c)));
      if (buf.trim() !== "") chain = chain.then(() => handleLine(buf));
      await chain;
      await flush();
      ctx.signal.removeEventListener("abort", aborted);

      if (ctx.signal.aborted) return { status: "interrupted", usage: finalEvent ? usageFromResult(finalEvent, spec.model) : [] };
      if (spawnError) return { status: "failed", usage: [], error: { code: "harness_unavailable", msg: `cannot start ${bin}: ${spawnError.message}` } };
      if (!finalEvent) return { status: "failed", usage: [], error: { code: "harness_exit", msg: `harness exited with code ${code} and no result${stderrTail ? `: ${stderrTail.trim()}` : ""}` } };

      const usage = usageFromResult(finalEvent, spec.model);
      if (finalEvent.subtype === "error_max_turns") return { status: "failed", usage, error: { code: "max_turns", msg: `turn limit ${spec.limits.turns} reached` } };
      if (finalEvent.is_error === true || (finalEvent.subtype !== undefined && finalEvent.subtype !== "success")) {
        return { status: "failed", usage, error: { code: "harness_error", msg: finalEvent.result ?? finalEvent.subtype ?? "harness reported an error" } };
      }
      const output = extractStructuredOutput(finalEvent.result ?? "");
      if (!output) return { status: "failed", usage, error: { code: "no_structured_output", msg: "final message has no JSON object result" } };
      return { status: "succeeded", output, usage };
    },
  };
}
