/**
 * Loads the built-in starter kit (domain/starter-kit.ts) into an organisation: the agents the floor's stations name, the skills they carry and one eval suite per agent.
 *
 * The unit is the bundle (an agent, its skills, its suite). A bundle is loaded only when its agent is missing, and then in full: skills and cases are inserted with
 * `on conflict do nothing`, so an existing skill of the same id is attached and never changed. A bundle already loaded is never touched again, so an edited
 * instruction, a new agent version, a changed model or a deleted case survives every restart, and an org with its own agents (the dev seed, or a restored backup)
 * gets nothing added. Nothing is invented: no metrics, runs or trust cells. Trust starts where it always does, with no cell: L1 applies until evidence earns more.
 */
import { STARTER_KIT, type KitAgent, type KitSkill } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { cfgOf, sha256, snapshotOf, TOOL_KEYS } from "./config.js";

const json = (v: unknown): string => JSON.stringify(v);
const LABEL = "1.0.0";
const NOTE = "Built-in starter kit";

async function loadSkill(db: Queryable, orgId: string, s: KitSkill): Promise<boolean> {
  const ins = await db.query(
    `insert into skills (org_id, id, name, description, projects, live_version, data) values ($1,$2,$3,$4,'"all"'::jsonb,1,$5::jsonb) on conflict (org_id, id) do nothing`,
    [orgId, s.id, s.name, s.desc, json({ when: s.when, owner: "system", resources: [], builtin: true })],
  );
  if (!ins.rowCount) return false;
  await db.query(
    `insert into skill_versions (org_id, skill_id, version, body, content_hash, note, published_at, published_by) values ($1,$2,1,$3::jsonb,$4,$5,now(),'system') on conflict do nothing`,
    [orgId, s.id, json({ label: LABEL, name: s.name, desc: s.desc, when: s.when, body: s.body, resources: [] }), sha256(s.body), NOTE],
  );
  return true;
}

async function loadAgent(db: Queryable, orgId: string, a: KitAgent, skills: Map<string, KitSkill>): Promise<boolean> {
  const tools = Object.fromEntries(TOOL_KEYS.map((k) => [k, a.tools[k] === true]));
  const cfg = cfgOf({
    model: a.model, fallbacks: [], autonomy: a.autonomy, tools, mcp: [], stations: a.station ? [a.station] : [], projects: "all", budget: a.budget,
    guardrails: a.guardrails, suite: a.suite.id, instructions: a.instructions, overrides: {},
  });
  const ins = await db.query(
    `insert into agents (org_id, id, name, kind, station, status, live_version, data) values ($1,$2,$3,$4,$5,'active',1,$6::jsonb) on conflict (org_id, id) do nothing`,
    [orgId, a.id, a.name, a.station ? "station" : "onboarding", a.station, json({ ...cfg, promoted: [1], builtin: true, owner: "system" })],
  );
  if (!ins.rowCount) return false;
  for (const id of a.skills) {
    const s = skills.get(id);
    if (s) await loadSkill(db, orgId, s);
  }
  await db.query(
    `insert into agent_versions (org_id, agent_id, version, body, harness_version, instruction_hash, model_id, note, published_at, published_by) values ($1,$2,1,$3::jsonb,'',$4,$5,$6,now(),'system')`,
    [orgId, a.id, json({ label: LABEL, rc: false, diff: "", builtin: true, ...snapshotOf(cfg, a.skills) }), sha256(cfg.instructions), a.model, NOTE],
  );
  for (const [i, id] of a.skills.entries()) await db.query(`insert into agent_skills (org_id, agent_id, skill_id, position) values ($1,$2,$3,$4) on conflict do nothing`, [orgId, a.id, id, i + 1]);
  const su = a.suite;
  await db.query(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,$2,$3,$4,$5,$6::jsonb) on conflict (org_id, id) do nothing`, [orgId, su.id, su.name, su.station, a.id, json({ threshold: su.threshold, builtin: true })]);
  for (const c of su.cases) {
    const body = { by: "system", task: c.task, checks: c.checks, repo: null, commit: null, project: null, ...(c.cls ? { cls: c.cls } : {}), ...(c.skill ? { skill: c.skill } : {}), rules: c.rules, builtin: true };
    await db.query(`insert into eval_cases (org_id, id, suite_id, name, body, golden) values ($1,$2,$3,$4,$5::jsonb,false) on conflict (org_id, id) do nothing`, [orgId, c.id, su.id, c.name, json(body)]);
  }
  return true;
}

/** Loads every bundle whose agent is missing. Returns the ids of the agents loaded. Safe to call on every start. */
export async function loadStarterKit(db: Queryable, orgId: string): Promise<string[]> {
  const skills = new Map(STARTER_KIT.skills.map((s) => [s.id, s]));
  const loaded: string[] = [];
  for (const a of STARTER_KIT.agents) if (await loadAgent(db, orgId, a, skills)) loaded.push(a.id);
  return loaded;
}
