import { createHash } from "node:crypto";
import type { Queryable } from "@gantry/db";
import { agentConfig } from "./metering.js";
import type { RunCtx } from "./context.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const HEARTBEAT_SECONDS = 15;
/** The lease a heartbeat grants: six missed heartbeats (spec 4.3 step 5). */
export const LEASE_SECONDS = HEARTBEAT_SECONDS * 6;

const READ_TOOLS = ["Read", "Glob", "Grep"];
const TOOL_NAMES: Record<string, string[]> = {
  readRepo: READ_TOOLS,
  writeBranch: ["Edit", "Write", "NotebookEdit"],
  runTests: ["Bash"],
};

/** The tool allow-list: an explicit list on the agent version wins, then the legacy tools flags, then read-only. */
export function toolAllowList(body: Record<string, unknown>, data: Record<string, unknown>): string[] {
  const explicit = body.toolAllowList ?? data.toolAllowList;
  if (Array.isArray(explicit)) return explicit.filter((t): t is string => typeof t === "string" && t.length > 0);
  const flags = (body.tools ?? data.tools) as Record<string, unknown> | undefined;
  if (flags && typeof flags === "object") {
    const out = new Set<string>();
    for (const [k, on] of Object.entries(flags)) if (on === true) for (const t of TOOL_NAMES[k] ?? []) out.add(t);
    return [...out];
  }
  return READ_TOOLS;
}

const bodyText = (b: unknown): string => (typeof b === "string" ? b : b && typeof b === "object" && typeof (b as { body?: unknown }).body === "string" ? (b as { body: string }).body : "");

/** The latest published instruction version for a scope. */
async function layer(db: Queryable, orgId: string, scope: "base" | "project" | "agent", scopeId: string): Promise<string | null> {
  const { rows } = await db.query<{ body: string }>(
    `select body from instruction_versions where org_id = $1 and scope = $2 and scope_id = $3 and published_at is not null order by version desc limit 1`,
    [orgId, scope, scopeId],
  );
  return rows[0]?.body ?? null;
}

export interface ComposedInstructions {
  text: string;
  hash: string;
  layers: { name: string; hash: string }[];
}

/** Spec 10.2: factory base, project overlay, agent, repository guidelines. Layers with no content are left out. */
export async function composeInstructions(db: Queryable, c: RunCtx): Promise<ComposedInstructions> {
  const agent = await agentConfig(db, c);
  const repo = c.repoId ? (await db.query<{ guidelines: string }>(`select guidelines from repos where org_id = $1 and id = $2`, [c.orgId, c.repoId])).rows[0]?.guidelines ?? "" : "";
  const parts: [string, string][] = [
    ["Factory base", (await layer(db, c.orgId, "base", "")) ?? ""],
    ["Project overlay", (await layer(db, c.orgId, "project", c.projectId)) ?? c.overlay],
    ["Agent", (c.agentId ? await layer(db, c.orgId, "agent", c.agentId) : null) ?? agent.instructions],
    ["Repository guidelines", repo],
  ];
  const used = parts.filter(([, t]) => t.trim() !== "");
  return {
    text: used.map(([n, t]) => `## ${n}\n\n${t.trim()}`).join("\n\n"),
    hash: sha(used.map(([n, t]) => `${n}\0${t}`).join("\0\0")),
    layers: used.map(([name, t]) => ({ name, hash: sha(t) })),
  };
}

async function skillsFor(db: Queryable, c: RunCtx): Promise<{ name: string; content: string }[]> {
  if (!c.agentId) return [];
  const { rows } = await db.query<{ skill_id: string; name: string; projects: unknown; live_version: number | null; pinned_version: number | null }>(
    `select s.id as skill_id, s.name, s.projects, s.live_version, k.pinned_version from agent_skills k join skills s on s.org_id = k.org_id and s.id = k.skill_id
      where k.org_id = $1 and k.agent_id = $2 order by k.created_at, s.id`,
    [c.orgId, c.agentId],
  );
  const out: { name: string; content: string }[] = [];
  for (const s of rows) {
    if (Array.isArray(s.projects) && !s.projects.includes(c.projectId)) continue;
    const tupleV = c.skillVersions[s.skill_id];
    const version = typeof tupleV === "number" ? tupleV : s.pinned_version ?? s.live_version;
    if (version === null || version === undefined) continue;
    const v = await db.query<{ body: unknown }>(`select body from skill_versions where org_id = $1 and skill_id = $2 and version = $3`, [c.orgId, s.skill_id, version]);
    if (v.rows[0]) out.push({ name: s.name, content: bodyText(v.rows[0].body) });
  }
  return out;
}

const inScope = (v: unknown, id: string | null): boolean => v === "all" || (Array.isArray(v) && id !== null && v.includes(id));

export interface McpScopeRow {
  server_id: string;
  projects: unknown;
  repos: unknown;
  agents: unknown;
  stations: unknown;
}

/** Enabled MCP servers whose scope covers this run. An empty list in a scope means nobody; "all" means everyone. */
export async function mcpServersInScope(db: Queryable, c: RunCtx): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<McpScopeRow & { name: string }>(
    `select s.id as server_id, s.name, sc.projects, sc.repos, sc.agents, sc.stations from mcp_servers s join mcp_scopes sc on sc.org_id = s.org_id and sc.server_id = s.id
      where s.org_id = $1 and s.enabled order by s.id`,
    [c.orgId],
  );
  const seen = new Map<string, string>();
  for (const r of rows) if (inScope(r.projects, c.projectId) && inScope(r.repos, c.repoId) && inScope(r.agents, c.agentId) && inScope(r.stations, c.station)) seen.set(r.server_id, r.name);
  return [...seen].map(([id, name]) => ({ id, name }));
}

export interface RunSpecOut {
  runId: string;
  adapter: "claude" | "stub";
  station: string;
  model?: string;
  instructions: string;
  instructionsHash: string;
  skills: { name: string; content: string }[];
  mcpServers: Record<string, { type: "http"; url: string }>;
  toolAllowList: string[];
  limits: { turns: number; costUsd?: number; wallClockSeconds: number };
  heartbeatSeconds: number;
  leaseSeconds: number;
  input?: unknown;
  stub?: unknown;
}

/** What the runner wrapper's `RunSpec` expects (runner/wrapper/src/spec.ts). Returns null when a claude run has no model. */
export async function composeRunSpec(db: Queryable, c: RunCtx, edgeUrl: string): Promise<RunSpecOut | { error: string }> {
  const agent = await agentConfig(db, c);
  const model = c.runModel ?? c.tupleModel ?? undefined;
  const adapter = c.runData.adapter === "stub" || c.runData.adapter === "claude" ? c.runData.adapter : model ? "claude" : "stub";
  if (adapter === "claude" && !model) return { error: "The claude adapter needs a pinned model." };
  const inst = await composeInstructions(db, c);
  const mcp = await mcpServersInScope(db, c);
  const lim = (agent.body.limits ?? agent.data.limits ?? {}) as { turns?: unknown; wallClockSeconds?: unknown };
  const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
  const costUsd = typeof agent.budgetUsd === "number" && agent.budgetUsd > 0 ? agent.budgetUsd : undefined;
  const input = c.runData.input ?? c.attemptData.input ?? (await handoff(db, c));
  return {
    runId: c.runId,
    adapter,
    station: c.station,
    ...(model ? { model } : {}),
    instructions: inst.text,
    instructionsHash: inst.hash,
    skills: await skillsFor(db, c),
    mcpServers: Object.fromEntries(mcp.map((s) => [s.name, { type: "http" as const, url: `${edgeUrl.replace(/\/+$/, "")}/mcp/v1/${encodeURIComponent(s.id)}` }])),
    toolAllowList: toolAllowList(agent.body, agent.data),
    limits: { turns: pos(lim.turns) ?? 40, ...(costUsd ? { costUsd } : {}), wallClockSeconds: pos(lim.wallClockSeconds) ?? 3600 },
    heartbeatSeconds: HEARTBEAT_SECONDS,
    leaseSeconds: LEASE_SECONDS,
    ...(input !== undefined ? { input } : {}),
    ...(c.runData.stub !== undefined ? { stub: c.runData.stub } : {}),
  };
}

/** Station handoff (spec 10.2): the latest confirmed brief and the previous stations' structured results, not a transcript. */
async function handoff(db: Queryable, c: RunCtx): Promise<unknown> {
  const brief = (await db.query(`select body from brief_versions where org_id = $1 and wo_id = $2 order by version desc limit 1`, [c.orgId, c.woId])).rows[0]?.body;
  const prior = (
    await db.query(
      `select station, outcome, summary, body from station_results where org_id = $1 and wo_id = $2 and attempt_id <> $3 order by created_at`,
      [c.orgId, c.woId, c.attemptId],
    )
  ).rows;
  const title = (await db.query(`select title from work_orders where org_id = $1 and id = $2`, [c.orgId, c.woId])).rows[0]?.title;
  return { workOrder: { id: c.woId, title, class: c.woClass }, brief: brief ?? null, previous: prior };
}
