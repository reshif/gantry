/**
 * The effective instructions preview (spec 8.7, 10.2): what a run of this agent would be sent as its system prompt for a project and repository. By default it is the version on
 * the floor, because that is what runs; `version=draft` previews the saved working copy. The text is the runner's own composition: the layers, then every skill in full at the
 * version the agent version pins, then the runner's station tools text and result instruction. The handoff (the first message) is filled per work order and is described.
 */
import type { Queryable } from "@gantry/db";
import { RepoContext, repoContextRecord } from "@gantry/domain";
import { notFound, invalid } from "../../core/errors.js";
import { assemble, composedParts, composeLayers, loadAgentVersion, pinSkills, projectInfo, resolveSkills, tupleInstructionHash, type AgentBody, type Layer } from "./compose.js";
import { buildManifest } from "./manifest.js";
import { HANDOFF_SHAPE, RESULT_TEXT, STATION_TOOLS_TEXT, systemPrompt } from "./runner-sections.js";
import { cfgOf, sha256, snapshotOf } from "./config.js";
import { attachedSkills, labelOf, versionRows } from "./store.js";

/**
 * What the repository's own convention files looked like the last time a run was seeded from it (the manifest on that run), without the file text. The latest run
 * counts even when its context could not be read (`unavailable`): the page must not show an older run's files as "last offered" (S-145).
 */
export type RepoContextSummary = (Omit<ReturnType<typeof repoContextRecord>, "commit"> & { commit: string | null; unavailable?: true; unavailableReason?: string; runId: string; offeredAt: string | null }) | null;

async function latestRepoContext(db: Queryable, orgId: string, repoId: string): Promise<RepoContextSummary> {
  const row = (await db.query<{ id: string; rc: unknown }>(
    `select r.id, r.data->'repoContext' as rc from runs r join work_orders w on w.org_id = r.org_id and w.id = r.wo_id
      where r.org_id = $1 and w.repo_id = $2 and (r.data->'repoContext'->>'commit' is not null or r.data->'repoContext'->>'unavailable' = 'true')
      order by coalesce(r.started_at, r.created_at) desc, r.created_at desc limit 1`,
    [orgId, repoId],
  )).rows[0];
  if (!row) return null;
  const raw = row.rc as { offeredAt?: unknown; unavailable?: unknown; unavailableReason?: unknown };
  const offeredAt = typeof raw.offeredAt === "string" ? raw.offeredAt : null;
  if (raw.unavailable === true) return { commit: null, files: [], hash: "unavailable", unavailable: true, ...(typeof raw.unavailableReason === "string" ? { unavailableReason: raw.unavailableReason } : {}), runId: row.id, offeredAt };
  const p = RepoContext.safeParse(row.rc);
  if (!p.success) return null;
  return { ...repoContextRecord(p.data), runId: row.id, offeredAt };
}

export interface Effective {
  agent: string;
  /** The version the text is composed from: a label, or "draft" for the saved working configuration. */
  version: string;
  live: boolean;
  project: { id: string; name: string } | null;
  repo: { id: string; name: string } | null;
  /** The whole system prompt a run is sent, in order. */
  text: string;
  /** Hash of the composed layers (the instruction hash of a run's version tuple). */
  hash: string;
  /** Hash of the whole system prompt above. */
  promptHash: string;
  /** The hash of the repository's convention files the last run was given ("unavailable" when it could not read them, null with no repository or no run yet): part of the instruction hash. */
  repoContextHash: string | null;
  /** What a version tuple stores for a run given these layers, skills and convention files (S-144): runs given different AGENTS.md files have different values. */
  instructionHash: string;
  /** The parts of `text` in order; `source` says who adds each: the layers and skills are configuration, "runner" parts are added by the runner. */
  sections: Array<{ key: string; title: string; source: "layer" | "skill" | "runner"; text: string; words: number }>;
  handoff: { first: string; json: string[] };
  /** True when the preview is the saved working copy rather than a version. Skills in a draft are the current attachments at their latest version. */
  draft: boolean;
  words: number;
  tokens: number;
  layers: Array<Pick<Layer, "key" | "name" | "version" | "hash" | "text"> & { commit?: string | null }>;
  skills: Array<{ id: string; name: string; version: number; label: string; when: string; resources: string[]; content: string }>;
  /** The repository's own convention files (AGENTS.md, CLAUDE.md...) as last offered to a run, read from the repository, separate from the repo guidelines layer. Null when no run was seeded from it yet. */
  repoContext: RepoContextSummary;
}

export async function effectiveFor(db: Queryable, orgId: string, agentId: string, q: { project?: string | undefined; repo?: string | undefined; version?: string | undefined }): Promise<Effective> {
  const a = (await db.query<{ id: string; name: string; data: Record<string, unknown>; live_version: number | null }>(`select id, name, data, live_version from agents where org_id = $1 and id = $2`, [orgId, agentId])).rows[0];
  if (!a) throw notFound("No such agent.");
  const project = q.project ? await projectInfo(db, orgId, q.project) : null;
  if (q.project && !project) throw notFound("No such project.");
  let repo: { id: string; name: string } | null = null;
  if (q.repo) {
    repo = (await db.query<{ id: string; name: string; project_id: string }>(`select id, name, project_id from repos where org_id = $1 and id = $2`, [orgId, q.repo])).rows[0] ?? null;
    if (!repo) throw notFound("No such repo.");
    if (project && (repo as unknown as { project_id: string }).project_id !== project.id) throw invalid("That repo belongs to another project.");
  }
  let av: AgentBody | null;
  let label: string;
  if (q.version === "draft") {
    const skills = (await attachedSkills(db, orgId, agentId)).map((s) => s.skill_id);
    av = { version: 0, label: "draft", body: snapshotOf(cfgOf(a.data), skills, await pinSkills(db, orgId, agentId, skills)), name: a.name, data: a.data };
    label = "draft";
  } else {
    let n: number | null = a.live_version;
    if (q.version) {
      const v = (await versionRows(db, orgId, agentId)).find((x) => labelOf(x) === q.version || String(x.version) === q.version);
      if (!v) throw notFound("No such version.");
      n = v.version;
    }
    av = n === null ? null : await loadAgentVersion(db, orgId, agentId, n);
    label = av?.label ?? "";
  }
  const { layers } = await composeLayers(db, { orgId, agentId, projectId: project?.id ?? null, repoId: repo?.id ?? null }, av);
  const repoContext = repo ? await latestRepoContext(db, orgId, repo.id) : null;
  const composed = assemble(layers);
  const skills = av ? await resolveSkills(db, { orgId, agentId, body: av.body, projectId: project?.id ?? null, }) : [];
  const full = systemPrompt(composed.text, skills);
  const wc = (t: string): number => (t.trim() ? t.trim().split(/\s+/).length : 0);
  const sections: Effective["sections"] = [
    ...composed.layers.map((l) => ({ key: l.key, title: l.name, source: "layer" as const, text: l.text.trim(), words: wc(l.text) })),
    ...skills.map((k) => ({ key: `skill:${k.id}`, title: `Skill: ${k.name} v${k.label}`, source: "skill" as const, text: k.content.trim(), words: wc(k.content) })),
    { key: "station-tools", title: "Station tools", source: "runner" as const, text: STATION_TOOLS_TEXT, words: wc(STATION_TOOLS_TEXT) },
    { key: "result", title: "Result format", source: "runner" as const, text: RESULT_TEXT, words: wc(RESULT_TEXT) },
  ];
  return {
    agent: agentId, version: label, live: av !== null && av.version === a.live_version, draft: q.version === "draft", project: project ? { id: project.id, name: project.name } : null, repo: repo ? { id: repo.id, name: repo.name } : null,
    text: full, hash: composed.hash, promptHash: sha256(full), repoContextHash: repoContext ? repoContext.hash : null,
    instructionHash: tupleInstructionHash(buildManifest("run", composedParts(composed.layers, skills)).hash, repoContext ? repoContext.hash : null), sections, handoff: HANDOFF_SHAPE, words: wc(full), tokens: Math.round(full.length / 4),
    layers: composed.layers.map((l) => ({ key: l.key, name: l.name, version: l.version, hash: l.hash, text: l.text, ...(l.commit !== undefined ? { commit: l.commit } : {}) })),
    skills: skills.map((s) => ({ id: s.id, name: s.name, version: s.version, label: s.label, when: s.when, resources: s.resources, content: s.content })),
    repoContext,
  };
}
