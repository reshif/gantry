/**
 * Trust recording and enforcement (spec 13.3), called from the flow engine in its own transaction and from the commands.
 *
 * Evidence is recorded as it happens: a gate decision stores the trust level in force and the grant it came from, and when a work order finishes its
 * cells are looked at. Demotion is automatic and immediate. A promotion is only ever proposed here; a permitted person grants it with a reason.
 * L0 and L1 are enforced (a person decides every gate). L2 and L3 are built but switched off (`levelsAboveL1`). L4 is not grantable.
 */
import { randomBytes, randomInt } from "node:crypto";
import type { Tx } from "@gantry/db";
import { trust, trustAgentFor, trustCellId, type Catalog, type TrustCeiling } from "@gantry/domain";
import type { EventSpec } from "../../core/command.js";
import { policyProjects } from "../../core/read/state.js";
import { readCatalog } from "../../core/read/index.js";
import { DEFAULT_SAMPLE_RATE, PROBATION_RUNS, probationCap, probationOf, lvlCode, lvlNum, MAX_GRANTABLE, PROPOSAL_CAP, PROPOSAL_DAY, REPROPOSE_MS, levelsAboveL1, readCriteria } from "./config.js";
import { cellRows, ceilingRows, loadInsight, toCeiling, type CellRow } from "./store.js";

/** Gates a person always decides, whatever a cell has earned: the brief, plan and security (G3+G3s), the merge itself (first version), and release confirmation (needs L4, which nobody can be granted). */
export const NEVER_AUTOMATIC_GATES: ReadonlySet<string> = new Set(["G0G1", "G3G3s", "G5", "G6"]);
/** Where a work order's text came from, when it was written outside the organisation (spec 13.3 "never automatic"). */
const EXTERNAL_SOURCES: ReadonlySet<string> = new Set(["issue", "comment", "ci", "public", "api", "email", "webhook", "trigger"]);

const json = (v: unknown): string => JSON.stringify(v);

export type Sink = (e: EventSpec) => void;

/** The ceilings that apply to (project, class, gate): the lowest maximum wins. */
export function ceilingFor(ceilings: Array<TrustCeiling & { version?: number }>, o: { regulated: boolean; cls: string; project: string; gate: string | null }): { max: number; ceilings: TrustCeiling[] } {
  const hits = ceilings.filter((c) => c.enabled !== false && (!c.when.regulated || o.regulated) && (!c.when.cls || c.when.cls === o.cls) && (!c.when.project || c.when.project === o.project) && (!c.when.gate || c.when.gate === o.gate));
  return { max: hits.reduce((m, c) => Math.min(m, c.max), 4), ceilings: hits };
}

export interface InForce {
  agent: string | null;
  cellId: string | null;
  grantId: string | null;
  granted: number;
  ceiling: number;
  ceilingIds: string[];
  /** What the gate runs at: the grant capped by ceilings, and by 1 while levels above L1 are switched off. */
  effective: number;
  switchOn: boolean;
  /** Set while the cell runs one level lower after an agent version change (spec 13.3). */
  probation: { runsLeft: number; kind: string; fromVersion: string | null; toVersion: string | null } | null;
}

/** The trust level in force for a work order at a gate (spec 13.1 "trust level in force"): its repo cell, else its project cell, else L1. */
export async function trustInForce(tx: Tx, orgId: string, catalog: Catalog, o: { gateId: string; cls: string; project: string; repo: string | null }): Promise<InForce> {
  const agent = trustAgentFor({ catalog }, o.gateId);
  const switchOn = await levelsAboveL1(tx, orgId);
  const none: InForce = { agent, cellId: null, grantId: null, granted: 1, ceiling: 4, ceilingIds: [], effective: 1, switchOn, probation: null };
  if (!agent) return none;
  const ids = [o.repo ? trustCellId(agent, o.cls, o.project, o.repo) : null, trustCellId(agent, o.cls, o.project)].filter((x): x is string => !!x);
  const cell = (await cellRows(tx, orgId)).filter((c) => ids.includes(c.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))[0];
  const proj = (await policyProjects(tx, orgId)).find((p) => p.id === o.project);
  const ceil = ceilingFor((await ceilingRows(tx, orgId)).map(toCeiling), { regulated: !!proj?.regulated, cls: o.cls, project: o.project, gate: o.gateId });
  const granted = cell ? lvlNum(cell.level) : 1;
  const grant = cell ? (await tx.query<{ id: string }>(`select id from trust_grants where org_id = $1 and cell_id = $2 and revoked_at is null order by created_at desc limit 1`, [orgId, cell.id])).rows[0] : undefined;
  const prob = cell ? probationOf(cell.data) : null;
  const capped = Math.min(granted, ceil.max, MAX_GRANTABLE, prob ? probationCap(granted) : 4);
  return { agent, cellId: cell?.id ?? null, grantId: grant?.id ?? null, granted, ceiling: ceil.max, ceilingIds: ceil.ceilings.map((c) => c.id), effective: switchOn ? capped : Math.min(capped, 1), switchOn, probation: prob ? { runsLeft: prob.runsLeft, kind: prob.kind, fromVersion: prob.fromVersion, toVersion: prob.toVersion } : null };
}

/* ------------------------------------------------------------------------------------------- cells and levels */

export async function ensureCell(tx: Tx, orgId: string, c: { agent: string; cls: string; project: string; repo?: string | null }, by: string, now: Date, reason = "First reviewed decision recorded", level = 1): Promise<CellRow> {
  const id = trustCellId(c.agent, c.cls, c.project, c.repo ?? null);
  const have = (await cellRows(tx, orgId, id, true))[0];
  if (have) return have;
  const station = (await tx.query<{ station: string | null }>(`select station from agents where org_id = $1 and id = $2`, [orgId, c.agent])).rows[0]?.station ?? "";
  await tx.query(`insert into trust_cells (org_id, id, project_id, repo_id, station, class, agent_id, level, data) values ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)`, [orgId, id, c.project, c.repo ?? null, station, c.cls, c.agent, lvlCode(level)]);
  await tx.query(`insert into trust_grants (org_id, id, cell_id, level, granted_by, evidence, valid_from) values ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [orgId, `TG-${id}-1`, id, lvlCode(level), by, json({ kind: "seed", from: null, reason }), now]);
  return (await cellRows(tx, orgId, id))[0]!;
}

export interface LevelChange { kind: "grant" | "demote" | "proposal"; reason: string; by: string; cause?: { type: string; wo?: string } | null; proposal?: string }

/** Moves a cell to a level: the old grant is revoked and a new one recorded with its reason, pending proposals for the cell are withdrawn. Returns the event. */
export async function applyLevel(tx: Tx, orgId: string, cell: CellRow, to: number, c: LevelChange, now: Date): Promise<EventSpec> {
  const from = lvlNum(cell.level);
  const n = Number((await tx.query<{ n: string }>(`select (count(*) + 1)::text as n from trust_grants where org_id = $1 and cell_id = $2`, [orgId, cell.id])).rows[0]!.n);
  await tx.query(`update trust_grants set revoked_at = $3, updated_at = now() where org_id = $1 and cell_id = $2 and revoked_at is null`, [orgId, cell.id, now]);
  await tx.query(`insert into trust_grants (org_id, id, cell_id, level, granted_by, evidence, valid_from) values ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [
    orgId, `TG-${cell.id}-${n}`, cell.id, lvlCode(to), c.by, json({ kind: c.kind === "proposal" ? "grant" : c.kind, from, reason: c.reason, ...(c.cause ? { cause: c.cause } : {}), ...(c.proposal ? { proposal: c.proposal } : {}) }), now,
  ]);
  // Any level change, a demotion or a person's regrant, is a fresh decision on the evidence: a version-change probation marker does not outlive it (S-39).
  await tx.query(`update trust_cells set level = $3, data = data - 'probation', version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [orgId, cell.id, lvlCode(to)]);
  await tx.query(`update trust_proposals set status = 'expired', evidence = evidence || $3::jsonb, updated_at = now() where org_id = $1 and cell_id = $2 and status = 'open'`, [
    orgId, cell.id, json({ reason: c.kind === "demote" && c.by === "system" ? "Withdrawn by automatic demotion" : "Superseded by a direct change" }),
  ]);
  return {
    type: c.kind === "demote" ? "trust.demote" : "trust.grant", category: "trust", subject: { type: "trust", id: cell.id }, projectId: cell.project_id,
    before: { level: lvlCode(from) }, after: { level: lvlCode(to), reason: c.reason, ...(c.cause ? { cause: c.cause } : {}), ...(c.proposal ? { proposal: c.proposal } : {}) }, ...(c.kind === "demote" ? { outcome: "regression" as const } : {}),
  };
}

/**
 * Spec 13.3 "Version change": a new agent version, or a rollback to an older one, runs one level lower for a probation period. Every cell of the agent above L1
 * gets a probation marker; the level in force drops one (never below L1) until PROBATION_RUNS finished runs pass without a demotion. The grant itself is kept.
 */
export async function startProbation(tx: Tx, orgId: string, agentId: string, v: { kind: "promote" | "rollback"; fromVersion: string | null; toVersion: string | null; by: string }, now: Date): Promise<EventSpec[]> {
  const events: EventSpec[] = [];
  for (const c of (await cellRows(tx, orgId)).filter((x) => x.agent_id === agentId && lvlNum(x.level) >= 2)) {
    const marker = { since: now.toISOString(), fromVersion: v.fromVersion, toVersion: v.toVersion, kind: v.kind, runsLeft: PROBATION_RUNS };
    await tx.query(`update trust_cells set data = data || jsonb_build_object('probation', $3::jsonb), version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [orgId, c.id, json(marker)]);
    events.push({ type: "trust.probation", category: "trust", subject: { type: "trust", id: c.id }, projectId: c.project_id, before: { level: c.level }, after: { granted: c.level, runsAt: lvlCode(probationCap(lvlNum(c.level))), runs: PROBATION_RUNS, reason: `${v.kind === "rollback" ? "Rolled back to" : "Promoted"} ${v.toVersion ?? "a new version"}: runs one level lower for ${PROBATION_RUNS} clean runs (spec 13.3).`, ...marker } });
  }
  return events;
}

/* ------------------------------------------------------------------------------------------- auto pass (L2 and L3) */

export interface AutoPass { auto: boolean; level: number; grantId: string | null; cellId: string | null; sampled: boolean; reason: string }

const externalText = (source: string, data: Record<string, unknown>): boolean => data.externalText === true || EXTERNAL_SOURCES.has(source);

/**
 * Should this gate pass without a person? Never for the brief, the merge or release, a risk-tagged change, or a work order carrying text from outside the
 * organisation. L3 passes within guardrails, still reviewing a random sample (at least 1 in 10). L2 reviews a random sample (the configured rate).
 * The draw is made now, after the run finished, and recorded (spec 13.3). Everything above L1 is off until the switch is turned on.
 */
export async function trustDecision(tx: Tx, orgId: string, catalog: Catalog, o: { woId: string; gateId: string; instance: string; cls: string; project: string; repo: string | null; source: string; data: Record<string, unknown>; riskTags: readonly string[]; guardrailBreach: boolean; now: Date; /** Test seam: the random draw. Production draws with the platform's random source. */ draw?: (rate: number) => boolean }): Promise<AutoPass> {
  const level = await trustInForce(tx, orgId, catalog, o);
  const no = (reason: string, sampled = false): AutoPass => ({ auto: false, level: level.effective, grantId: level.grantId, cellId: level.cellId, sampled, reason });
  if (NEVER_AUTOMATIC_GATES.has(o.gateId)) return no(o.gateId === "G6" ? "Release confirmation needs L4, which cannot be granted in this version." : "A person always decides this gate.");
  if (!level.switchOn) return no("Trust levels above L1 are switched off.");
  if (level.effective < 2) return no(`${lvlCode(level.effective)}: a person approves.${level.granted > level.effective ? ` Capped by ${level.ceilingIds.join(", ")}.` : ""}`);
  if (o.riskTags.length) return no(`Risk-tagged change (${o.riskTags.join(", ")}): a person must approve.`);
  if (externalText(o.source, o.data)) return no("This work order carries text written outside the organisation: a person must approve.");
  if (o.guardrailBreach) return no("Guardrail breach: a person must approve.");
  const doc = await readCriteria(tx, orgId);
  const rate = level.effective >= 3 ? Math.min(doc.sampleRate, 10) : doc.sampleRate || DEFAULT_SAMPLE_RATE;
  const seed = randomBytes(8).toString("hex");
  const sampled = o.draw ? o.draw(rate) : randomInt(rate) === 0;
  await tx.query(`insert into sampling_draws (org_id, id, cell_id, wo_id, gate_instance_id, seed, drawn, rate, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`, [orgId, `SD-${o.instance}`, level.cellId, o.woId, o.instance, seed, sampled, rate, o.now]);
  if (sampled) return { auto: false, level: level.effective, grantId: level.grantId, cellId: level.cellId, sampled: true, reason: `${lvlCode(level.effective)} spot check: sampled for review (1 in ${rate}).` };
  return { auto: true, level: level.effective, grantId: level.grantId, cellId: level.cellId, sampled: false, reason: `${lvlCode(level.effective)}: not sampled this time (1 in ${rate} are reviewed).` };
}

/** The risk-tagged and external-text facts of a work order row, for the engine. */
export const autoFacts = (w: { source: string; data: Record<string, unknown> }): { source: string; data: Record<string, unknown> } => ({ source: w.source, data: w.data });

/* ------------------------------------------------------------------------------------------- evidence to cells */

/**
 * A work order finished: make sure each cell it went through exists, apply automatic demotion (two failures in the last ten reviewed runs; an attributed
 * revert or incident arrives through `recordOutcomeTrust`), and propose a promotion when the next level's criteria are met. Proposals need the switch on.
 */
export async function afterFinish(tx: Tx, orgId: string, woId: string, now: Date, sink: Sink): Promise<void> {
  const wo = (await tx.query<{ project_id: string; class: string; repo_id: string | null; source: string }>(`select project_id, class, repo_id, source from work_orders where org_id = $1 and id = $2`, [orgId, woId])).rows[0];
  if (!wo || wo.source === "eval") return;
  const catalog = await readCatalog(tx, orgId);
  const gates = (await tx.query<{ gate_id: string }>(`select distinct i.gate_id from gate_decisions d join gate_instances i on i.org_id = d.org_id and i.id = d.gate_instance_id where d.org_id = $1 and d.wo_id = $2 and d.decided_by is not null`, [orgId, woId])).rows
    .map((r) => r.gate_id).filter((g) => g !== "G0G1");
  const agents = [...new Set(gates.map((g) => trustAgentFor({ catalog }, g)).filter((a): a is string => !!a))];
  if (!agents.length) return;
  for (const agent of agents) await ensureCell(tx, orgId, { agent, cls: wo.class, project: wo.project_id }, "system", now);
  const res = await evaluateCells(tx, orgId, { project: wo.project_id, cls: wo.class, agents }, now, sink);
  // A finished run that did not demote its cell counts toward the end of its probation; a demotion resets the cell's evidence, so it ends it.
  // Every cell in force for the agent and scope counts: the project cell and the repo cell of this work order (S-38).
  const inScope = (await cellRows(tx, orgId, undefined, true)).filter((c) => !!c.agent_id && agents.includes(c.agent_id) && c.project_id === wo.project_id && c.class === wo.class && (c.repo_id === null || c.repo_id === wo.repo_id));
  for (const row of inScope) {
    const prob = row ? probationOf(row.data) : null;
    if (!prob) continue;
    const left = lvlNum(row.level) < 2 || res.demoted > 0 ? 0 : prob.runsLeft - 1;
    if (left > 0) await tx.query(`update trust_cells set data = jsonb_set(data, '{probation,runsLeft}', to_jsonb($3::int)), updated_at = now() where org_id = $1 and id = $2`, [orgId, row.id, left]);
    else {
      await tx.query(`update trust_cells set data = data - 'probation', version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [orgId, row.id]);
      sink({ type: "trust.probation.end", category: "trust", subject: { type: "trust", id: row.id }, projectId: row.project_id, after: { level: row.level, reason: left === 0 && lvlNum(row.level) >= 2 && res.demoted === 0 ? `${PROBATION_RUNS} clean runs: probation over.` : "Probation ended by a demotion." } });
    }
  }
}

/** Looks at the cells of one project (and class and agents, when given): demotes where the rule says so and proposes promotions. */
export async function evaluateCells(tx: Tx, orgId: string, o: { project: string; cls?: string; agents?: readonly string[] }, now: Date, sink: Sink): Promise<{ demoted: number; proposed: number }> {
  const ins = await loadInsight(tx, orgId, { projects: [o.project] }, now);
  const out = { demoted: 0, proposed: 0 };
  const cells = ins.state.trust.cells.filter((c) => c.project === o.project && (!o.cls || c.cls === o.cls) && (!o.agents || o.agents.includes(c.agent)));
  const open = ins.proposals.filter((p) => p.status === "open").length;
  const today = ins.proposals.filter((p) => !(p.evidence as { manual?: boolean }).manual && now.getTime() - p.created_at.getTime() < 86_400_000).length;
  let pendingNow = open;
  let madeToday = today;
  for (const cell of cells) {
    const row = ins.cells.find((c) => c.id === cell.id)!;
    const dem = trust.demotion(ins.state, cell);
    if (dem && dem.to < cell.level) {
      sink(await applyLevel(tx, orgId, row, dem.to, { kind: "demote", reason: dem.reason, by: "system", cause: dem.cause }, now));
      out.demoted++;
      continue;
    }
    if (!ins.switchOn || cell.level >= MAX_GRANTABLE) continue;
    const m = trust.meets(ins.state, cell, { strict: true, now: now.getTime(), soakDays: ins.doc.soakDays });
    if (!m.ok || !m.next || m.next > MAX_GRANTABLE) continue;
    const mine = ins.proposals.filter((p) => p.cell_id === cell.id);
    const recent = mine.some((p) => p.status === "open" || now.getTime() - (p.decided_at ?? p.created_at).getTime() < REPROPOSE_MS);
    if (recent || pendingNow >= PROPOSAL_CAP || madeToday >= PROPOSAL_DAY) continue;
    const n = Number((await tx.query<{ n: string }>(`select (coalesce(max(substring(id from 4)::int), 0) + 1)::text as n from trust_proposals where org_id = $1 and id ~ '^TP-[0-9]+$'`, [orgId])).rows[0]!.n);
    const ev = m.evidence!;
    const saved = trust.projection(ins.state, cell, m.next, now.getTime());
    const id = `TP-${n}`;
    await tx.query(`insert into trust_proposals (org_id, id, cell_id, proposed_level, status, evidence) values ($1,$2,$3,$4,'open',$5::jsonb)`, [
      orgId, id, cell.id, lvlCode(m.next), json({ from: cell.level, cleanRuns: ev.cleanRuns, evalScore: ev.evalScore, note: `Met the ${lvlCode(m.next)} criteria with no incidents in the window.`, savedPerWeek: saved, runs: ev.runs }),
    ]);
    sink({ type: "trust.propose", category: "trust", subject: { type: "trust", id: cell.id }, projectId: cell.project, after: { proposal: id, from: lvlCode(cell.level), to: lvlCode(m.next), cleanRuns: ev.cleanRuns, runs: ev.runs } });
    out.proposed++;
    pendingNow++;
    madeToday++;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- outcomes and breaches */

export type OutcomeKind = "revert" | "incident" | "followup" | "healthy";
const DB_KIND: Record<OutcomeKind, string> = { revert: "rollback", incident: "incident", followup: "followup", healthy: "healthy" };
export const outcomeDbKind = (k: OutcomeKind): string => DB_KIND[k];

/**
 * An attributed revert or incident drops every cell of the attributed agent for that class and project to L1 (spec 13.3), at once. An outcome attributed to the spec, the
 * environment or something unrelated does not. Returns the cells that dropped.
 */
export async function demoteForOutcome(tx: Tx, orgId: string, o: { woId: string; kind: "revert" | "incident"; attribution: string | null; agent: string | null }, now: Date, sink: Sink): Promise<string[]> {
  if (o.attribution !== "agent" || !o.agent) return [];
  const wo = (await tx.query<{ project_id: string; class: string }>(`select project_id, class from work_orders where org_id = $1 and id = $2`, [orgId, o.woId])).rows[0];
  if (!wo) return [];
  const hit = (await cellRows(tx, orgId, undefined, true)).filter((c) => c.project_id === wo.project_id && c.class === wo.class && c.agent_id === o.agent && lvlNum(c.level) >= 2);
  const out: string[] = [];
  for (const c of hit) {
    sink(await applyLevel(tx, orgId, c, 1, { kind: "demote", reason: `${o.kind === "revert" ? "Post-release revert" : "Post-release incident"} on ${o.woId}`, by: "system", cause: { type: o.kind, wo: o.woId } }, now));
    out.push(c.id);
  }
  return out;
}

/** A guardrail breach or a security finding drops the agent's cells for that class and project to L1 (spec 13.3). */
export async function demoteForBreach(tx: Tx, orgId: string, o: { woId: string; kind: "guardrail" | "security"; gateId: string; text: string }, now: Date, sink: Sink): Promise<string[]> {
  const wo = (await tx.query<{ project_id: string; class: string }>(`select project_id, class from work_orders where org_id = $1 and id = $2`, [orgId, o.woId])).rows[0];
  if (!wo) return [];
  const agent = trustAgentFor({ catalog: await readCatalog(tx, orgId) }, o.gateId);
  if (!agent) return [];
  const hit = (await cellRows(tx, orgId, undefined, true)).filter((c) => c.project_id === wo.project_id && c.class === wo.class && c.agent_id === agent && lvlNum(c.level) >= 2);
  const out: string[] = [];
  for (const c of hit) {
    sink(await applyLevel(tx, orgId, c, 1, { kind: "demote", reason: o.text, by: "system", cause: { type: o.kind, wo: o.woId } }, now));
    out.push(c.id);
  }
  return out;
}

/** The daily look at every project's cells: a soak period ends with no event to carry it, so promotions that became possible by the passing of time are found here. */
export async function evaluateAllTrust(tx: Tx, orgId: string, now: Date, sink: Sink): Promise<{ demoted: number; proposed: number }> {
  const projects = (await tx.query<{ project_id: string }>(`select distinct project_id from trust_cells where org_id = $1 and project_id is not null`, [orgId])).rows.map((r) => r.project_id);
  const out = { demoted: 0, proposed: 0 };
  for (const project of projects) {
    const r = await evaluateCells(tx, orgId, { project }, now, sink);
    out.demoted += r.demoted;
    out.proposed += r.proposed;
  }
  return out;
}
