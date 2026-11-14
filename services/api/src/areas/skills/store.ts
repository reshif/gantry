/** Skill reads in the legacy `G.store.skills` shape. A skill version is a row of skill_versions; the skill row points at the latest. */
import type { Skill } from "@gantry/domain";
import type { Queryable } from "@gantry/db";

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  projects: unknown;
  live_version: number | null;
  data: Record<string, unknown>;
  version: number;
}
export interface SkillVersionRow {
  skill_id: string;
  version: number;
  body: Record<string, unknown>;
  note: string;
  published_at: Date | null;
  created_at: Date;
  published_by: string | null;
}

export const skillLabel = (v: Pick<SkillVersionRow, "version" | "body">): string => (typeof v.body.label === "string" && v.body.label ? v.body.label : `${v.version}.0.0`);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function skillRows(db: Queryable, orgId: string, id?: string, lock = false): Promise<SkillRow[]> {
  return (await db.query<SkillRow>(`select id, name, description, projects, live_version, data, version from skills where org_id = $1 ${id ? "and id = $2" : ""} order by created_at, id ${lock ? "for update" : ""}`, id ? [orgId, id] : [orgId])).rows;
}
export async function skillVersionRows(db: Queryable, orgId: string, id?: string): Promise<SkillVersionRow[]> {
  return (await db.query<SkillVersionRow>(`select skill_id, version, body, note, published_at, created_at, published_by from skill_versions where org_id = $1 ${id ? "and skill_id = $2" : ""} order by skill_id, version`, id ? [orgId, id] : [orgId])).rows;
}

export type SkillOut = Skill & { rev: number };

/** Eval coverage: the cases that exercise a skill (`body.skill` or `body.skills` names it) and how many of them passed in their latest completed run. */
async function coverage(db: Queryable, orgId: string): Promise<Map<string, { suite: string | null; cases: number; pass: number }>> {
  const { rows } = await db.query<{ skill_id: string; suite_id: string; case_id: string; passed: boolean | null }>(
    `select s.id as skill_id, c.suite_id, c.id as case_id, lr.passed
       from skills s
       join eval_cases c on c.org_id = s.org_id and (c.body->>'skill' = s.id or (jsonb_typeof(c.body->'skills') = 'array' and c.body->'skills' ? s.id))
       left join lateral (
         select r.passed from eval_results r join eval_runs er on er.org_id = r.org_id and er.id = r.run_id and er.status = 'completed'
          where r.org_id = c.org_id and r.case_id = c.id order by er.started_at desc limit 1) lr on true
      where s.org_id = $1 order by s.id, c.id`,
    [orgId],
  );
  const out = new Map<string, { suite: string | null; cases: number; pass: number }>();
  for (const r of rows) {
    const o = out.get(r.skill_id) ?? { suite: r.suite_id, cases: 0, pass: 0 };
    o.cases += 1;
    if (r.passed) o.pass += 1;
    out.set(r.skill_id, o);
  }
  return out;
}

export async function readSkills(db: Queryable, orgId: string, id?: string): Promise<SkillOut[]> {
  const skills = await skillRows(db, orgId, id);
  const vers = await skillVersionRows(db, orgId, id);
  const cov = await coverage(db, orgId);
  return skills.map((s) => {
    const mine = vers.filter((v) => v.skill_id === s.id);
    const live = mine.find((v) => v.version === s.live_version) ?? mine[mine.length - 1];
    const b = live?.body ?? {};
    return {
      id: s.id, name: s.name, desc: s.description, when: str(b.when) || str(s.data.when), owner: str(s.data.owner), body: str(b.body), resources: strs(b.resources).length ? strs(b.resources) : strs(s.data.resources),
      version: live ? skillLabel(live) : "", projects: s.projects === "all" || !Array.isArray(s.projects) ? "all" : strs(s.projects),
      versions: mine.map((v) => ({ v: skillLabel(v), at: (v.published_at ?? v.created_at).getTime(), by: v.published_by ?? "", note: v.note })),
      coverage: cov.get(s.id) ?? { suite: null, cases: 0, pass: 0 }, ...(s.data.builtin === true ? { builtin: true } : {}), rev: s.version,
    };
  });
}
