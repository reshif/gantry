/**
 * Agent configuration (spec 8.7, 10.2). An agent has a working configuration (agents.data plus its ordered skills) that people edit, and immutable
 * versions: a version is a snapshot of that configuration. What runs is the version on the floor (agents.live_version), never the working copy.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "@gantry/db";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const TOOL_KEYS = ["readRepo", "writeBranch", "runTests", "openPR", "merge", "postSlack", "sendEmail", "readSecrets"] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];
export const AUTONOMY_LEVELS = ["suggest", "gate", "auto"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export interface Override {
  model?: string;
  autonomy?: AutonomyLevel;
  budget?: number;
}
export interface AgentCfg {
  model: string;
  fallbacks: string[];
  autonomy: AutonomyLevel;
  tools: Record<ToolKey, boolean>;
  mcp: string[];
  stations: string[];
  projects: "all" | string[];
  budget: number;
  guardrails: { paths: string[]; maxDiff: number };
  suite: string;
  instructions: string;
  overrides: Record<string, Override>;
}

/** The keys a version snapshots (with `skills`, held in agent_skills). Staffing (stations, projects), the suite and the name are operational, not versioned. */
export const VERSIONED_KEYS = ["model", "fallbacks", "autonomy", "tools", "skills", "mcp", "guardrails", "budget", "instructions", "overrides"] as const;
export type VersionedKey = (typeof VERSIONED_KEYS)[number];

export const DEFAULT_TOOLS: Record<ToolKey, boolean> = { readRepo: true, writeBranch: false, runTests: false, openPR: false, merge: false, postSlack: true, sendEmail: false, readSecrets: false };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The working configuration as stored, with defaults for anything a seed or an older row lacks. */
export function cfgOf(data: Record<string, unknown>, modelFallback = ""): AgentCfg {
  const g = obj(data.guardrails);
  const tools = { ...DEFAULT_TOOLS };
  for (const [k, v] of Object.entries(obj(data.tools))) if ((TOOL_KEYS as readonly string[]).includes(k) && typeof v === "boolean") tools[k as ToolKey] = v;
  return {
    model: typeof data.model === "string" ? data.model : modelFallback,
    fallbacks: strs(data.fallbacks),
    autonomy: (AUTONOMY_LEVELS as readonly unknown[]).includes(data.autonomy) ? (data.autonomy as AutonomyLevel) : "suggest",
    tools,
    mcp: strs(data.mcp),
    stations: strs(data.stations),
    projects: data.projects === "all" || data.projects === undefined ? "all" : strs(data.projects),
    budget: typeof data.budget === "number" && Number.isFinite(data.budget) ? data.budget : 0,
    guardrails: { paths: strs(g.paths), maxDiff: typeof g.maxDiff === "number" ? g.maxDiff : 0 },
    suite: typeof data.suite === "string" ? data.suite : "",
    instructions: typeof data.instructions === "string" ? data.instructions : "",
    overrides: Object.fromEntries(Object.entries(obj(data.overrides)).map(([k, v]) => [k, obj(v) as Override])),
  };
}

/** What a version stores: the versioned keys with the ordered skill ids. */
export function snapshotOf(c: AgentCfg, skills: string[]): Record<VersionedKey, unknown> {
  return { model: c.model, fallbacks: c.fallbacks, autonomy: c.autonomy, tools: c.tools, skills, mcp: c.mcp, guardrails: c.guardrails, budget: c.budget, instructions: c.instructions, overrides: c.overrides };
}

/** Which versioned keys differ between two snapshots (a version body may hold fewer keys, as a seeded one does). */
export function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return VERSIONED_KEYS.filter((k) => k in a && k in b && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export const initialsOf = (name: string): string => name.split(/\s+/).map((w) => (/[A-Za-z0-9]/.exec(w) ?? [""])[0]).join("").slice(0, 2).toUpperCase() || "AG";
export const slug = (s: string, n = 24): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n);

const EARLY = ["intake", "research", "spec", "design"];
export interface AutonomyVerdict {
  allowed: boolean;
  reason?: string;
  rule?: string;
}

/** POL-112 (legacy G.agentAutonomyCheck): no autonomous agents from Plan onward on regulated projects. Reads the policy and the projects it applies to. */
export async function autonomyCheck(db: Queryable, orgId: string, agent: { station: string | null; projects: "all" | string[] }, autonomy: string, projectId?: string): Promise<AutonomyVerdict> {
  if (autonomy !== "auto") return { allowed: true };
  const pol = (await db.query<{ enabled: boolean }>(`select enabled from policies where org_id = $1 and id = 'POL-112'`, [orgId])).rows[0];
  if (!pol?.enabled) return { allowed: true };
  if (agent.station === null || EARLY.includes(agent.station)) return { allowed: true };
  const scope = projectId ? [projectId] : agent.projects === "all" ? null : agent.projects;
  const { rows } = await db.query<{ name: string }>(
    `select name from projects where org_id = $1 and regulated and status <> 'archived' ${scope ? "and id = any($2)" : ""} order by name`,
    scope ? [orgId, scope] : [orgId],
  );
  if (!rows.length) return { allowed: true };
  return { allowed: false, rule: "POL-112", reason: `POL-112: no autonomous agents from Plan onward on regulated projects (${rows.map((r) => r.name).join(", ")}). Use act with gate or exclude those projects.` };
}
