/** The effective instructions preview (spec 8.7, 10.2): exactly what a run of this agent would be given for a project and repository. */
import type { Queryable } from "@gantry/db";
import { notFound, invalid } from "../../core/errors.js";
import { assemble, composeLayers, loadAgentVersion, projectInfo, resolveSkills, type AgentBody, type Layer } from "./compose.js";
import { cfgOf, snapshotOf } from "./config.js";
import { attachedSkills, labelOf, versionRows } from "./store.js";

export interface Effective {
  agent: string;
  /** The version the text is composed from: a label, or "draft" for the saved working configuration. */
  version: string;
  live: boolean;
  project: { id: string; name: string } | null;
  repo: { id: string; name: string } | null;
  text: string;
  hash: string;
  words: number;
  tokens: number;
  layers: Array<Pick<Layer, "key" | "name" | "version" | "hash" | "text"> & { commit?: string | null }>;
  skills: Array<{ id: string; name: string; version: number; label: string; when: string; resources: string[] }>;
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
    av = { version: 0, label: "draft", body: snapshotOf(cfgOf(a.data), skills), name: a.name, data: a.data };
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
  const composed = assemble(layers);
  const skills = av ? await resolveSkills(db, { orgId, agentId, body: av.body, projectId: project?.id ?? null, withContent: false }) : [];
  const words = composed.text.trim() ? composed.text.trim().split(/\s+/).length : 0;
  return {
    agent: agentId, version: label, live: av !== null && av.version === a.live_version, project: project ? { id: project.id, name: project.name } : null, repo: repo ? { id: repo.id, name: repo.name } : null,
    text: composed.text, hash: composed.hash, words, tokens: Math.round(composed.text.length / 4),
    layers: composed.layers.map((l) => ({ key: l.key, name: l.name, version: l.version, hash: l.hash, text: l.text, ...(l.commit !== undefined ? { commit: l.commit } : {}) })),
    skills: skills.map((s) => ({ id: s.id, name: s.name, version: s.version, label: s.label, when: s.when, resources: s.resources })),
  };
}
