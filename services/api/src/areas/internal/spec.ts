import type { Queryable } from "@gantry/db";
import { agentConfig } from "./metering.js";
import { dialogueHandoff, latestDocuments } from "../workorders/documents.js";
import type { RunCtx } from "./context.js";
import { scopeVerdict, type ScopeRow } from "../mcp/scope.js";
import { assemble, composeLayers, loadAgentVersion, resolveSkills, type InstructionPin } from "../agents/compose.js";

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

export interface ComposedInstructions {
  text: string;
  hash: string;
  layers: { name: string; hash: string; version?: number | null }[];
}

/**
 * Spec 10.2: factory base, project overlay, agent, repository guidelines (at the pinned commit). Layers with no content are left out.
 * The run's own pin (written when it was dispatched) decides the layer versions and the guidelines text; a run with no pin reads the latest published ones.
 */
export async function composeInstructions(db: Queryable, c: RunCtx): Promise<ComposedInstructions> {
  const agent = await agentConfig(db, c);
  const av = c.agentId ? await loadAgentVersion(db, c.orgId, c.agentId, c.agentVersion) : null;
  const pin = c.runData.instructionPin && typeof c.runData.instructionPin === "object" ? (c.runData.instructionPin as InstructionPin) : null;
  const { layers } = await composeLayers(db, { orgId: c.orgId, agentId: c.agentId, projectId: c.projectId, repoId: c.repoId, pin, fallbackAgentText: agent.instructions, fallbackOverlay: c.overlay }, av);
  const out = assemble(layers);
  return { text: out.text, hash: out.hash, layers: out.layers.map((l) => ({ name: l.name, hash: l.hash, version: l.version })) };
}

async function skillsFor(db: Queryable, c: RunCtx): Promise<{ name: string; content: string }[]> {
  if (!c.agentId) return [];
  const av = await loadAgentVersion(db, c.orgId, c.agentId, c.agentVersion);
  const skills = await resolveSkills(db, { orgId: c.orgId, agentId: c.agentId, body: av?.body ?? {}, projectId: c.projectId, versions: c.skillVersions });
  return skills.map((s) => ({ name: s.name, content: s.content }));
}

/** Enabled MCP servers whose scope covers this run: project (and the project's own enable list), repo, agent, station and work class (spec 12.4). */
export async function mcpServersInScope(db: Queryable, c: RunCtx): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<ScopeRow & { server_id: string; name: string }>(
    `select s.id as server_id, s.name, sc.projects, sc.repos, sc.agents, sc.stations, sc.classes from mcp_servers s join mcp_scopes sc on sc.org_id = s.org_id and sc.server_id = s.id
      where s.org_id = $1 and s.enabled order by s.id`,
    [c.orgId],
  );
  const enabled = Array.isArray(c.projectConfig.mcp) ? (c.projectConfig.mcp as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const seen = new Map<string, string>();
  for (const r of rows) {
    const v = scopeVerdict(r, { project: c.projectId, projectEnabled: enabled, serverId: r.server_id, repo: c.repoId, agent: c.agentId, station: c.station, cls: c.woClass }, { server: r.name });
    if (!v) seen.set(r.server_id, r.name);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/** The name a harness knows a server by. Tool names are `mcp__<name>__<tool>` and may hold only letters, digits, `_` and `-`, so a registry name like "Docs wiki" becomes `docs-wiki`; a clash falls back to the id. */
export function mcpKey(s: { id: string; name: string }, all: Array<{ id: string; name: string }>): string {
  const key = s.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || s.id;
  return all.some((o) => o.id !== s.id && o.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) === key) ? s.id : key;
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
  // An onboarding agent step (a hidden carrier) reads the seeded repository and answers: read-only tools, no MCP servers, whatever the agent version's own settings say.
  const carrier = typeof c.woData.onboarding === "object" && c.woData.onboarding !== null;
  const mcp = carrier ? [] : await mcpServersInScope(db, c);
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
    mcpServers: Object.fromEntries(mcp.map((s) => [mcpKey(s, mcp), { type: "http" as const, url: `${edgeUrl.replace(/\/+$/, "")}/mcp/v1/${encodeURIComponent(s.id)}` }])),
    toolAllowList: carrier ? READ_TOOLS : toolAllowList(agent.body, agent.data),
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
  // Phase 1: the documents the earlier stations (and earlier runs of this one) wrote, and what was asked, answered and assumed, so the
  // agent starts from what was settled and does not ask again.
  const documents = await latestDocuments(db, c.orgId, c.woId, { exceptAttempt: c.attemptId });
  const dialogue = await dialogueHandoff(db, c.orgId, c.woId);
  return { workOrder: { id: c.woId, title, class: c.woClass }, brief: brief ?? null, previous: prior, documents, dialogue };
}
