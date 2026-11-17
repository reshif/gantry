/**
 * A skill edit is a change to what an agent is told, so it goes through the same gate as an edit to the agent's own text (spec 13.2): saving a skill version cuts a candidate
 * version of every agent whose floor version has the skill attached. The candidate is the floor version with that one skill moved to the new version; nothing changes on the
 * floor until the candidate passes the agent's eval suite and a person promotes it. Draft edits on the agent are not swept in.
 */
import type { Tx } from "@gantry/db";
import type { EventSpec } from "../../core/command.js";
import { labelOf, versionRows } from "./store.js";

export interface SkillCandidate {
  agent: string;
  name: string;
  version: string;
  n: number;
}

const json = (v: unknown): string => JSON.stringify(v);

/** 1.2.0 becomes 1.3.0. */
function bump(label: string, n: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(label);
  return m ? `${m[1]}.${Number(m[2]) + 1}.0` : `${n}.0.0`;
}

export async function cutSkillCandidates(tx: Tx, a: { orgId: string; id: string }, skill: { id: string; name: string; version: number; label: string }, note: string): Promise<{ made: SkillCandidate[]; events: EventSpec[] }> {
  const agents = (await tx.query<{ id: string; name: string; live_version: number | null }>(
    `select a.id, a.name, a.live_version from agents a join agent_skills s on s.org_id = a.org_id and s.agent_id = a.id and s.skill_id = $2
      where a.org_id = $1 and a.live_version is not null order by a.created_at, a.id for update of a`,
    [a.orgId, skill.id],
  )).rows;
  const made: SkillCandidate[] = [];
  const events: EventSpec[] = [];
  for (const ag of agents) {
    const vers = await versionRows(tx, a.orgId, ag.id);
    const live = vers.find((v) => v.version === ag.live_version);
    if (!live) continue;
    const ids = Array.isArray(live.body.skills) ? (live.body.skills as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (!ids.includes(skill.id)) continue; // attached in the draft only: the next version cut from the draft picks the skill up
    const was = typeof live.body.skillVersions === "object" && live.body.skillVersions ? (live.body.skillVersions as Record<string, number>) : {};
    const body = { ...live.body, skillVersions: { ...was, [skill.id]: skill.version } };
    let label = bump(labelOf(live), live.version);
    while (vers.some((v) => labelOf(v) === label)) label = bump(label, live.version);
    const diff = `~ skillVersions (${skill.name} ${skill.label})`;
    const n = Math.max(0, ...vers.map((v) => v.version)) + 1;
    await tx.query(
      `insert into agent_versions (org_id, agent_id, version, body, harness_version, instruction_hash, model_id, note, published_at, published_by)
       select org_id, agent_id, $3, $4::jsonb, harness_version, instruction_hash, model_id, $5, now(), $6 from agent_versions where org_id = $1 and agent_id = $2 and version = $7`,
      [a.orgId, ag.id, n, json({ ...body, label, rc: true, diff }), `${skill.name} ${skill.label}: ${note}`, a.id, live.version],
    );
    await tx.query(`update agents set version = version + 1 where org_id = $1 and id = $2`, [a.orgId, ag.id]);
    made.push({ agent: ag.id, name: ag.name, version: label, n });
    events.push({
      type: "agent.version", category: "agents", subject: { type: "agent", id: ag.id }, projectId: null,
      after: { version: label, n, diff, trigger: "skill.edit", skill: skill.id, skillVersion: skill.label, from: labelOf(live), changed: ["skillVersions"] },
    });
  }
  return { made, events };
}
