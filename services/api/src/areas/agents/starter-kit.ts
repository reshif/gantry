/**
 * Loads the built-in starter kit (domain/starter-kit.ts) into an organisation: the agents the floor's stations name, the skills they carry and one eval suite per agent.
 *
 * The unit is the bundle (an agent, its skills, its suite). A bundle is loaded only when its agent is missing, and then in full: skills and cases are inserted with
 * `on conflict do nothing`, so an existing skill of the same id is attached and never changed. A bundle already loaded is never touched again, so an edited
 * instruction, a new agent version, a changed model or a deleted case survives every restart, and an org with its own agents (the dev seed, or a restored backup)
 * gets nothing added. Nothing is invented: no metrics, runs or trust cells. Trust starts where it always does, with no cell: L1 applies until evidence earns more.
 */
import { KIT_VERSION, STARTER_KIT, type KitAgent, type KitCase, type KitSkill } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { pinSkills } from "./compose.js";
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
    [orgId, a.id, json({ label: LABEL, rc: false, diff: "", builtin: true, ...snapshotOf(cfg, a.skills, await pinSkills(db, orgId, null, a.skills)) }), sha256(cfg.instructions), a.model, NOTE],
  );
  for (const [i, id] of a.skills.entries()) await db.query(`insert into agent_skills (org_id, agent_id, skill_id, position) values ($1,$2,$3,$4) on conflict do nothing`, [orgId, a.id, id, i + 1]);
  const su = a.suite;
  await db.query(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,$2,$3,$4,$5,$6::jsonb) on conflict (org_id, id) do nothing`, [orgId, su.id, su.name, su.station, a.id, json({ threshold: su.threshold, builtin: true, kit: KIT_VERSION })]);
  for (const c of su.cases) await insertCase(db, orgId, su.id, c);
  return true;
}

const caseBody = (c: KitCase) => ({ by: "system", task: c.task, checks: c.checks, repo: null, commit: null, project: null, ...(c.cls ? { cls: c.cls } : {}), ...(c.skill ? { skill: c.skill } : {}), rules: c.rules, builtin: true });

async function insertCase(db: Queryable, orgId: string, suiteId: string, c: KitCase): Promise<void> {
  await db.query(`insert into eval_cases (org_id, id, suite_id, name, body, golden) values ($1,$2,$3,$4,$5::jsonb,false) on conflict (org_id, id) do nothing`, [orgId, c.id, suiteId, c.name, json(caseBody(c))]);
}

/** Version strings are x.y.z: true when a is older than b. */
const older = (a: string, b: string): boolean => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

/**
 * Adds the cases a newer kit brought to an organisation's built-in suites (the first kit shipped without the CITE, ASK, ASSUME and prompt-injection cases).
 * A built-in suite records the kit version it was last brought to (a suite from before that record is on 1.1.0); only cases newer than that are added, once,
 * so a case a person deleted or edited never comes back or changes, and a suite a person created or an agent they replaced is not touched.
 * Returns the number of cases added.
 */
export async function addNewKitCases(db: Queryable, orgId: string): Promise<number> {
  let added = 0;
  for (const a of STARTER_KIT.agents) {
    const su = a.suite;
    const row = (await db.query<{ data: Record<string, unknown> }>(`select data from suites where org_id = $1 and id = $2 and agent_id = $3 for update`, [orgId, su.id, a.id])).rows[0];
    if (!row || row.data.builtin !== true) continue;
    const at = typeof row.data.kit === "string" ? row.data.kit : "1.1.0";
    if (!older(at, KIT_VERSION)) continue;
    for (const c of su.cases.filter((x) => x.since && older(at, x.since))) {
      await insertCase(db, orgId, su.id, c);
      added++;
    }
    await db.query(`update suites set data = data || $3::jsonb where org_id = $1 and id = $2`, [orgId, su.id, json({ kit: KIT_VERSION })]);
  }
  return added;
}

/** Loads every bundle whose agent is missing. Returns the ids of the agents loaded. Safe to call on every start. */
export async function loadStarterKit(db: Queryable, orgId: string): Promise<string[]> {
  const skills = new Map(STARTER_KIT.skills.map((s) => [s.id, s]));
  const loaded: string[] = [];
  for (const a of STARTER_KIT.agents) if (await loadAgent(db, orgId, a, skills)) loaded.push(a.id);
  return loaded;
}

const UPGRADE_NOTE = "Starter kit 1.1.0: the Onboarding Agent authors the whole onboarding pull request";

/**
 * Brings an org's built-in Onboarding Agent from the first kit's instructions (it could only draft AGENTS.md) to the current ones (it authors the pull request), as a NEW version
 * (the old one stays in the history and can be restored). Only an agent still on its untouched built-in version 1 is upgraded: an agent a person edited, versioned or replaced is left alone.
 * The skill that carries the drafting instructions moves the same way, the diff cap moves from the old default (300) to the scaffold default, and the eval cases are brought along.
 */
export async function upgradeOnboardingAgent(db: Queryable, orgId: string): Promise<boolean> {
  const kit = STARTER_KIT.agents.find((a) => a.id === "ag-onboard");
  if (!kit) return false;
  const row = (await db.query<{ live_version: number | null; data: Record<string, unknown>; version: number }>(`select live_version, data, version from agents where org_id = $1 and id = $2 for update`, [orgId, kit.id])).rows[0];
  if (!row || row.live_version !== 1 || row.data.builtin !== true) return false;
  const v1 = (await db.query<{ instruction_hash: string; body: Record<string, unknown> }>(`select instruction_hash, body from agent_versions where org_id = $1 and agent_id = $2 and version = 1`, [orgId, kit.id])).rows[0];
  const count = Number((await db.query<{ n: string }>(`select count(*)::text as n from agent_versions where org_id = $1 and agent_id = $2`, [orgId, kit.id])).rows[0]?.n ?? "0");
  const cur = typeof row.data.instructions === "string" ? row.data.instructions : "";
  if (!v1 || count !== 1 || v1.instruction_hash !== sha256(cur) || sha256(cur) === sha256(kit.instructions)) return false;
  const gr = (row.data.guardrails ?? {}) as { paths?: string[]; maxDiff?: number };
  const guardrails = { paths: gr.paths ?? [], maxDiff: gr.maxDiff === 300 || !gr.maxDiff ? kit.guardrails.maxDiff : gr.maxDiff };
  if (JSON.stringify(gr.paths ?? []) !== "[]" && (gr.paths ?? []).length && (gr.paths ?? []).every((p) => /^\.github\/workflows|^\.gantry|CODEOWNERS|^\.github/.test(p))) guardrails.paths = [];
  const cfg = cfgOf({ ...row.data, instructions: kit.instructions, guardrails });
  const promoted = Array.isArray(row.data.promoted) ? (row.data.promoted as number[]) : [1];
  const skill = STARTER_KIT.skills.find((s) => s.id === "sk-onboardpr");
  const sk = skill ? (await db.query<{ live_version: number; data: Record<string, unknown> }>(`select live_version, data from skills where org_id = $1 and id = $2`, [orgId, skill.id])).rows[0] : undefined;
  if (skill && sk && sk.live_version === 1 && sk.data.builtin === true) {
    await db.query(
      `insert into skill_versions (org_id, skill_id, version, body, content_hash, note, published_at, published_by) values ($1,$2,2,$3::jsonb,$4,$5,now(),'system') on conflict do nothing`,
      [orgId, skill.id, json({ label: "1.1.0", name: skill.name, desc: skill.desc, when: skill.when, body: skill.body, resources: [] }), sha256(skill.body), UPGRADE_NOTE],
    );
    await db.query(`update skills set live_version = 2, name = $3, description = $4 where org_id = $1 and id = $2`, [orgId, skill.id, skill.name, skill.desc]);
  }
  await db.query(
    `insert into agent_versions (org_id, agent_id, version, body, harness_version, instruction_hash, model_id, note, published_at, published_by) values ($1,$2,2,$3::jsonb,'',$4,$5,$6,now(),'system')`,
    [orgId, kit.id, json({ label: "1.1.0", rc: false, diff: "instructions, guardrails", builtin: true, ...snapshotOf(cfg, kit.skills, await pinSkills(db, orgId, null, kit.skills)) }), sha256(cfg.instructions), cfg.model, UPGRADE_NOTE],
  );
  await db.query(`update agents set live_version = 2, data = $3::jsonb, version = version + 1 where org_id = $1 and id = $2`, [orgId, kit.id, json({ ...row.data, instructions: cfg.instructions, guardrails: cfg.guardrails, promoted: [...promoted, 2] })]);
  for (const c of kit.suite.cases.filter((x) => x.id === "ONB-04" || x.id === "ONB-08")) {
    const body = { by: "system", task: c.task, checks: c.checks, repo: null, commit: null, project: null, ...(c.cls ? { cls: c.cls } : {}), ...(c.skill ? { skill: c.skill } : {}), rules: c.rules, builtin: true };
    await db.query(`insert into eval_cases (org_id, id, suite_id, name, body, golden) values ($1,$2,$3,$4,$5::jsonb,false) on conflict (org_id, id) do update set name = excluded.name, body = excluded.body where eval_cases.body->>'builtin' = 'true'`, [orgId, c.id, kit.suite.id, c.name, json(body)]);
  }
  return true;
}
