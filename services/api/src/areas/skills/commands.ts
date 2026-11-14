/** Skill commands (spec 8.7). Every save is a new immutable version, picked up by an agent's next dispatch; scoping to projects creates none. */
import { randomBytes } from "node:crypto";
import type { Tx } from "@gantry/db";
import type { z } from "zod";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound } from "../../core/errors.js";
import { sha256, slug } from "../agents/config.js";
import type { CreateSkillBody, SkillPatch } from "./schemas.js";
import { readSkills, skillLabel, skillRows, skillVersionRows } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;
const cat = "agents" as const;
const json = (v: unknown): string => JSON.stringify(v);
const subject = (id: string) => ({ type: "skill", id });

/** 1.2.0 becomes 1.3.0 (legacy saveSkill). */
export function nextLabel(label: string, n: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(label);
  return m ? `${m[1]}.${Number(m[2]) + 1}.0` : `${n}.0.0`;
}

export async function createSkill(tx: Tx, a: Actor, b: z.infer<typeof CreateSkillBody>): Promise<Cmd> {
  const id = `sk-${slug(b.name, 20)}-${randomBytes(2).toString("hex")}`;
  const body = { label: "1.0.0", name: b.name, desc: b.desc ?? "", when: b.when ?? "", body: b.body ?? "", resources: b.resources ?? [] };
  await tx.query(`insert into skills (org_id, id, name, description, projects, live_version, data) values ($1,$2,$3,$4,'"all"'::jsonb,1,$5::jsonb)`, [a.orgId, id, b.name, body.desc, json({ when: body.when, owner: a.personId ?? a.id, resources: body.resources })]);
  await tx.query(`insert into skill_versions (org_id, skill_id, version, body, content_hash, note, published_at, published_by) values ($1,$2,1,$3::jsonb,$4,$5,now(),$6)`, [a.orgId, id, json(body), sha256(body.body), b.note || "Created", a.id]);
  const skill = (await readSkills(tx, a.orgId, id))[0];
  return {
    msg: `Skill ${b.name} created.`, changes: ["skills", "audit"], project: null, extra: { skill },
    events: [{ type: "skill.create", category: cat, subject: subject(id), projectId: null, after: { name: b.name, version: "1.0.0", when: body.when, resources: body.resources } }],
  };
}

export async function saveSkill(tx: Tx, a: Actor, id: string, patch: z.infer<typeof SkillPatch>, note: string | undefined): Promise<Cmd> {
  const row = (await skillRows(tx, a.orgId, id, true))[0];
  if (!row) throw notFound("No such skill.");
  const cur = (await readSkills(tx, a.orgId, id))[0]!;
  const vers = await skillVersionRows(tx, a.orgId, id);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const next = { name: cur.name, desc: cur.desc, when: cur.when, body: cur.body, resources: cur.resources };
  for (const k of ["name", "desc", "when", "body", "resources"] as const) {
    const v = patch[k];
    if (v === undefined || JSON.stringify(v) === JSON.stringify(cur[k])) continue;
    before[k] = cur[k];
    after[k] = v;
    (next as Record<string, unknown>)[k] = v;
  }
  if (!Object.keys(after).length) throw invalid("Nothing changed.");
  if (next.name !== row.name && (await tx.query(`select 1 from skills where org_id = $1 and lower(name) = lower($2) and id <> $3`, [a.orgId, next.name, id])).rowCount) throw conflict(`A skill called ${next.name} exists.`);
  const n = Math.max(0, ...vers.map((v) => v.version)) + 1;
  const label = nextLabel(cur.version, n);
  const body = { label, ...next };
  await tx.query(`insert into skill_versions (org_id, skill_id, version, body, content_hash, note, published_at, published_by) values ($1,$2,$3,$4::jsonb,$5,$6,now(),$7)`, [a.orgId, id, n, json(body), sha256(next.body), note || `Edited ${Object.keys(after).join(", ")}`, a.id]);
  await tx.query(`update skills set name = $3, description = $4, live_version = $5, data = $6::jsonb, version = version + 1 where org_id = $1 and id = $2`, [a.orgId, id, next.name, next.desc, n, json({ ...row.data, when: next.when, resources: next.resources })]);
  return {
    msg: `${next.name} saved as v${label}.`, changes: ["skills", "agents", "audit"], project: null, extra: { version: label, n },
    events: [{ type: "skill.edit", category: cat, subject: subject(id), projectId: null, before: { ...before, version: cur.version }, after: { ...after, version: label, ...(note ? { note } : {}) } }],
  };
}

export async function setSkillProjects(tx: Tx, a: Actor, id: string, projects: "all" | string[]): Promise<Cmd> {
  const row = (await skillRows(tx, a.orgId, id, true))[0];
  if (!row) throw notFound("No such skill.");
  const list = projects === "all" ? "all" : [...new Set(projects)];
  if (list !== "all" && list.length) {
    const have = new Set((await tx.query<{ id: string }>(`select id from projects where org_id = $1 and id = any($2)`, [a.orgId, list])).rows.map((r) => r.id));
    const bad = list.filter((p) => !have.has(p));
    if (bad.length) throw invalid(`There is no project ${bad.join(", ")}.`);
  }
  const before = row.projects === "all" || !Array.isArray(row.projects) ? "all" : row.projects;
  await tx.query(`update skills set projects = $3::jsonb, version = version + 1 where org_id = $1 and id = $2`, [a.orgId, id, json(list)]);
  const names = list === "all" ? [] : (await tx.query<{ name: string }>(`select name from projects where org_id = $1 and id = any($2) order by name`, [a.orgId, list])).rows.map((r) => r.name);
  return {
    msg: `${row.name}: enabled on ${list === "all" ? "all projects" : names.length ? names.join(", ") : "no projects"}.`, changes: ["skills", "audit"], project: null, extra: { projects: list },
    events: [{ type: "skill.scope", category: cat, subject: subject(id), projectId: null, before: { projects: before }, after: { projects: list } }],
  };
}

export { skillLabel };
