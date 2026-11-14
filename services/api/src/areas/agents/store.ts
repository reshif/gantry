/** Agent reads: rows to the legacy `G.store.agents` shape, plus the eval promotion gate (spec 13.2). */
import { fmt, type Agent, type AgentVersion } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { cfgOf, diffKeys, initialsOf, VERSIONED_KEYS, type AgentCfg } from "./config.js";

export interface AgentRow {
  id: string;
  name: string;
  kind: string;
  station: string | null;
  status: string;
  live_version: number | null;
  data: Record<string, unknown>;
  version: number;
}
export interface VersionRow {
  version: number;
  body: Record<string, unknown>;
  model_id: string | null;
  note: string;
  published_at: Date | null;
  created_at: Date;
  published_by: string | null;
}

export const labelOf = (v: Pick<VersionRow, "version" | "body">): string => (typeof v.body.label === "string" && v.body.label ? v.body.label : `${v.version}.0.0`);

export async function agentRows(db: Queryable, orgId: string, id?: string, lock = false): Promise<AgentRow[]> {
  const { rows } = await db.query<AgentRow>(
    `select id, name, kind, station, status, live_version, data, version from agents where org_id = $1 ${id ? "and id = $2" : ""} order by created_at, id ${lock ? "for update" : ""}`,
    id ? [orgId, id] : [orgId],
  );
  return rows;
}

export async function versionRows(db: Queryable, orgId: string, agentId?: string): Promise<Array<VersionRow & { agent_id: string }>> {
  const { rows } = await db.query<VersionRow & { agent_id: string }>(
    `select agent_id, version, body, model_id, note, published_at, created_at, published_by from agent_versions where org_id = $1 ${agentId ? "and agent_id = $2" : ""} order by agent_id, version`,
    agentId ? [orgId, agentId] : [orgId],
  );
  return rows;
}

/** The ordered skill attachments of an agent. */
export async function attachedSkills(db: Queryable, orgId: string, agentId: string): Promise<Array<{ skill_id: string; pinned_version: number | null }>> {
  return (await db.query<{ skill_id: string; pinned_version: number | null }>(`select skill_id, pinned_version from agent_skills where org_id = $1 and agent_id = $2 order by position, created_at, skill_id`, [orgId, agentId])).rows;
}

export interface Eligibility {
  ok: boolean;
  text: string;
  score: number | null;
  run?: string;
  suite: string | null;
  threshold: number | null;
  /** What is missing, for the "needs" line of a refusal. */
  needs: string;
  /** How many runs of the suite name this version (any outcome). */
  runs: number;
}

/**
 * Spec 13.2: promotion of an agent version is blocked until its station suite passes. Reads the evals area's tables: the suite, and the latest completed
 * run of it for this version (a run names its version in `data.version` as the label, or points at a version tuple whose agent version it is).
 */
export async function eligibility(db: Queryable, orgId: string, a: { id: string; data: Record<string, unknown> }, v: { version: number; body: Record<string, unknown> }): Promise<Eligibility> {
  const suiteId = typeof a.data.suite === "string" ? a.data.suite : "";
  const suite = suiteId ? (await db.query<{ id: string; threshold: string | null }>(`select id, data->>'threshold' as threshold from suites where org_id = $1 and id = $2`, [orgId, suiteId])).rows[0] : undefined;
  if (!suite) return { ok: false, text: "No suite", score: null, suite: null, threshold: null, needs: "A station eval suite for this agent", runs: 0 };
  const threshold = suite.threshold !== null && !Number.isNaN(Number(suite.threshold)) ? Number(suite.threshold) : 0.85;
  const label = labelOf(v);
  const runs = Number((await db.query<{ n: string }>(
    `select count(*)::text as n from eval_runs r where r.org_id = $1 and r.suite_id = $2
        and coalesce(r.data->>'override', 'false') = 'false' and ((r.data->>'agent' = $4 and r.data->>'version' = $3) or exists (select 1 from agent_version_tuples t where t.org_id = r.org_id and t.id = r.tuple_id and t.agent_id = $4 and t.agent_version = $5))`,
    [orgId, suite.id, label, a.id, v.version],
  )).rows[0]?.n ?? 0);
  const run = (await db.query<{ id: string; score: string }>(
    `select r.id, r.score from eval_runs r
      where r.org_id = $1 and r.suite_id = $2 and r.status = 'completed' and r.score is not null
        and coalesce(r.data->>'override', 'false') = 'false' and ((r.data->>'agent' = $4 and r.data->>'version' = $3) or exists (select 1 from agent_version_tuples t where t.org_id = r.org_id and t.id = r.tuple_id and t.agent_id = $4 and t.agent_version = $5))
      order by r.started_at desc limit 1`,
    [orgId, suite.id, label, a.id, v.version],
  )).rows[0];
  if (!run) return { ok: false, text: `No run of ${suite.id} yet`, score: null, suite: suite.id, threshold, needs: `A passing run of ${suite.id}`, runs };
  const score = Number(run.score);
  const ok = score >= threshold;
  return { ok, text: `${ok ? "Eligible" : "Blocked"}: ${fmt.pct(score)} vs ${fmt.pct(threshold)} on ${suite.id}`, score, run: run.id, suite: suite.id, threshold, needs: ok ? "" : `${suite.id} at ${fmt.pct(threshold)} or better`, runs };
}

const DAY = 86_400_000;

interface Extras {
  spend: Map<string, number>;
  spark: Map<string, number[]>;
  /** Attempts running now, by the agent whose version tuple they were dispatched with. */
  running: Map<string, number>;
}

/** Spend over seven days (usage metering) and the daily share of attempts that succeeded (attempts through version tuples). */
async function extras(db: Queryable, orgId: string, now: Date): Promise<Extras> {
  const since = new Date(now.getTime() - 7 * DAY);
  const spend = new Map<string, number>();
  for (const r of (await db.query<{ agent_id: string; micros: string }>(`select agent_id, sum(cost_micros)::text as micros from usage_meter where org_id = $1 and agent_id is not null and at >= $2 group by agent_id`, [orgId, since])).rows) spend.set(r.agent_id, Number(r.micros) / 1_000_000);
  const spark = new Map<string, number[]>();
  const { rows } = await db.query<{ agent_id: string; day: number; ok: string; n: string }>(
    `select t.agent_id, floor(extract(epoch from ($2::timestamptz - a.ended_at)) / 86400)::int as day,
            count(*) filter (where a.state = 'succeeded')::text as ok, count(*)::text as n
       from attempts a join agent_version_tuples t on t.org_id = a.org_id and t.id = a.tuple_id
      where a.org_id = $1 and a.state in ('succeeded','failed') and a.ended_at >= $3 group by 1, 2`,
    [orgId, now, since],
  );
  const by = new Map<string, Map<number, [number, number]>>();
  for (const r of rows) (by.get(r.agent_id) ?? by.set(r.agent_id, new Map()).get(r.agent_id)!).set(r.day, [Number(r.ok), Number(r.n)]);
  for (const [agent, days] of by) {
    const tot = [...days.values()].reduce((s, [o, n]) => [s[0] + o, s[1] + n], [0, 0]);
    const avg = tot[1] ? tot[0] / tot[1] : 0;
    spark.set(agent, Array.from({ length: 7 }, (_, i) => { const d = days.get(6 - i); return d ? d[0] / d[1] : avg; }));
  }
  const running = new Map<string, number>();
  for (const r of (await db.query<{ agent_id: string; n: string }>(`select t.agent_id, count(*)::text as n from attempts a join agent_version_tuples t on t.org_id = a.org_id and t.id = a.tuple_id where a.org_id = $1 and a.state = 'running' group by t.agent_id`, [orgId])).rows) running.set(r.agent_id, Number(r.n));
  return { spend, spark, running };
}

export interface AgentOut extends Agent {
  /** The entity version, for If-Match. */
  rev: number;
  suiteName: string | null;
  threshold: number | null;
  /** Work orders being worked by this agent right now. */
  running: number;
  versions: Array<AgentVersion & { eligibility: Omit<Eligibility, "needs"> & { needs: string } }>;
}

function toVersion(v: VersionRow, live: boolean, promoted: Set<number>): { rc: boolean } {
  return { rc: !live && v.body.rc === true && !promoted.has(v.version) };
}

/** The agent in its legacy shape. `skills` are the working attachments in order; `version` is the label of the version on the floor. */
export async function readAgents(db: Queryable, orgId: string, id?: string, now = new Date()): Promise<AgentOut[]> {
  const agents = await agentRows(db, orgId, id);
  if (!agents.length) return [];
  const vers = await versionRows(db, orgId, id);
  const skills = (await db.query<{ agent_id: string; skill_id: string }>(`select agent_id, skill_id from agent_skills where org_id = $1 ${id ? "and agent_id = $2" : ""} order by agent_id, position, created_at, skill_id`, id ? [orgId, id] : [orgId])).rows;
  const suites = new Map((await db.query<{ id: string; name: string; threshold: string | null }>(`select id, name, data->>'threshold' as threshold from suites where org_id = $1`, [orgId])).rows.map((s) => [s.id, s]));
  const ex = await extras(db, orgId, now);
  const out: AgentOut[] = [];
  for (const a of agents) {
    const mine = vers.filter((v) => v.agent_id === a.id);
    const live = mine.find((v) => v.version === a.live_version) ?? mine[mine.length - 1];
    const promoted = new Set(Array.isArray(a.data.promoted) ? (a.data.promoted as unknown[]).filter((x): x is number => typeof x === "number") : []);
    const cfg = cfgOf(a.data, live?.model_id ?? "");
    const suite = suites.get(cfg.suite);
    const versions = [];
    for (const v of mine) {
      const isLive = v.version === a.live_version;
      const { rc } = toVersion(v, isLive, promoted);
      const el = await eligibility(db, orgId, a, v);
      const snap: Record<string, unknown> = Object.fromEntries(VERSIONED_KEYS.filter((k) => k in v.body).map((k) => [k, v.body[k]]));
      if ("tools" in snap) snap.tools = cfgOf({ tools: snap.tools }).tools;
      versions.push({
        v: labelOf(v),
        at: (v.published_at ?? v.created_at).getTime(),
        note: v.note,
        diff: typeof v.body.diff === "string" && v.body.diff ? v.body.diff : v.note,
        suiteScore: el.score ?? (typeof v.body.suiteScore === "number" ? v.body.suiteScore : 0),
        live: isLive,
        rc,
        snapshot: Object.keys(snap).length ? JSON.stringify(snap) : null,
        eligibility: { ok: el.ok, text: el.text, score: el.score, ...(el.run ? { run: el.run } : {}), suite: el.suite, threshold: el.threshold, needs: el.needs, runs: el.runs },
      });
    }
    const liveV = versions.find((v) => v.live);
    out.push({
      id: a.id, name: a.name, station: a.station, model: cfg.model, fallbacks: cfg.fallbacks, version: liveV?.v ?? "", status: a.status, autonomy: cfg.autonomy, tools: cfg.tools,
      skills: skills.filter((s) => s.agent_id === a.id).map((s) => s.skill_id), mcp: cfg.mcp, stations: cfg.stations, projects: cfg.projects, budget: cfg.budget, guardrails: cfg.guardrails,
      suite: cfg.suite, instructions: cfg.instructions, overrides: cfg.overrides, versions, spark: ex.spark.get(a.id) ?? [], spend7d: ex.spend.get(a.id) ?? 0, initials: initialsOf(a.name),
      evalScore: liveV?.suiteScore ?? 0, running: ex.running.get(a.id) ?? 0, rev: a.version, suiteName: suite?.name ?? null, threshold: suite ? (suite.threshold !== null && !Number.isNaN(Number(suite.threshold)) ? Number(suite.threshold) : 0.85) : null,
    });
  }
  return out;
}

export { diffKeys };
export type { AgentCfg };
