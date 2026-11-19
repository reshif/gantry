/**
 * The context pin of a work order (S-143). The first dispatch of a work order writes which instruction layers (factory base, project overlay, repo guidelines)
 * and which agent versions and skill versions its stations run on; later stations, retries and send-back redos reuse it, so Spec and Build of one order are not
 * composed under different factory rules because someone published a new base in between.
 *
 * A re-pin is deliberate and recorded as `wo.context.repin` with the before and after: a person's "Refresh instructions" on the Record, or the pinned version
 * having been retired (its published row is gone or was withdrawn), in which case only the retired part moves. Nothing else changes a pin. An agent that
 * first appears in the work order (a later station) and a repository chosen after the first dispatch are added to the pin without a re-pin: nothing already
 * pinned moves.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "@gantry/db";
import { loadAgentVersion, projectInfo, resolveSkills, type InstructionPin } from "./compose.js";
import { sha256 } from "./config.js";

export interface WoContextPin {
  /** Short identity of the pinned set, shown on the Record ("ctx-1a2b3c4d5e"). */
  id: string;
  pinnedAt: string;
  base: number | null;
  project: number | null;
  /** The project overlay's text when it has no published version (a live row otherwise). */
  overlay: string | null;
  guidelines: { text: string; hash: string; commit: string | null } | null;
  /** The agent version and skill versions each agent of the work order's stations runs on, pinned at the agent's first run in this work order. */
  agents: Record<string, { version: number; skills: Record<string, number> }>;
}

/** What a repin event records: the pin without the guideline text. */
export interface PinSummary { id: string; base: number | null; project: number | null; guidelines: string | null; agents: Record<string, number> }

export const summarize = (p: WoContextPin | null): PinSummary | null =>
  p ? { id: p.id, base: p.base, project: p.project, guidelines: p.guidelines?.hash.slice(0, 12) ?? null, agents: Object.fromEntries(Object.entries(p.agents).map(([k, v]) => [k, v.version])) } : null;

const idOf = (p: Omit<WoContextPin, "id" | "pinnedAt">): string =>
  `ctx-${createHash("sha256").update(JSON.stringify([p.base, p.project, p.overlay, p.guidelines?.hash ?? null, Object.entries(p.agents).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.version, Object.entries(v.skills).sort()])])).digest("hex").slice(0, 10)}`;

const withId = (p: Omit<WoContextPin, "id">): WoContextPin => ({ ...p, id: idOf(p) });

export function parsePin(raw: unknown): WoContextPin | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<WoContextPin>;
  if (typeof p.id !== "string" || typeof p.pinnedAt !== "string" || !p.agents || typeof p.agents !== "object") return null;
  return p as WoContextPin;
}

export async function readContextPin(db: Queryable, orgId: string, woId: string): Promise<WoContextPin | null> {
  return parsePin((await db.query<{ p: unknown }>(`select data->'contextPin' as p from work_orders where org_id = $1 and id = $2`, [orgId, woId])).rows[0]?.p);
}

async function latest(db: Queryable, orgId: string, scope: "base" | "project", scopeId: string): Promise<number | null> {
  return (await db.query<{ v: number }>(`select max(version) as v from instruction_versions where org_id = $1 and scope = $2 and scope_id = $3 and published_at is not null`, [orgId, scope, scopeId])).rows[0]?.v ?? null;
}

async function stillPublished(db: Queryable, orgId: string, scope: "base" | "project", scopeId: string, version: number): Promise<boolean> {
  return (await db.query(`select 1 from instruction_versions where org_id = $1 and scope = $2 and scope_id = $3 and version = $4 and published_at is not null`, [orgId, scope, scopeId, version])).rowCount === 1;
}

async function agentPin(db: Queryable, o: { orgId: string; agentId: string; version: number; projectId: string }): Promise<WoContextPin["agents"][string] | null> {
  const av = await loadAgentVersion(db, o.orgId, o.agentId, o.version);
  if (!av) return null;
  const skills = await resolveSkills(db, { orgId: o.orgId, agentId: o.agentId, body: av.body, projectId: o.projectId, withContent: false });
  return { version: av.version, skills: Object.fromEntries(skills.map((s) => [s.id, s.version])) };
}

async function liveGuidelines(db: Queryable, orgId: string, repoId: string | null, commit: string | null): Promise<WoContextPin["guidelines"]> {
  if (!repoId) return null;
  const text = (await db.query<{ guidelines: string }>(`select guidelines from repos where org_id = $1 and id = $2`, [orgId, repoId])).rows[0]?.guidelines ?? "";
  return { text, hash: sha256(text), commit };
}

export interface ContextInput { orgId: string; woId: string; projectId: string; repoId: string | null; commit?: string | null; now: Date }

async function freshPin(db: Queryable, o: ContextInput, agents: WoContextPin["agents"]): Promise<WoContextPin> {
  const proj = await projectInfo(db, o.orgId, o.projectId);
  const project = await latest(db, o.orgId, "project", o.projectId);
  return withId({ pinnedAt: o.now.toISOString(), base: await latest(db, o.orgId, "base", ""), project, overlay: project === null ? (proj?.overlay ?? null) : null, guidelines: await liveGuidelines(db, o.orgId, o.repoId, o.commit ?? null), agents });
}

const save = async (db: Queryable, orgId: string, woId: string, pin: WoContextPin): Promise<void> => {
  // The pin is bookkeeping, not an edit a person could be racing: the row's version (If-Match) is left alone.
  await db.query(`update work_orders set data = jsonb_set(data, '{contextPin}', $3::jsonb), updated_at = now() where org_id = $1 and id = $2`, [orgId, woId, JSON.stringify(pin)]);
};

export interface ResolvedContext {
  pin: WoContextPin;
  /** The agent version this station runs: the pinned one. */
  agentVersion: number;
  skillVersions: Record<string, number>;
  /** What `pinRunConfig` composes from. */
  instructionPin: InstructionPin;
  /** Set when a pinned part was retired and moved: the caller records `wo.context.repin`. */
  repin: { before: PinSummary; after: PinSummary; reason: string } | null;
  created: boolean;
}

/**
 * The context the station about to run is composed from. Writes the pin on the work order's first dispatch and extends it for an agent or a repository it
 * has not seen yet; a part of the pin whose published version is gone is re-pinned (and reported in `repin`). Call it in the dispatch transaction.
 */
export async function resolveWoContext(db: Queryable, o: ContextInput & { agentId: string; liveVersion: number }): Promise<ResolvedContext> {
  const locked = (await db.query<{ p: unknown }>(`select data->'contextPin' as p from work_orders where org_id = $1 and id = $2 for update`, [o.orgId, o.woId])).rows[0]?.p;
  let pin = parsePin(locked);
  let created = false;
  let repin: ResolvedContext["repin"] = null;
  let dirty = false;
  if (!pin) {
    pin = await freshPin(db, o, {});
    created = true;
    dirty = true;
  } else {
    const before = summarize(pin)!;
    const retired: string[] = [];
    let next = { ...pin };
    if (pin.base !== null && !(await stillPublished(db, o.orgId, "base", "", pin.base))) {
      retired.push(`Factory base v${pin.base}`);
      next = { ...next, base: await latest(db, o.orgId, "base", "") };
    }
    if (pin.project !== null && !(await stillPublished(db, o.orgId, "project", o.projectId, pin.project))) {
      const proj = await projectInfo(db, o.orgId, o.projectId);
      retired.push(`Project overlay v${pin.project}`);
      const v = await latest(db, o.orgId, "project", o.projectId);
      next = { ...next, project: v, overlay: v === null ? (proj?.overlay ?? null) : null };
    }
    const here = pin.agents[o.agentId];
    if (here) {
      const row = (await db.query(`select 1 from agent_versions where org_id = $1 and agent_id = $2 and version = $3 and published_at is not null`, [o.orgId, o.agentId, here.version])).rowCount;
      if (!row) {
        retired.push(`${o.agentId} v${here.version}`);
        const fresh = await agentPin(db, { orgId: o.orgId, agentId: o.agentId, version: o.liveVersion, projectId: o.projectId });
        if (fresh) next = { ...next, agents: { ...next.agents, [o.agentId]: fresh } };
      }
    }
    if (retired.length) {
      pin = withId({ pinnedAt: o.now.toISOString(), base: next.base, project: next.project, overlay: next.overlay, guidelines: next.guidelines, agents: next.agents });
      repin = { before, after: summarize(pin)!, reason: `The pinned version was retired: ${retired.join(", ")}.` };
      dirty = true;
    }
  }
  // Added, not re-pinned: the repository chosen after the first dispatch, and the agent of a station that has not run yet.
  if (!pin.guidelines && o.repoId) {
    pin = withId({ ...pin, guidelines: await liveGuidelines(db, o.orgId, o.repoId, o.commit ?? null) });
    dirty = true;
  }
  if (!pin.agents[o.agentId]) {
    const fresh = await agentPin(db, { orgId: o.orgId, agentId: o.agentId, version: o.liveVersion, projectId: o.projectId });
    if (fresh) {
      pin = withId({ ...pin, agents: { ...pin.agents, [o.agentId]: fresh } });
      dirty = true;
    }
  }
  if (dirty) await save(db, o.orgId, o.woId, pin);
  const a = pin.agents[o.agentId];
  return {
    pin, agentVersion: a?.version ?? o.liveVersion, skillVersions: a?.skills ?? {},
    instructionPin: { base: pin.base, project: pin.project, agentVersion: a?.version ?? null, guidelines: pin.guidelines, overlay: pin.overlay },
    repin, created,
  };
}

/**
 * "Refresh instructions" (a person's choice on the Record): every part of the pin moves to what is published now, for the agents the work order has used. The
 * caller records `wo.context.repin` with `before` and `after`. The caller holds the work order's row lock (a command).
 */
export async function repinWoContext(db: Queryable, o: ContextInput): Promise<{ before: PinSummary | null; after: PinSummary; pin: WoContextPin }> {
  const old = await readContextPin(db, o.orgId, o.woId);
  const agents: WoContextPin["agents"] = {};
  for (const id of Object.keys(old?.agents ?? {})) {
    const live = (await db.query<{ v: number | null }>(`select live_version as v from agents where org_id = $1 and id = $2`, [o.orgId, id])).rows[0]?.v;
    const fresh = typeof live === "number" ? await agentPin(db, { orgId: o.orgId, agentId: id, version: live, projectId: o.projectId }) : null;
    if (fresh) agents[id] = fresh;
    else if (old?.agents[id]) agents[id] = old.agents[id]!;
  }
  const pin = await freshPin(db, o, agents);
  await save(db, o.orgId, o.woId, pin);
  return { before: summarize(old), after: summarize(pin)!, pin };
}
