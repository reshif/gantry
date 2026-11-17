/**
 * Instruction composition (spec 10.2). Four layers, in order: the factory base, the project overlay, the agent, and the repo guidelines Gantry keeps for the
 * repository (`repos.guidelines`, a person-owned text, NOT the repository's own AGENTS.md; that file arrives separately as the run's "Repository context", see
 * areas/internal/spec.ts) with the commit they were read at recorded next to them. The skills attached to the agent version follow, in order. The composition is pinned when a run is dispatched: the layer versions, the
 * skill versions and the hash go on the attempt's version tuple and on the run, so the run spec, the preview and the audit trail all describe the same text.
 */
import type { Queryable } from "@gantry/db";
import { cfgOf, sha256 } from "./config.js";
import { buildManifest, part, runnerParts, type ManifestPart, type PromptManifest } from "./manifest.js";

export interface Layer {
  key: "base" | "project" | "agent" | "repo";
  name: string;
  /** Published version of the layer; null for the agent layer (the agent version carries it) and for text with no version. */
  version: number | null;
  text: string;
  hash: string;
  /** The commit the repo guidelines were recorded against. */
  commit?: string | null;
}

export interface SkillOut {
  id: string;
  name: string;
  version: number;
  label: string;
  when: string;
  content: string;
  resources: string[];
  /** Hash and size of the skill's body (computed even when `content` is left out), so the prompt manifest can name it. */
  hash: string;
  bytes: number;
}

/** What a run was dispatched with. Stored on `runs.data.instructionPin`. */
export interface InstructionPin {
  base: number | null;
  project: number | null;
  agentVersion: number | null;
  /** The repo guidelines as read for this run, so a later edit does not change what the run was told. */
  guidelines: { text: string; hash: string; commit: string | null } | null;
}

export interface Composed {
  text: string;
  hash: string;
  layers: Layer[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const bodyText = (b: unknown): string => (typeof b === "string" ? b : typeof obj(b).body === "string" ? (obj(b).body as string) : "");

async function published(db: Queryable, orgId: string, scope: "base" | "project", scopeId: string, version: number | null): Promise<{ version: number; body: string } | null> {
  const { rows } = await db.query<{ version: number; body: string }>(
    `select version, body from instruction_versions where org_id = $1 and scope = $2 and scope_id = $3 and published_at is not null ${version === null ? "" : "and version = $4"} order by version desc limit 1`,
    version === null ? [orgId, scope, scopeId] : [orgId, scope, scopeId, version],
  );
  return rows[0] ?? null;
}

const money = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The agent layer: its instructions, what its per-project override changes, and its guardrails (legacy effectiveText). */
export function agentLayerText(cfg: { instructions: string; guardrails: { paths: string[]; maxDiff: number }; overrides: Record<string, { model?: string; autonomy?: string; budget?: number }> }, project: { id: string; name: string } | null): string {
  const parts = [cfg.instructions.trim()];
  const ov = project ? cfg.overrides[project.id] : undefined;
  if (ov && project && (ov.model || ov.autonomy || ov.budget)) {
    parts.push(`On ${project.name}:${ov.model ? ` model ${ov.model}.` : ""}${ov.autonomy ? ` autonomy ${ov.autonomy}.` : ""}${ov.budget ? ` budget $${money(ov.budget)} per work order.` : ""}`);
  }
  if (cfg.guardrails.paths.length) parts.push(`Never modify: ${cfg.guardrails.paths.join(", ")}.${cfg.guardrails.maxDiff ? ` Keep diffs under ${cfg.guardrails.maxDiff} lines.` : ""}`);
  return parts.filter((p) => p !== "").join("\n\n");
}

export const LAYER_NAMES: Record<Layer["key"], string> = { base: "Factory base", project: "Project overlay", agent: "Agent", repo: "Repo guidelines (Gantry)" };

export function assemble(layers: Layer[]): Composed {
  const used = layers.filter((l) => l.text.trim() !== "");
  return {
    text: used.map((l) => `## ${l.name}\n\n${l.text.trim()}`).join("\n\n"),
    hash: sha256(used.map((l) => `${l.name}\0${l.text}`).join("\0\0")),
    layers: used,
  };
}

export interface ComposeInput {
  orgId: string;
  agentId: string | null;
  /** The agent version whose text is the agent layer; the floor version when absent. */
  agentVersion?: number | null;
  projectId: string | null;
  repoId: string | null;
  pin?: InstructionPin | null;
  /** Used when the agent has no stored configuration (a run whose agent was removed). */
  fallbackAgentText?: string;
  fallbackOverlay?: string;
}

export interface AgentBody {
  version: number;
  label: string;
  body: Record<string, unknown>;
  name: string;
  data: Record<string, unknown>;
}

export async function loadAgentVersion(db: Queryable, orgId: string, agentId: string, version?: number | null): Promise<AgentBody | null> {
  const { rows } = await db.query<{ name: string; data: Record<string, unknown>; live_version: number | null; v: number | null; body: Record<string, unknown> | null }>(
    `select a.name, a.data, a.live_version, v.version as v, v.body from agents a
       left join agent_versions v on v.org_id = a.org_id and v.agent_id = a.id and v.version = coalesce($3::int, a.live_version)
      where a.org_id = $1 and a.id = $2`,
    [orgId, agentId, version ?? null],
  );
  const r = rows[0];
  if (!r || r.v === null || !r.body) return null;
  const label = typeof r.body.label === "string" && r.body.label ? r.body.label : `${r.v}.0.0`;
  return { version: r.v, label, body: r.body, name: r.name, data: r.data ?? {} };
}

/** The effective configuration of an agent version: its snapshot over the agent's stored defaults. */
export function versionCfg(av: AgentBody): ReturnType<typeof cfgOf> {
  return cfgOf({ ...av.data, ...av.body });
}

export async function projectInfo(db: Queryable, orgId: string, projectId: string | null): Promise<{ id: string; name: string; overlay: string } | null> {
  if (!projectId) return null;
  return (await db.query<{ id: string; name: string; overlay: string }>(`select id, name, overlay from projects where org_id = $1 and id = $2`, [orgId, projectId])).rows[0] ?? null;
}

/** The commit a repository's guidelines were last read at (recorded by onboarding and reconciliation). */
export async function repoCommit(db: Queryable, orgId: string, repoId: string): Promise<string | null> {
  const r = (await db.query<{ cfg: string | null; repo: string | null }>(`select (select data->>'baseSha' from repo_config where org_id = $1 and repo_id = $2) as cfg, (select data->>'baseSha' from repos where org_id = $1 and id = $2) as repo`, [orgId, repoId])).rows[0];
  const v = r?.cfg ?? r?.repo ?? null;
  return v && /^[0-9a-f]{40}$/.test(v) ? v : null;
}

/** The four layers. A pinned layer version is used as pinned; without a pin the latest published version is read. */
export async function composeLayers(db: Queryable, i: ComposeInput, av: AgentBody | null): Promise<{ layers: Layer[]; pin: InstructionPin }> {
  const baseRow = await published(db, i.orgId, "base", "", i.pin?.base ?? null);
  const proj = await projectInfo(db, i.orgId, i.projectId);
  const projRow = i.projectId ? await published(db, i.orgId, "project", i.projectId, i.pin?.project ?? null) : null;
  const overlay = projRow?.body ?? proj?.overlay ?? i.fallbackOverlay ?? "";
  const agentText = av ? agentLayerText(versionCfg(av), proj) : i.fallbackAgentText ?? "";
  let guidelines: InstructionPin["guidelines"] = i.pin?.guidelines ?? null;
  if (!guidelines && i.repoId) {
    const text = (await db.query<{ guidelines: string }>(`select guidelines from repos where org_id = $1 and id = $2`, [i.orgId, i.repoId])).rows[0]?.guidelines ?? "";
    guidelines = { text, hash: sha256(text), commit: await repoCommit(db, i.orgId, i.repoId) };
  }
  const layer = (key: Layer["key"], version: number | null, text: string, commit?: string | null): Layer => ({ key, name: LAYER_NAMES[key], version, text, hash: sha256(text), ...(commit !== undefined ? { commit } : {}) });
  return {
    layers: [layer("base", baseRow?.version ?? null, baseRow?.body ?? ""), layer("project", projRow?.version ?? null, overlay), layer("agent", av?.version ?? null, agentText), layer("repo", null, guidelines?.text ?? "", guidelines?.commit ?? null)],
    pin: { base: baseRow?.version ?? null, project: projRow?.version ?? null, agentVersion: av?.version ?? null, guidelines },
  };
}

/** The skills bundle in order: those attached to the agent version (its snapshot, or the current attachments for a version without one) and enabled on the project. */
export async function resolveSkills(db: Queryable, o: { orgId: string; agentId: string; body: Record<string, unknown>; projectId: string | null; versions?: Record<string, unknown>; withContent?: boolean }): Promise<SkillOut[]> {
  const attached = (await db.query<{ skill_id: string; pinned_version: number | null }>(`select skill_id, pinned_version from agent_skills where org_id = $1 and agent_id = $2 order by position, created_at, skill_id`, [o.orgId, o.agentId])).rows;
  const pins = new Map(attached.map((r) => [r.skill_id, r.pinned_version]));
  const ids = Array.isArray(o.body.skills) ? (o.body.skills as unknown[]).filter((x): x is string => typeof x === "string") : attached.map((r) => r.skill_id);
  const snapVersions = obj(o.body.skillVersions);
  const out: SkillOut[] = [];
  for (const id of ids) {
    const s = (await db.query<{ name: string; projects: unknown; live_version: number | null; data: Record<string, unknown> }>(`select name, projects, live_version, data from skills where org_id = $1 and id = $2`, [o.orgId, id])).rows[0];
    if (!s) continue;
    if (Array.isArray(s.projects) && (!o.projectId || !s.projects.includes(o.projectId))) continue;
    // The version the agent version was snapshotted with wins; a snapshot from before skills were pinned falls back to the attachment's pin, then the skill's latest.
    const tv = o.versions?.[id] ?? snapVersions[id];
    const version = typeof tv === "number" ? tv : pins.get(id) ?? s.live_version;
    if (version === null || version === undefined) continue;
    const v = (await db.query<{ body: unknown }>(`select body from skill_versions where org_id = $1 and skill_id = $2 and version = $3`, [o.orgId, id, version])).rows[0];
    if (!v) continue;
    const b = obj(v.body);
    out.push({
      id, name: s.name, version, label: typeof b.label === "string" ? b.label : `${version}`, when: typeof b.when === "string" ? b.when : typeof s.data.when === "string" ? s.data.when : "",
      content: o.withContent === false ? "" : bodyText(v.body), hash: sha256(bodyText(v.body)), bytes: Buffer.byteLength(bodyText(v.body)), resources: Array.isArray(b.resources) ? (b.resources as unknown[]).filter((x): x is string => typeof x === "string") : [],
    });
  }
  return out;
}

const LAYER_SOURCE: Record<Layer["key"], string> = {
  base: "instruction_versions (scope base)",
  project: "instruction_versions (scope project) or projects.overlay",
  agent: "agent_versions.body.instructions, overrides and guardrails",
  repo: "repos.guidelines (a person's text; the commit is where it was last read)",
};

/** The manifest parts of a composed system prompt in the order the model sees them: the used layers, the skills, then what the runner appends. */
export function instructionParts(layers: Layer[], skills: SkillOut[], repoContext = ""): ManifestPart[] {
  return [
    ...layers.map((l): ManifestPart => ({ kind: "layer", name: l.name, source: LAYER_SOURCE[l.key], version: l.version, sha256: l.hash, bytes: Buffer.byteLength(l.text) })),
    ...(repoContext ? [part("repo_context", "Repository context", "the repository's convention files at the pinned commit (runs.data.repoContext)", null, repoContext)] : []),
    ...skills.map((k): ManifestPart => ({ kind: "skill", name: k.name, source: `skill_versions ${k.id}`, version: k.version, sha256: k.hash, bytes: k.bytes })),
  ];
}

/** The parts of a station run's system prompt: the instruction parts, then what the runner appends. */
export function composedParts(layers: Layer[], skills: SkillOut[], repoContext = ""): ManifestPart[] {
  return [...instructionParts(layers, skills, repoContext), ...runnerParts()];
}

/** The version each skill is pinned at in a new agent version: the attachment's own pin, else the skill's latest. Skills with no published version are left out. */
export async function pinSkills(db: Queryable, orgId: string, agentId: string | null, ids: string[]): Promise<Record<string, number>> {
  const attached = agentId ? (await db.query<{ skill_id: string; pinned_version: number | null }>(`select skill_id, pinned_version from agent_skills where org_id = $1 and agent_id = $2`, [orgId, agentId])).rows : [];
  const pins = new Map(attached.map((r) => [r.skill_id, r.pinned_version]));
  const latest = new Map((await db.query<{ id: string; live_version: number | null }>(`select id, live_version from skills where org_id = $1 and id = any($2)`, [orgId, ids])).rows.map((r) => [r.id, r.live_version]));
  const out: Record<string, number> = {};
  for (const id of ids) {
    const v = pins.get(id) ?? latest.get(id) ?? null;
    if (v !== null) out[id] = v;
  }
  return out;
}

export interface RunPin {
  /** What the run is given, part by part; `manifest.hash` is the version tuple's instruction hash. */
  manifest: PromptManifest;
  /** The model this project's override pins for the agent, if any (overrides are part of the version). */
  modelOverride: string | null;
  composed: Composed;
  pin: InstructionPin;
  skillVersions: Record<string, number>;
  skills: SkillOut[];
}

/**
 * Called when a run is dispatched (spec 10.2): composes the instructions for this agent version, project and repository, and returns what to record.
 * `composed.hash` is the instruction hash of the version tuple, so it identifies the whole composition, not the agent text alone.
 */
export async function pinRunConfig(db: Queryable, o: { orgId: string; agentId: string; agentVersion: number; projectId: string; repoId: string | null; commit?: string | null }): Promise<RunPin | null> {
  const av = await loadAgentVersion(db, o.orgId, o.agentId, o.agentVersion);
  if (!av) return null;
  const { layers, pin } = await composeLayers(db, { orgId: o.orgId, agentId: o.agentId, agentVersion: o.agentVersion, projectId: o.projectId, repoId: o.repoId }, av);
  if (pin.guidelines && o.commit) pin.guidelines = { ...pin.guidelines, commit: o.commit };
  const withCommit = layers.map((l) => (l.key === "repo" && o.commit ? { ...l, commit: o.commit } : l));
  const skills = await resolveSkills(db, { orgId: o.orgId, agentId: o.agentId, body: av.body, projectId: o.projectId, withContent: false });
  const composed = assemble(withCommit);
  return { manifest: buildManifest("run", composedParts(composed.layers, skills)), modelOverride: versionCfg(av).overrides[o.projectId]?.model ?? null, composed, pin, skillVersions: Object.fromEntries(skills.map((s) => [s.id, s.version])), skills };
}
