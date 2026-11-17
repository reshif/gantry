/**
 * Agent commands (spec 8.7, 10.2, 13.2). Each runs inside `command()`: decision point, state and event in one transaction, a denial audited.
 * A version is immutable once created; "the floor" is agents.live_version. Promotion is blocked until the station suite passed for that version.
 * Agents themselves can never change any of this (I6): these routes are for people, and a run token reaches only /internal.
 */
import { randomBytes } from "node:crypto";
import type { Tx } from "@gantry/db";
import type { z } from "zod";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { pinSkills } from "./compose.js";
import { AUTONOMY_LEVELS, autonomyCheck, cfgOf, diffKeys, sha256, slug, snapshotOf, VERSIONED_KEYS, type AgentCfg } from "./config.js";
import type { AgentPatch, CreateBody } from "./schemas.js";
import { agentRows, attachedSkills, eligibility, labelOf, readAgents, versionRows, type AgentRow } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;
const cat = "agents" as const;
const json = (v: unknown): string => JSON.stringify(v);
const subject = (id: string) => ({ type: "agent", id });

async function lock(tx: Tx, orgId: string, id: string): Promise<AgentRow> {
  const r = (await agentRows(tx, orgId, id, true))[0];
  if (!r) throw notFound("No such agent.");
  return r;
}

async function checkRefs(tx: Tx, orgId: string, p: { model?: string | undefined; fallbacks?: string[] | undefined; skills?: string[] | undefined; mcp?: string[] | undefined; projects?: "all" | string[] | undefined; overrides?: Record<string, { model?: string | undefined }> | undefined; suite?: string | undefined }): Promise<void> {
  const missing = async (what: string, table: string, ids: string[]): Promise<void> => {
    const u = [...new Set(ids)];
    if (!u.length) return;
    const have = new Set((await tx.query<{ id: string }>(`select id from ${table} where org_id = $1 and id = any($2)`, [orgId, u])).rows.map((r) => r.id));
    const bad = u.filter((x) => !have.has(x));
    if (bad.length) throw invalid(`There is no ${what} ${bad.join(", ")}.`);
  };
  const models = [p.model, ...(p.fallbacks ?? []), ...Object.values(p.overrides ?? {}).map((o) => o.model)].filter((m): m is string => typeof m === "string" && m !== "");
  await missing("model", "models", models);
  if (p.fallbacks && p.model && p.fallbacks.includes(p.model)) throw invalid("The primary model cannot also be a fallback.");
  if (p.fallbacks && new Set(p.fallbacks).size !== p.fallbacks.length) throw invalid("A fallback is listed twice.");
  await missing("skill", "skills", p.skills ?? []);
  if (p.skills && new Set(p.skills).size !== p.skills.length) throw invalid("A skill is attached twice.");
  await missing("MCP server", "mcp_servers", p.mcp ?? []);
  if (p.projects && p.projects !== "all") await missing("project", "projects", p.projects);
  await missing("project", "projects", Object.keys(p.overrides ?? {}));
  if (p.suite) await missing("suite", "suites", [p.suite]);
}

/** POL-112 for the working configuration and each per-project override. */
async function checkAutonomy(tx: Tx, orgId: string, station: string | null, cfg: Pick<AgentCfg, "autonomy" | "projects" | "overrides">): Promise<void> {
  const a = await autonomyCheck(tx, orgId, { station, projects: cfg.projects }, cfg.autonomy);
  if (!a.allowed) throw invalid(a.reason ?? "Autonomy is not allowed here.");
  for (const [pid, ov] of Object.entries(cfg.overrides)) {
    if (!ov.autonomy) continue;
    const c = await autonomyCheck(tx, orgId, { station, projects: cfg.projects }, ov.autonomy, pid);
    if (!c.allowed) {
      const name = (await tx.query<{ name: string }>(`select name from projects where org_id = $1 and id = $2`, [orgId, pid])).rows[0]?.name ?? pid;
      throw invalid(`Override for ${name}: ${c.reason}`);
    }
  }
}

/** Replaces the attached skills with `ids`, in order. Pinned versions of skills that stay attached are kept. */
async function writeSkills(tx: Tx, orgId: string, agentId: string, ids: string[]): Promise<void> {
  const keep = new Map((await attachedSkills(tx, orgId, agentId)).map((r) => [r.skill_id, r.pinned_version]));
  await tx.query(`delete from agent_skills where org_id = $1 and agent_id = $2 and not (skill_id = any($3))`, [orgId, agentId, ids]);
  for (const [i, s] of ids.entries()) {
    await tx.query(
      `insert into agent_skills (org_id, agent_id, skill_id, pinned_version, position) values ($1,$2,$3,$4,$5)
       on conflict (org_id, agent_id, skill_id) do update set position = excluded.position`,
      [orgId, agentId, s, keep.get(s) ?? null, i + 1],
    );
  }
}

const CFG_KEYS = ["model", "fallbacks", "autonomy", "tools", "mcp", "stations", "projects", "budget", "guardrails", "suite", "instructions", "overrides"] as const;

export async function saveAgent(tx: Tx, a: Actor, id: string, patch: z.infer<typeof AgentPatch>, note: string | undefined): Promise<Cmd> {
  const row = await lock(tx, a.orgId, id);
  const keys = Object.keys(patch);
  if (!keys.length) throw invalid("Nothing to change.");
  const cfg = cfgOf(row.data);
  const skills = (await attachedSkills(tx, a.orgId, id)).map((s) => s.skill_id);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const next: Record<string, unknown> = { ...cfg };
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
  for (const k of CFG_KEYS) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const merged = k === "tools" ? { ...cfg.tools, ...(v as object) } : v;
    if (same(merged, cfg[k])) continue;
    before[k] = cfg[k];
    after[k] = merged;
    next[k] = merged;
  }
  let name = row.name;
  if (patch.name !== undefined && patch.name !== row.name) { before.name = row.name; after.name = patch.name; name = patch.name; }
  let status = row.status;
  if (patch.status !== undefined && patch.status !== row.status) { before.status = row.status; after.status = patch.status; status = patch.status; }
  const newSkills = patch.skills;
  if (newSkills !== undefined && !same(newSkills, skills)) { before.skills = skills; after.skills = newSkills; }
  if (!Object.keys(after).length) return { msg: `No changes to ${row.name}.`, events: [], extra: { changed: [] }, changes: [], project: null };
  await checkRefs(tx, a.orgId, { model: patch.model, fallbacks: patch.fallbacks ?? (patch.model !== undefined ? cfg.fallbacks : undefined), skills: newSkills, mcp: patch.mcp, projects: patch.projects, overrides: patch.overrides, suite: patch.suite });
  await checkAutonomy(tx, a.orgId, row.station, next as unknown as AgentCfg);
  const data = { ...row.data, ...Object.fromEntries(CFG_KEYS.map((k) => [k, next[k]])) };
  await tx.query(`update agents set name = $3, status = $4, data = $5::jsonb, version = version + 1 where org_id = $1 and id = $2`, [a.orgId, id, name, status, json(data)]);
  if (after.skills !== undefined) await writeSkills(tx, a.orgId, id, newSkills!);
  const changed = Object.keys(after);
  return {
    msg: `Saved ${name}.`, changes: ["agents", "audit"], project: null, extra: { changed },
    events: [{ type: "agent.edit", category: cat, subject: subject(id), projectId: null, before, after: { ...after, ...(note ? { note } : {}) } }],
  };
}

export async function createAgent(tx: Tx, a: Actor, b: z.infer<typeof CreateBody>): Promise<Cmd> {
  const id = `ag-${slug(b.name, 20)}-${randomBytes(2).toString("hex")}`;
  let model = b.model ?? "";
  if (!model) {
    const r = (await tx.query<{ body: { defaultModel?: string } }>(`select body from routing_versions where org_id = $1 order by version desc limit 1`, [a.orgId])).rows[0];
    model = typeof r?.body?.defaultModel === "string" ? r.body.defaultModel : "";
  }
  const station = b.station ?? null;
  const cfg = cfgOf({
    model, fallbacks: b.fallbacks ?? [], autonomy: b.autonomy ?? "suggest", tools: { ...(b.tools ?? {}) }, mcp: b.mcp ?? [], stations: b.stations?.length ? b.stations : station ? [station] : [],
    projects: b.projects ?? "all", budget: b.budget ?? 1, guardrails: { paths: [], maxDiff: 0 }, suite: `SUITE-${id.slice(3).toUpperCase()}`, instructions: b.instructions ?? "", overrides: {},
  });
  const skills = b.skills ?? [];
  await checkRefs(tx, a.orgId, { model, fallbacks: cfg.fallbacks, skills, mcp: cfg.mcp, projects: cfg.projects });
  await checkAutonomy(tx, a.orgId, station, cfg);
  const name = b.name;
  await tx.query(`insert into agents (org_id, id, name, kind, station, status, live_version, data) values ($1,$2,$3,'station',$4,'paused',1,$5::jsonb)`, [a.orgId, id, name, station, json({ ...cfg, promoted: [1] })]);
  await tx.query(
    `insert into agent_versions (org_id, agent_id, version, body, harness_version, instruction_hash, model_id, note, published_at, published_by) values ($1,$2,1,$3::jsonb,'',$4,$5,'Created',now(),$6)`,
    [a.orgId, id, json({ label: "0.1.0", rc: false, diff: "Created", ...snapshotOf(cfg, skills, await pinSkills(tx, a.orgId, null, skills)) }), sha256(cfg.instructions), model || null, a.id],
  );
  await writeSkills(tx, a.orgId, id, skills);
  await tx.query(`insert into suites (org_id, id, name, station, agent_id, data) values ($1,$2,$3,$4,$5,$6::jsonb)`, [a.orgId, cfg.suite, `${name} golden set`, station, id, json({ threshold: 0.85 })]);
  const agent = (await readAgents(tx, a.orgId, id))[0];
  return {
    msg: `${name} created, paused until its suite passes.`, changes: ["agents", "suites", "audit"], project: null, extra: { agent },
    events: [{ type: "agent.create", category: cat, subject: subject(id), projectId: null, after: { name, station, model, autonomy: cfg.autonomy, skills, suite: cfg.suite, version: "0.1.0" } }],
  };
}

/** What a version holds, as a one-line summary of how it differs from the one on the floor. */
function summary(body: Record<string, unknown>, live: Record<string, unknown> | undefined): string {
  if (!live) return "First version";
  const keys = diffKeys(body, live);
  return keys.length ? `~ ${keys.join(", ")}` : "= same configuration as the floor";
}

const find = <T extends { version: number; body: Record<string, unknown> }>(rows: T[], ref: string | number): T | undefined => {
  const s = String(ref);
  return rows.find((v) => labelOf(v) === s) ?? (/^\d+$/.test(s) ? rows.find((v) => v.version === Number(s)) : undefined);
};

export async function newAgentVersion(tx: Tx, a: Actor, id: string, label: string, note: string | undefined): Promise<Cmd> {
  const row = await lock(tx, a.orgId, id);
  const vers = await versionRows(tx, a.orgId, id);
  if (vers.some((v) => labelOf(v) === label)) throw conflict(`${label} already exists.`);
  const cfg = cfgOf(row.data);
  const skills = (await attachedSkills(tx, a.orgId, id)).map((s) => s.skill_id);
  const body = snapshotOf(cfg, skills, await pinSkills(tx, a.orgId, id, skills));
  const live = vers.find((v) => v.version === row.live_version);
  const diff = summary(body, live?.body);
  const n = Math.max(0, ...vers.map((v) => v.version)) + 1;
  await tx.query(
    `insert into agent_versions (org_id, agent_id, version, body, harness_version, instruction_hash, model_id, note, published_at, published_by) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,now(),$9)`,
    [a.orgId, id, n, json({ label, rc: true, diff, ...body }), live?.body.harness ? String(live.body.harness) : "", sha256(cfg.instructions), cfg.model || null, note ?? "", a.id],
  );
  await tx.query(`update agents set version = version + 1 where org_id = $1 and id = $2`, [a.orgId, id]);
  return {
    msg: `${row.name} ${label} created as a candidate. Run its eval suite to promote it.`, changes: ["agents", "audit"], project: null, extra: { version: label, n },
    events: [{ type: "agent.version", category: cat, subject: subject(id), projectId: null, after: { version: label, n, diff, note: note ?? "", model: cfg.model, skills } }],
  };
}

export async function promoteAgent(tx: Tx, a: Actor, id: string, ref: string): Promise<Cmd> {
  const row = await lock(tx, a.orgId, id);
  const vers = await versionRows(tx, a.orgId, id);
  const v = find(vers, ref);
  if (!v) throw notFound("No such version.");
  const label = labelOf(v);
  if (v.version === row.live_version) throw conflict(`${row.name} ${label} is already on the floor.`);
  const promoted = new Set(Array.isArray(row.data.promoted) ? (row.data.promoted as unknown[]) : []);
  if (v.body.rc !== true || promoted.has(v.version)) throw conflict(`${label} was on the floor before. Roll back to it instead.`);
  const el = await eligibility(tx, a.orgId, row, v);
  if (!el.ok) {
    throw refuse("denied", `Blocked: ${el.text}.`, { needs: `Needs ${el.needs}`, rule: { kind: "gate", id: "EVAL-GATE", name: "Eval promotion gate" } });
  }
  const liveLabel = vers.find((x) => x.version === row.live_version);
  await tx.query(`update agents set live_version = $3, data = $4::jsonb, version = version + 1 where org_id = $1 and id = $2`, [a.orgId, id, v.version, json({ ...row.data, promoted: [...promoted, v.version] })]);
  return {
    msg: `${row.name} ${label} is on the floor.`, changes: ["agents", "audit"], project: null, extra: { version: label, score: el.score },
    events: [{ type: "agent.promote", category: cat, subject: subject(id), projectId: null, before: { version: liveLabel ? labelOf(liveLabel) : null }, after: { version: label, n: v.version, suite: el.suite, run: el.run, score: el.score, threshold: el.threshold } }],
  };
}

/** Rollback skips the gate: the old version already passed it. It restores that version's configuration as the working copy. */
export async function rollbackAgent(tx: Tx, a: Actor, id: string, ref: string | number): Promise<Cmd> {
  const row = await lock(tx, a.orgId, id);
  const vers = await versionRows(tx, a.orgId, id);
  const v = find(vers, ref);
  if (!v) throw notFound("No such version.");
  const label = labelOf(v);
  if (v.version === row.live_version) throw conflict(`${label} is already on the floor.`);
  const promoted = new Set(Array.isArray(row.data.promoted) ? (row.data.promoted as unknown[]) : []);
  if (v.body.rc === true && !promoted.has(v.version)) throw invalid(`${label} was never on the floor, so there is nothing to roll back to. Promote it instead.`);
  const from = vers.find((x) => x.version === row.live_version);
  const data: Record<string, unknown> = { ...row.data };
  for (const k of VERSIONED_KEYS) if (k !== "skills" && k !== "skillVersions" && k in v.body) data[k] = v.body[k];
  await tx.query(`update agents set live_version = $3, data = $4::jsonb, version = version + 1 where org_id = $1 and id = $2`, [a.orgId, id, v.version, json(data)]);
  if (Array.isArray(v.body.skills)) {
    const have = new Set((await tx.query<{ id: string }>(`select id from skills where org_id = $1 and id = any($2)`, [a.orgId, v.body.skills])).rows.map((r) => r.id));
    await writeSkills(tx, a.orgId, id, (v.body.skills as unknown[]).filter((s): s is string => typeof s === "string" && have.has(s)));
  }
  return {
    msg: `${row.name} rolled back to ${label}.`, changes: ["agents", "audit"], project: null, extra: { version: label },
    events: [{ type: "agent.rollback", category: cat, subject: subject(id), projectId: null, before: { version: from ? labelOf(from) : null }, after: { version: label, n: v.version } }],
  };
}

export async function attachSkill(tx: Tx, a: Actor, id: string, skillId: string, attach: boolean): Promise<Cmd> {
  const row = await lock(tx, a.orgId, id);
  const sk = (await tx.query<{ name: string }>(`select name from skills where org_id = $1 and id = $2`, [a.orgId, skillId])).rows[0];
  if (!sk) throw notFound("No such skill.");
  const cur = (await attachedSkills(tx, a.orgId, id)).map((s) => s.skill_id);
  const has = cur.includes(skillId);
  if (attach === has) return { msg: `${sk.name} is ${has ? "already attached to" : "not attached to"} ${row.name}.`, events: [], changes: [], project: null, extra: { skills: cur } };
  const list = attach ? [...cur, skillId] : cur.filter((s) => s !== skillId);
  const r = await saveAgent(tx, a, id, { skills: list }, `${attach ? "attached" : "detached"} ${sk.name}`);
  return { ...r, msg: `${attach ? "Attached" : "Detached"} ${sk.name}${attach ? " to " : " from "}${row.name}.`, extra: { skills: list } };
}

export { AUTONOMY_LEVELS };

/* ---------------------------------------------------------------- factory base instructions */

export async function baseInstructions(db: Pick<Tx, "query">, orgId: string): Promise<{ base: string; baseVersion: number }> {
  const r = (await db.query<{ version: number; body: string }>(`select version, body from instruction_versions where org_id = $1 and scope = 'base' and scope_id = '' and published_at is not null order by version desc limit 1`, [orgId])).rows[0];
  return { base: r?.body ?? "", baseVersion: r?.version ?? 0 };
}

export async function saveInstructions(tx: Tx, a: Actor, text: string): Promise<Cmd> {
  const t = text.trim();
  if (t.length < 20) throw invalid("Base instructions need at least 20 characters.");
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`instructions:${a.orgId}:base`]);
  const cur = await baseInstructions(tx, a.orgId);
  if (cur.base === t) throw conflict("That is already the current base instructions.");
  const next = cur.baseVersion + 1;
  await tx.query(`insert into instruction_versions (org_id, scope, scope_id, version, body, hash, note, published_at, published_by) values ($1,'base','',$2,$3,$4,'',now(),$5)`, [a.orgId, next, t, sha256(t), a.id]);
  return {
    msg: `Factory base saved as v${next}.`, changes: ["instructions", "agents", "audit"], project: null, extra: { version: next, baseVersion: next },
    events: [{ type: "agent.instructions", category: cat, subject: { type: "instructions", id: "base" }, projectId: null, before: { version: cur.baseVersion, text: cur.base }, after: { version: next, text: t, hash: sha256(t) } }],
  };
}
