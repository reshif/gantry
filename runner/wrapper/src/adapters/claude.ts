/**
 * Claude Code headless adapter (spec 10.1 first adapter).
 *
 * UNVERIFIED against a real model: no vendor key was available when this was written. The argument list follows the
 * documented headless options of the pinned CLI version, but the flags, the stream-json event shapes and the
 * repo-config isolation below must be confirmed by the spec 16.2 spikes. The process handling, stream parsing, limits and
 * edge reporting are exercised in tests against a stand-in executable that emits stream-json lines.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { STATION_DIR, STATION_TOOLS_INSTRUCTION, TOOL_DEFS } from "../station-tools.js";
import type { Adapter, AdapterContext, AdapterOutcome } from "../adapter.js";
import type { UsageEntry } from "../edge.js";
import type { RunEnv } from "../env.js";
import type { RunSpec } from "../spec.js";
import { startRelay } from "../relay.js";
import { narrowShell } from "../tools.js";

/** Writable scratch space: the root filesystem is read-only, /tmp is a tmpfs. */
/** Package caches live on the run's workspace volume, not the 64M /tmp tmpfs. A dot-directory kept out of git (see excludeCacheFromGit). */
export const CACHE_DIRNAME = ".gantry-cache";

/**
 * Caches for uv, pip, npm and anything that honours XDG_CACHE_HOME, under `<workspace>/.gantry-cache`. They cannot be set by the agent
 * (that command form needs approval) and the /tmp tmpfs is too small for a toolchain download.
 */
export function cacheEnv(workspace: string): Record<string, string> {
  const root = join(workspace, CACHE_DIRNAME);
  return { UV_CACHE_DIR: join(root, "uv"), PIP_CACHE_DIR: join(root, "pip"), XDG_CACHE_HOME: join(root, "xdg"), npm_config_cache: join(root, "npm") };
}

/**
 * Keep the cache out of every commit: `.gantry-cache/` goes in the repository's .git/info/exclude (local, never committed), so `git add -A` and
 * `git commit -a` skip it. Idempotent. The publisher reads only committed objects, so an excluded file cannot reach a pull request.
 */
export async function excludeCacheFromGit(workspace: string): Promise<void> {
  const gitDir = join(workspace, ".git");
  try {
    if (!(await stat(gitDir)).isDirectory()) return;
  } catch {
    return; // not a git workspace
  }
  const file = join(gitDir, "info", "exclude");
  const line = `/${CACHE_DIRNAME}/`;
  let cur = "";
  try { cur = await readFile(file, "utf8"); } catch { /* absent */ }
  if (cur.split("\n").some((l) => l.trim() === line)) return;
  await mkdir(join(gitDir, "info"), { recursive: true });
  await writeFile(file, `${cur}${cur === "" || cur.endsWith("\n") ? "" : "\n"}${line}\n`);
}

export const SCRATCH = process.env.GANTRY_SCRATCH ?? "/tmp/gantry";

const MAX_ARG_BYTES = 100_000;
/** A scout run (Phase 3): its handoff names its own question. */
const isScout = (spec: RunSpec): boolean => !!spec.input && typeof spec.input === "object" && "scout" in (spec.input as object);
const STATION_TOOLS_JS = fileURLToPath(new URL("../station-tools.js", import.meta.url));
/** The harness names MCP tools `mcp__<server>__<tool>`. */
export const STATION_TOOL_NAMES = TOOL_DEFS.map((t) => `mcp__gantry__${t.name}`);

export interface ClaudeInvocation {
  args: string[];
  env: Record<string, string>;
  /** Written to `mcpConfigPath` (mode 0600) before launch: it names only relay URLs, no credential. */
  mcpConfig: { mcpServers: Record<string, unknown> };
  mcpConfigPath: string;
  stdin: string;
}

const RESULT_INSTRUCTION =
  "When the work is finished, end your final message with exactly one fenced ```json block holding the station result as a single JSON object. Do not put anything after it.";

/** The harness's built-in tools. Any that is not on the agent's allow-list is also named in `--disallowedTools`, a second rail. */
export const KNOWN_BUILTIN_TOOLS = [
  "Agent", "Bash", "Cron", "CronCreate", "CronDelete", "CronList", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "TodoWrite", "WebFetch", "WebSearch", "Workflow", "Write",
];

/**
 * Paths no file tool may touch, whatever the allow-list says (S-91): git runs programs named in `.git/config` (filter, textconv, aliases, sshCommand ...)
 * and in `.git/hooks`, so a "may write the branch" agent that could edit them could run commands. Listed as deny rules for every editing tool and
 * every spelling of the path (relative, nested, absolute). `.gitattributes` and `.gitmodules` are named too: they select the filters and drivers.
 * The git front (bin/git) is the second rail: it refuses to run when the config names such a program.
 */
export const GIT_PATH_DENIES: string[] = ["Edit", "Write", "NotebookEdit"].flatMap((t) => [`${t}(.git)`, `${t}(.git/**)`, `${t}(**/.git)`, `${t}(**/.git/**)`, `${t}(**/gitdir)`, `${t}(//workspace/.git)`, `${t}(//workspace/.git/**)`, `${t}(**/.gitattributes)`, `${t}(**/.gitmodules)`]);

/** Directory of the git front, first on the harness's PATH (runner/wrapper/bin, installed at /opt/gantry-wrapper/bin). */
export const GIT_FRONT_DIR = fileURLToPath(new URL("../../bin", import.meta.url));

const toolBase = (entry: string): string => entry.replace(/\(.*$/s, "").trim();

/** Built-in tool names an allow-list grants. An entry may carry a specifier, `Bash(npm test:*)`, which grants the tool and narrows approval; MCP entries are not built-ins. */
export function builtinTools(allow: string[]): string[] {
  return [...new Set(allow.map(toolBase).filter((t) => t !== "" && !t.startsWith("mcp__")))];
}

/** Whether a tool the model called is permitted: a listed built-in, or an MCP tool (gated by the edge gateway). */
export function toolAllowed(name: string, allow: string[]): boolean {
  return name.startsWith("mcp__") || builtinTools(allow).includes(name);
}

/** Names of the tools an assistant event asks to call. */
export function toolUses(ev: StreamEvent): string[] {
  const content = (ev as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((b: unknown) => {
    const x = b as { type?: unknown; name?: unknown };
    return typeof b === "object" && b !== null && x.type === "tool_use" && typeof x.name === "string" ? [x.name] : [];
  });
}

export function composeSystemPrompt(spec: RunSpec): string {
  const parts = [spec.instructions.trim()];
  for (const s of spec.skills) parts.push(`## Skill: ${s.name}\n\n${s.content.trim()}`);
  parts.push(STATION_TOOLS_INSTRUCTION);
  parts.push(RESULT_INSTRUCTION);
  return parts.filter((p) => p !== "").join("\n\n");
}

/**
 * Builds the harness command line. Isolation of repository-controlled configuration (spec 4.2, test T9):
 *  - `--setting-sources user` with an empty CLAUDE_CONFIG_DIR: project and local settings (hooks, permissions, env) never load;
 *  - `--strict-mcp-config` with an explicit `--mcp-config`: `.mcp.json` in the repo is ignored; only edge-gateway servers are used;
 *  - CLAUDE_CODE_DISABLE_CLAUDE_MDS stays on on purpose: the harness's own memory-file loader would read whatever CLAUDE.md sits in the workspace (and user/managed
 *    files), unrecorded, uncapped, unscanned and only for this harness. Gantry decides instead: the broker reads AGENTS.md / CLAUDE.md at the pinned commit when it
 *    seeds, scans and caps them, records what was offered on the run, and the run spec's instructions carry them under "Repository context" with a stated
 *    precedence (factory rails > project overlay > repository conventions > agent defaults). Deterministic, audited, identical for every harness;
 *  - `--disable-slash-commands`: repo-defined commands and skills are not discovered.
 */
export function buildClaudeInvocation(spec: RunSpec, env: RunEnv, relayUrl: string, baseEnv: NodeJS.ProcessEnv = process.env): ClaudeInvocation {
  const edgeOrigin = new URL(env.edgeUrl).origin;
  const mcpServers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(spec.mcpServers)) {
    // The edge's MCP gateway is reached through the relay, which adds the run token: the config file and the harness never hold it.
    mcpServers[name] = { ...s, url: s.url.startsWith(edgeOrigin) ? relayUrl + s.url.slice(edgeOrigin.length) : s.url };
  }
  // The station tools run in this container as a stdio server (they only record into the run's scratch space): see station-tools.ts.
  mcpServers.gantry = { type: "stdio", command: baseEnv.GANTRY_NODE_BIN ?? process.execPath, args: [STATION_TOOLS_JS], env: { GANTRY_STATION_DIR: STATION_DIR, GANTRY_EDGE_URL: relayUrl, GANTRY_RUN_ID: env.runId, ...(isScout(spec) ? { GANTRY_STATION_ROLE: "scout" } : {}) } };
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
  // `--allowedTools` only pre-approves; it removes nothing. `--tools` is the restriction: the built-in tools the model is offered at all, and
  // `--disallowedTools` names the rest as a second rail. MCP tools (station tools, registry servers in scope) are gated by the edge and stay.
  const granted = builtinTools(spec.toolAllowList);
  args.push("--tools", granted.join(","));
  args.push("--disallowedTools", [...KNOWN_BUILTIN_TOOLS.filter((t) => !granted.includes(t)), ...GIT_PATH_DENIES].join(","));
  args.push("--allowedTools", [...narrowShell(spec.toolAllowList), ...STATION_TOOL_NAMES].join(","));

  const cloneEnv: Record<string, string> = {};
  for (const k of ["PATH", "LANG", "LC_ALL", "TZ", "UV_PYTHON_INSTALL_DIR", "UV_PYTHON_PREFERENCE", "UV_PYTHON_DOWNLOADS", "UV_LINK_MODE", "UV_NO_PROGRESS"]) {
    const v = baseEnv[k];
    if (v !== undefined) cloneEnv[k] = v;
  }
  // The git front first: it refuses config-borne commands (see bin/git). The real git is whatever the image has.
  cloneEnv.PATH = [GIT_FRONT_DIR, cloneEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":");
  Object.assign(cloneEnv, {
    HOME: join(SCRATCH, "home"),
    GANTRY_WORKSPACE: env.workspace,
    ...cacheEnv(env.workspace),
    CLAUDE_CONFIG_DIR: join(SCRATCH, "claude-config"),
    // The harness talks to the edge's model gateway through the loopback relay, which adds the run token; the vendor key never enters the runner.
    // The placeholder only satisfies the harness's need for some credential. Nothing in this environment is a secret.
    ANTHROPIC_BASE_URL: `${relayUrl}/model`,
    ANTHROPIC_AUTH_TOKEN: "relay",
    // Package and other HTTPS goes through the same relay, which opens the tunnel to the edge proxy with the run's credentials.
    HTTPS_PROXY: relayUrl,
    NO_PROXY: "127.0.0.1,localhost",
    // The harness's inner sandbox (bubblewrap) cannot start in this container (no user namespaces, no capabilities), so it is off. What it protected
    // is gone instead: no token or credential is in this environment, so no tool subprocess can inherit one (see relay.ts).
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
    // The image sets the git identity and the hardening (hooks off, fsmonitor off, /workspace trusted) in its environment, but this clean environment
    // dropped them, and `git commit` refuses without an identity. Same values as runner/Dockerfile; no token is among them.
    GIT_AUTHOR_NAME: "Gantry Agent", GIT_AUTHOR_EMAIL: "agent@gantry.invalid", GIT_COMMITTER_NAME: "Gantry Agent", GIT_COMMITTER_EMAIL: "agent@gantry.invalid",
    // S-91: no system or global config, hooks and fsmonitor off, no external diff, no ssh command, no pager or editor. These are "command" scope
    // and beat anything in the repository's own config.
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_EDITOR: "true", GIT_PAGER: "cat",
    GIT_CONFIG_COUNT: "7",
    GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "safe.directory", GIT_CONFIG_VALUE_1: "/workspace",
    GIT_CONFIG_KEY_2: "core.fsmonitor", GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "diff.external", GIT_CONFIG_VALUE_3: "",
    GIT_CONFIG_KEY_4: "core.sshCommand", GIT_CONFIG_VALUE_4: "false",
    GIT_CONFIG_KEY_5: "core.pager", GIT_CONFIG_VALUE_5: "cat",
    GIT_CONFIG_KEY_6: "protocol.ext.allow", GIT_CONFIG_VALUE_6: "never",
    GIT_TERMINAL_PROMPT: "0",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  });

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
  // The result is the last JSON object the agent wrote, usually in a ```json fence. The object's own string values may contain Markdown
  // code fences (a design note with a ```python example), so a fence regex cannot find where it ends: it stopped at the first inner ``` and
  // cut the JSON in half (WO-1001 Design, 2026-11-14). Instead, start at each '{' after a ```json marker (latest first), then anywhere
  // (latest first), and take the balanced object that parses — string-aware, so braces and backticks inside strings do not count.
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const parseAt = (start: number): Record<string, unknown> | undefined => {
    const end = balancedEnd(text, start);
    if (end < 0) return undefined;
    try {
      const v: unknown = JSON.parse(text.slice(start, end + 1));
      return isObj(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const fenced = [...text.matchAll(/```json[^\S\n]*\n/gi)].map((m) => text.indexOf("{", (m.index ?? 0) + m[0].length)).filter((i) => i >= 0);
  for (let i = fenced.length - 1; i >= 0; i--) {
    const v = parseAt(fenced[i]!);
    if (v) return v;
  }
  // No usable fence: the last top-level object in the text (scan forward, skipping over each object that parses, so an inner object
  // never wins over the one that contains it).
  let last: Record<string, unknown> | undefined;
  for (let i = text.indexOf("{"); i >= 0; ) {
    const v = parseAt(i);
    if (v && Object.keys(v).length > 0) {
      last = v;
      i = text.indexOf("{", balancedEnd(text, i) + 1);
    } else i = text.indexOf("{", i + 1);
  }
  return last;
}

/** Index of the '}' closing the object that starts at `start` ('{'), skipping string contents and escapes; -1 when unbalanced. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
      const relay = await startRelay({ edgeUrl: env.edgeUrl, runToken: env.runToken, runId: env.runId, upstreamProxy: process.env.HTTPS_PROXY });
      const inv = buildClaudeInvocation(spec, env, relay.url);
      if (inv.args.some((a) => Buffer.byteLength(a) > MAX_ARG_BYTES)) {
        await relay.close();
        return { status: "failed", usage: [], error: { code: "instructions_too_large", msg: "composed instructions exceed the command-line limit" } };
      }
      await mkdir(join(SCRATCH, "home"), { recursive: true, mode: 0o700 });
      await mkdir(join(SCRATCH, "claude-config"), { recursive: true, mode: 0o700 });
      // Best effort: a workspace that cannot hold the cache leaves the tools to create it (or fail) themselves.
      await mkdir(join(env.workspace, CACHE_DIRNAME), { recursive: true, mode: 0o700 }).catch(() => undefined);
      await excludeCacheFromGit(env.workspace).catch(() => undefined);
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
      let violation: string | undefined;
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
          // A call outside the allow-list means the harness did not enforce it. Fail closed: the call stays in the transcript, the harness is stopped, the run reports it.
          const bad = toolUses(ev).find((n) => !toolAllowed(n, spec.toolAllowList));
          if (bad && !violation) {
            violation = bad;
            aborted();
          }
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
      await relay.close();
      if (buf.trim() !== "") chain = chain.then(() => handleLine(buf));
      await chain;
      await flush();
      ctx.signal.removeEventListener("abort", aborted);

      if (violation) {
        const msg = `The agent called ${violation}, which is not on its tool allow-list (${spec.toolAllowList.join(", ") || "none"}). The run was stopped.`;
        return { status: "failed", usage: finalEvent ? usageFromResult(finalEvent, spec.model) : [], error: { code: "tool_not_allowed", msg } };
      }
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
