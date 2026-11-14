/**
 * Trust commands (spec 8.7, 13.3). Each runs inside `command()`: the decision point, state and event in one transaction, a denial audited.
 * Only a permitted person grants or demotes (I6: no agent route reaches here), always with a reason. Levels above L1 need the runtime switch; L4 cannot be granted.
 */
import type { Tx } from "@gantry/db";
import { trustAgentFor, trustCellId, type TrustCeiling } from "@gantry/domain";
import type { z } from "zod";
import type { Actor, CommandResult, EventSpec } from "../../core/command.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { policyProjects } from "../../core/read/state.js";
import { readCatalog } from "../../core/read/index.js";
import { levelsAboveL1, lvlCode, lvlNum, MAX_GRANTABLE, publishCriteria, readCriteria, setLevelsAboveL1 } from "./config.js";
import { applyLevel, ceilingFor, demoteForOutcome, ensureCell, outcomeDbKind } from "./record.js";
import type { CriteriaBody, DecideBody, GrantBody, OutcomeBody } from "./schemas.js";
import { cellRows, ceilingRows, proposalRows, toCeiling, type CellRow } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;
const json = (v: unknown): string => JSON.stringify(v);
const subject = (type: string, id: string) => ({ type, id });
const ceilText = (cs: Array<{ id: string; text: string }>): string => cs.map((c) => `${c.id} (${c.text})`).join(", ");

/** The project a grant target belongs to, for the decision point's scope. */
export async function targetProject(db: Tx | import("pg").Pool, orgId: string, target: z.infer<typeof GrantBody>["target"] | string): Promise<string | null> {
  if (typeof target !== "string") return target.project;
  const r = (await db.query<{ project_id: string | null }>(`select project_id from trust_cells where org_id = $1 and id = $2`, [orgId, target])).rows[0];
  return r?.project_id ?? null;
}

async function gateOf(tx: Tx, orgId: string, agent: string): Promise<string | null> {
  const catalog = await readCatalog(tx, orgId);
  return catalog.gates.find((g) => g.id !== "G0G1" && trustAgentFor({ catalog }, g.id) === agent)?.id ?? null;
}

async function ceilingOf(tx: Tx, orgId: string, c: { project: string; cls: string; agent: string }): Promise<{ max: number; ceilings: TrustCeiling[] }> {
  const proj = (await policyProjects(tx, orgId)).find((p) => p.id === c.project);
  return ceilingFor((await ceilingRows(tx, orgId)).map(toCeiling), { regulated: !!proj?.regulated, cls: c.cls, project: c.project, gate: await gateOf(tx, orgId, c.agent) });
}

/** The refusals every level change shares: the switch, L4, the ceiling. */
async function checkLevel(tx: Tx, orgId: string, c: { project: string; cls: string; agent: string }, level: number): Promise<void> {
  if (level > MAX_GRANTABLE) throw refuse("denied", "L4 (unattended including release) cannot be granted in this version. Use L3.", { rule: { kind: "invariant", id: "TRUST-L4", name: "L4 is not grantable" } });
  if (level > 1 && !(await levelsAboveL1(tx, orgId))) {
    throw refuse("denied", `Trust levels above L1 are switched off, so ${lvlCode(level)} cannot be granted yet.`, { needs: "Turn on trust levels above L1 in the policy", rule: { kind: "switch", id: "TRUST-SWITCH", name: "Trust levels above L1 are off" } });
  }
  const ceil = await ceilingOf(tx, orgId, c);
  if (level > ceil.max) throw conflict(`Capped at ${lvlCode(ceil.max)} by ${ceilText(ceil.ceilings)}.`);
}

/** grantTrust: set a cell's level (creating the cell when the agent, class and project have none yet). */
export async function grantTrust(tx: Tx, a: Actor, b: z.infer<typeof GrantBody>): Promise<Cmd> {
  const existing = typeof b.target === "string" ? (await cellRows(tx, a.orgId, b.target, true))[0] : (await cellRows(tx, a.orgId, trustCellId(b.target.agent, b.target.cls, b.target.project, b.target.repo ?? null), true))[0];
  if (typeof b.target === "string" && !existing) throw notFound("No such trust cell.");
  const spec = existing ? { agent: existing.agent_id ?? "", cls: existing.class ?? "", project: existing.project_id ?? "", repo: existing.repo_id } : { agent: (b.target as { agent: string }).agent, cls: (b.target as { cls: string }).cls, project: (b.target as { project: string }).project, repo: (b.target as { repo?: string | null }).repo ?? null };
  if (b.reason.length < 4) throw invalid("Give a reason for the change.");
  if (!existing) {
    if (!(await gateOf(tx, a.orgId, spec.agent))) throw invalid("That agent does not staff a station before a human gate, so it has no trust level.");
    const known = (await tx.query(`select 1 from agents a where a.org_id = $1 and a.id = $2`, [a.orgId, spec.agent])).rowCount && (await readCatalog(tx, a.orgId)).classes.some((c) => c.id === spec.cls) && (await policyProjects(tx, a.orgId)).some((p) => p.id === spec.project);
    if (!known) throw invalid("Pick an agent, a work class and a project.");
  }
  const cell: CellRow = existing ?? (await ensureCell(tx, a.orgId, spec, a.id, a.now, "Cell created"));
  const from = lvlNum(cell.level);
  if (b.level === from) throw conflict(`${cell.id} is already ${lvlCode(b.level)}.`);
  await checkLevel(tx, a.orgId, spec, b.level);
  const ev = await applyLevel(tx, a.orgId, cell, b.level, { kind: b.level > from ? "grant" : "demote", reason: b.reason, by: a.id }, a.now);
  return { msg: `${cell.id.replaceAll("|", " · ")} is now ${lvlCode(b.level)}.`, events: [{ ...ev, ...(ev.type === "trust.demote" ? { type: "trust.grant", outcome: "ok" as const } : {}) }], changes: ["trust", "audit"], project: cell.project_id, extra: { cell: cell.id, level: b.level } };
}

/** demoteTrust: a person lowers a cell. Goes through the same checks as grantTrust. */
export async function demoteTrust(tx: Tx, a: Actor, cellId: string, to: number, reason: string): Promise<Cmd> {
  const cell = (await cellRows(tx, a.orgId, cellId, true))[0];
  if (!cell) throw notFound("No such cell.");
  if (to >= lvlNum(cell.level)) throw conflict("Demotion goes down a level.");
  if (reason.trim().length < 4) throw invalid("Give a reason for the change.");
  const ev = await applyLevel(tx, a.orgId, cell, to, { kind: "demote", reason: reason.trim(), by: a.id }, a.now);
  return { msg: `${cell.id.replaceAll("|", " · ")} is now ${lvlCode(to)}.`, events: [{ ...ev, type: "trust.demote", outcome: "ok" }], changes: ["trust", "audit"], project: cell.project_id, extra: { cell: cell.id, level: to } };
}

/** decideTrustProposal: a permitted person approves or declines a promotion the system proposed. Both need a reason. */
export async function decideTrustProposal(tx: Tx, a: Actor, proposalId: string, b: z.infer<typeof DecideBody>): Promise<Cmd> {
  const p = (await proposalRows(tx, a.orgId, proposalId, true))[0];
  if (!p) throw notFound("No such proposal.");
  if (p.status !== "open") throw conflict(`${p.id} is already ${p.status === "rejected" ? "declined" : p.status === "expired" ? "withdrawn" : p.status}.`);
  const cell = (await cellRows(tx, a.orgId, p.cell_id, true))[0];
  if (!cell) throw notFound("The cell is gone.");
  const reason = (b.reason ?? "").trim();
  if (reason.length < 4) throw invalid(b.accept ? "Give a reason for approving." : "Say why you are declining.");
  const to = lvlNum(p.proposed_level);
  const from = lvlNum(cell.level);
  const spec = { agent: cell.agent_id ?? "", cls: cell.class ?? "", project: cell.project_id ?? "" };
  const label = cell.id.replaceAll("|", " · ");
  if (!b.accept) {
    await tx.query(`update trust_proposals set status = 'rejected', decided_by = $3, decided_at = $4, evidence = evidence || $5::jsonb, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, p.id, a.id, a.now, json({ reason })]);
    return { msg: `${p.id} declined.`, events: [{ type: "trust.proposal", category: "trust", subject: subject("trust", cell.id), projectId: cell.project_id, before: { level: lvlCode(from) }, after: { proposal: p.id, decision: "declined", level: lvlCode(from), reason } }], changes: ["trust", "audit"], project: cell.project_id };
  }
  await checkLevel(tx, a.orgId, spec, to);
  await tx.query(`update trust_proposals set status = 'accepted', decided_by = $3, decided_at = $4, evidence = evidence || $5::jsonb, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, p.id, a.id, a.now, json({ reason })]);
  const ev = await applyLevel(tx, a.orgId, cell, to, { kind: "proposal", reason: `Proposal ${p.id} approved: ${reason}`, by: a.id, proposal: p.id }, a.now);
  return { msg: `${p.id} approved. ${label} is ${lvlCode(to)}.`, events: [{ ...ev, type: "trust.proposal", after: { ...(ev.after as object), decision: "approved" } }], changes: ["trust", "audit"], project: cell.project_id };
}

const CRIT_KEYS = ["cleanRuns", "evalMin", "reworkMax", "incidentsMax", "windowD"] as const;

/** setTrustCriteria: publishes the next criteria version with the change applied. Earlier versions stay, so a decision can name the criteria it was judged under. */
export async function setTrustCriteria(tx: Tx, a: Actor, b: z.infer<typeof CriteriaBody>): Promise<Cmd> {
  const keys = Object.keys(b.patch);
  if (!keys.length) throw invalid("Nothing to change.");
  const doc = await readCriteria(tx, a.orgId);
  const cur = doc.criteria[String(b.level)]!;
  const next = { ...cur, ...Object.fromEntries(CRIT_KEYS.filter((k) => b.patch[k] !== undefined).map((k) => [k, b.patch[k]])) };
  const v = await publishCriteria(tx, a.orgId, { criteria: { ...doc.criteria, [String(b.level)]: next }, sampleRate: doc.sampleRate, soakDays: doc.soakDays }, a.id, b.note ?? `${lvlCode(b.level)} criteria`);
  return { msg: `${lvlCode(b.level)} criteria saved.`, events: [{ type: "trust.criteria", category: "trust", subject: subject("trustcriteria", lvlCode(b.level)), projectId: null, before: { level: lvlCode(b.level), ...cur, version: doc.version }, after: { level: lvlCode(b.level), ...next, version: v } }], changes: ["trust", "audit"], project: null, extra: { version: v } };
}

/** setSampleRate: the L2 spot-check rate is part of the criteria version. */
export async function setSampleRate(tx: Tx, a: Actor, n: number): Promise<Cmd> {
  if (!(n >= 2 && n <= 50)) throw invalid("Sample 1 in 2 to 1 in 50.");
  const doc = await readCriteria(tx, a.orgId);
  const v = await publishCriteria(tx, a.orgId, { criteria: doc.criteria, sampleRate: n, soakDays: doc.soakDays }, a.id, `Spot-check rate 1 in ${n}`);
  return { msg: `L2 cells now sample 1 in ${n} for review.`, events: [{ type: "trust.sample", category: "trust", subject: subject("trustcriteria", "sample"), projectId: null, before: { rate: `1 in ${doc.sampleRate}`, version: doc.version }, after: { rate: `1 in ${n}`, version: v } }], changes: ["trust", "audit"], project: null, extra: { version: v } };
}

/** saveCeiling: a ceiling caps the level a cell can run at, whatever was granted. The lowest matching ceiling wins. */
export async function saveCeiling(tx: Tx, a: Actor, b: z.infer<typeof import("./schemas.js").CeilingBody>): Promise<Cmd> {
  const ex = b.id ? (await ceilingRows(tx, a.orgId, b.id, true))[0] : undefined;
  if (b.id && !ex) throw notFound("No such ceiling.");
  if (b.when.project && !(await policyProjects(tx, a.orgId)).some((p) => p.id === b.when.project)) throw invalid("No such project.");
  const id = ex?.id ?? `CEIL-${Number((await tx.query<{ n: string }>(`select (coalesce(max(substring(id from 6)::int), 0) + 1)::text as n from trust_ceilings where org_id = $1 and id ~ '^CEIL-[0-9]+$'`, [a.orgId])).rows[0]!.n)}`;
  const when = { ...(b.when.regulated ? { regulated: true } : {}), ...(b.when.cls ? { cls: b.when.cls } : {}), ...(b.when.project ? { project: b.when.project } : {}), ...(b.when.gate ? { gate: b.when.gate } : {}) };
  const rec = { id, text: b.text, when, max: b.max, enabled: b.enabled };
  if (ex) await tx.query(`update trust_ceilings set reason = $3, max_level = $4, enabled = $5, data = $6::jsonb, set_by = $7, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, b.text, lvlCode(b.max), b.enabled, json({ when }), a.id]);
  else await tx.query(`insert into trust_ceilings (org_id, id, scope_type, scope_id, max_level, reason, set_by, enabled, data) values ($1,$2,'rule','',$3,$4,$5,$6,$7::jsonb)`, [a.orgId, id, lvlCode(b.max), b.text, a.id, b.enabled, json({ when })]);
  return { msg: `${id} saved.`, events: [{ type: "trust.ceiling", category: "trust", subject: subject("ceiling", id), projectId: null, before: ex ? toCeiling(ex) : null, after: rec }], changes: ["trust", "audit"], project: null, extra: { ceiling: rec } };
}

export async function removeCeiling(tx: Tx, a: Actor, id: string): Promise<Cmd> {
  const ex = (await ceilingRows(tx, a.orgId, id, true))[0];
  if (!ex) throw notFound("No such ceiling.");
  await tx.query(`delete from trust_ceilings where org_id = $1 and id = $2`, [a.orgId, id]);
  return { msg: `${id} removed.`, events: [{ type: "trust.ceiling", category: "trust", subject: subject("ceiling", id), projectId: null, before: toCeiling(ex), after: null }], changes: ["trust", "audit"], project: null };
}

/** The runtime switch (spec 15.3). Turning it off does not change a cell's recorded level: it only stops anything above L1 from acting. */
export async function setTrustSwitch(tx: Tx, a: Actor, on: boolean, reason: string | undefined): Promise<Cmd> {
  const was = await levelsAboveL1(tx, a.orgId);
  if (was === on) throw conflict(`Trust levels above L1 are already ${on ? "on" : "off"}.`);
  if (on && (reason ?? "").trim().length < 4) throw invalid("Give a reason for turning trust levels above L1 on.");
  await setLevelsAboveL1(tx, a.orgId, on);
  return { msg: on ? "Trust levels above L1 are on: cells at L2 and L3 now pass gates under trust." : "Trust levels above L1 are off: every gate waits for a person again.", events: [{ type: "trust.switch", category: "trust", subject: subject("trust", "levelsAboveL1"), projectId: null, before: { on: was }, after: { on, ...(reason ? { reason: reason.trim() } : {}) } }], changes: ["trust", "audit"], project: null, extra: { on } };
}

/**
 * Outcome after release (spec 13.1): recorded on the shipped work order with who set it and what it is attributed to. An attributed revert or incident
 * drops the agent's cells for that class and project to L1 at once. A follow-up is only a record here.
 */
export async function recordOutcomeTrust(tx: Tx, a: Actor, woId: string, b: z.infer<typeof OutcomeBody>): Promise<Cmd> {
  const w = (await tx.query<{ id: string; state: string; project_id: string; class: string }>(`select id, state, project_id, class from work_orders where org_id = $1 and id = $2 and source <> 'eval' for update`, [a.orgId, woId])).rows[0];
  if (!w) throw notFound("No such work order.");
  if (w.state !== "done") throw conflict(`${woId} has not shipped, so there is no post-release outcome to record.`);
  const att = typeof b.attribution === "string" ? { kind: b.attribution, station: b.station ?? null, agent: null as string | null } : { kind: b.attribution && (b.attribution.agent || b.attribution.station) ? "agent" : null, station: b.attribution?.station ?? b.station ?? null, agent: b.attribution?.agent ?? null };
  const catalog = await readCatalog(tx, a.orgId);
  const agent = att.agent ?? (att.station ? catalog.stations.find((s) => s.id === att.station)?.agent ?? null : null);
  const id = `OUT-${woId}-${Number((await tx.query<{ n: string }>(`select (count(*) + 1)::text as n from outcomes where org_id = $1 and wo_id = $2`, [a.orgId, woId])).rows[0]!.n)}`;
  await tx.query(`insert into outcomes (org_id, id, wo_id, kind, recorded_by, note, at, attribution, station, data) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [
    a.orgId, id, woId, outcomeDbKind(b.kind), a.id, b.text, a.now, att.kind, att.station, json({ severity: b.severity ?? null, agent, ...(b.followupTitle ? { followupTitle: b.followupTitle } : {}) }),
  ]);
  const events: EventSpec[] = [{ type: "outcome.recorded", category: "flow", subject: subject("wo", woId), projectId: w.project_id, woId, after: { outcome: id, kind: b.kind, attribution: att.kind, station: att.station, agent, text: b.text }, outcome: b.kind === "followup" ? "ok" : "regression" }];
  let dropped: string[] = [];
  if (b.kind === "revert" || b.kind === "incident") dropped = await demoteForOutcome(tx, a.orgId, { woId, kind: b.kind, attribution: att.kind, agent }, a.now, (e) => events.push(e));
  return {
    msg: dropped.length ? `Outcome recorded on ${woId}. ${dropped.length} trust cell${dropped.length === 1 ? "" : "s"} dropped to L1.` : `Outcome recorded on ${woId}.`,
    events, changes: ["trust", "workOrders", "learning", "audit"], project: w.project_id, extra: { outcome: id, demoted: dropped },
  };
}
