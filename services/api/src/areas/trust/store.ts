/** Trust rows to the legacy `G.store.trust` shapes (cells, history, proposals, ceilings), and the insight state the domain's trust functions read. */
import type { Queryable } from "@gantry/db";
import type { InsightState, Scorecard, Trust, TrustCeiling, TrustCell, TrustHistoryEntry, TrustProposal } from "@gantry/domain";
import { loadFlowState } from "../../core/read/state.js";
import { readAgents } from "../agents/store.js";
import { buildWorkOrders } from "../workorders/model.js";
import { readScorecards } from "../evals/scorecards.js";
import { levelsAboveL1, lvlNum, readCriteria, type CriteriaDoc } from "./config.js";

const ms = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : 0);

export interface CellRow {
  id: string;
  project_id: string | null;
  station: string;
  class: string | null;
  agent_id: string | null;
  repo_id: string | null;
  level: string;
  data: Record<string, unknown>;
  version: number;
  created_at: Date;
}
export interface GrantRow {
  id: string;
  cell_id: string;
  level: string;
  granted_by: string | null;
  evidence: Record<string, unknown>;
  valid_from: Date;
  revoked_at: Date | null;
  created_at: Date;
}
export interface ProposalRow {
  id: string;
  cell_id: string;
  proposed_level: string;
  status: "open" | "accepted" | "rejected" | "expired";
  evidence: Record<string, unknown>;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}
export interface CeilingRow {
  id: string;
  reason: string;
  max_level: string;
  enabled: boolean;
  data: Record<string, unknown>;
  version: number;
}

export const cellRows = async (db: Queryable, orgId: string, id?: string, lock = false): Promise<CellRow[]> =>
  (await db.query<CellRow>(
    `select id, project_id, station, class, agent_id, repo_id, level, data, version, created_at from trust_cells where org_id = $1 ${id ? "and id = $2" : ""} order by created_at, id ${lock ? "for update" : ""}`,
    id ? [orgId, id] : [orgId],
  )).rows;

export const grantRows = async (db: Queryable, orgId: string, cellId?: string): Promise<GrantRow[]> =>
  (await db.query<GrantRow>(`select id, cell_id, level, granted_by, evidence, valid_from, revoked_at, created_at from trust_grants where org_id = $1 ${cellId ? "and cell_id = $2" : ""} order by created_at, id`, cellId ? [orgId, cellId] : [orgId])).rows;

export const proposalRows = async (db: Queryable, orgId: string, id?: string, lock = false): Promise<ProposalRow[]> =>
  (await db.query<ProposalRow>(
    `select id, cell_id, proposed_level, status, evidence, decided_by, decided_at, created_at from trust_proposals where org_id = $1 ${id ? "and id = $2" : ""} order by created_at, id ${lock ? "for update" : ""}`,
    id ? [orgId, id] : [orgId],
  )).rows;

export const ceilingRows = async (db: Queryable, orgId: string, id?: string, lock = false): Promise<CeilingRow[]> =>
  (await db.query<CeilingRow>(`select id, reason, max_level, enabled, data, version from trust_ceilings where org_id = $1 ${id ? "and id = $2" : ""} order by created_at, id ${lock ? "for update" : ""}`, id ? [orgId, id] : [orgId])).rows;

export const historyOf = (grants: GrantRow[]): TrustHistoryEntry[] =>
  grants.map((g) => {
    const e = g.evidence as { kind?: string; from?: number | null; reason?: string; cause?: { type: string; wo?: string } | null; by?: string };
    return { at: ms(g.valid_from), from: typeof e.from === "number" ? e.from : null, to: lvlNum(g.level), by: g.granted_by ?? e.by ?? "system", kind: e.kind ?? "grant", reason: e.reason ?? "", ...(e.cause ? { cause: e.cause } : {}) };
  });

export function toCell(r: CellRow, grants: GrantRow[]): TrustCell {
  const mine = grants.filter((g) => g.cell_id === r.id);
  const last = mine[mine.length - 1];
  return {
    id: r.id, agent: r.agent_id ?? "", cls: r.class ?? "", project: r.project_id ?? "", repo: r.repo_id, level: lvlNum(r.level), since: ms(last?.valid_from ?? r.created_at),
    cleanRuns: 0, history: historyOf(mine),
  };
}

const PSTATUS: Record<ProposalRow["status"], string> = { open: "pending", accepted: "accepted", rejected: "declined", expired: "withdrawn" };

export function toProposal(r: ProposalRow): TrustProposal {
  const e = r.evidence as { from?: number; cleanRuns?: number; evalScore?: number; note?: string; savedPerWeek?: number; manual?: boolean; reason?: string };
  return {
    id: r.id, cell: r.cell_id, from: typeof e.from === "number" ? e.from : Math.max(0, lvlNum(r.proposed_level) - 1), to: lvlNum(r.proposed_level), at: ms(r.created_at), status: PSTATUS[r.status],
    by: r.decided_by, decidedAt: r.decided_at ? ms(r.decided_at) : null, reason: e.reason ?? "", evidence: { cleanRuns: e.cleanRuns ?? 0, evalScore: e.evalScore ?? 0, note: e.note ?? "" },
    savedPerWeek: e.savedPerWeek ?? 0, ...(e.manual ? { manual: true } : {}),
  };
}

export function toCeiling(r: CeilingRow): TrustCeiling & { version: number } {
  const when = (r.data.when ?? {}) as TrustCeiling["when"];
  return { id: r.id, text: r.reason, when: { ...(when.regulated ? { regulated: true } : {}), ...(when.cls ? { cls: when.cls } : {}), ...(when.project ? { project: when.project } : {}), ...(when.gate ? { gate: when.gate } : {}) }, max: lvlNum(r.max_level), enabled: r.enabled, version: r.version };
}

/** The ids the trust nextProposal counter in the legacy shape starts from. */
export const nextProposalNumber = (rows: ProposalRow[]): number => rows.reduce((m, r) => Math.max(m, Number(/^TP-(\d+)$/.exec(r.id)?.[1] ?? 0)), 0) + 1;

export interface Insight {
  state: InsightState;
  doc: CriteriaDoc;
  switchOn: boolean;
  cells: CellRow[];
  grants: GrantRow[];
  proposals: ProposalRow[];
  ceilings: ReturnType<typeof toCeiling>[];
}

/** The flow state, agents, scorecards and trust documents the domain's trust functions need, with the work orders of the given projects (all when none). */
export async function loadInsight(db: Queryable, orgId: string, o: { projects?: readonly string[] | null; scorecards?: Record<string, Scorecard> } = {}, now = new Date()): Promise<Insight> {
  const base = await loadFlowState(db, orgId);
  const wanted = o.projects ? base.projects.filter((p) => o.projects!.includes(p.id)) : base.projects;
  // One query at a time: this runs inside a transaction (the flow engine records evidence in its own), whose client runs a single query at once.
  const agents = await readAgents(db, orgId, undefined, now);
  const doc = await readCriteria(db, orgId);
  const switchOn = await levelsAboveL1(db, orgId);
  const cells = await cellRows(db, orgId);
  const grants = await grantRows(db, orgId);
  const proposals = await proposalRows(db, orgId);
  const ceilingDb = await ceilingRows(db, orgId);
  const scorecards = o.scorecards ?? (await readScorecards(db, orgId, now));
  const wos: Awaited<ReturnType<typeof buildWorkOrders>> = [];
  for (const p of wanted) wos.push(...(await buildWorkOrders(db, orgId, base.catalog, base.projects, { project: p.id })));
  const ceilings = ceilingDb.map(toCeiling);
  const trust: Trust = {
    sampleRate: doc.sampleRate, criteria: doc.criteria, ceilings, cells: cells.map((c) => toCell(c, grants)), proposals: proposals.map(toProposal), nextProposal: nextProposalNumber(proposals), seededAt: 0,
  };
  const state: InsightState = { ...base, workOrders: wos, teams: [], agents: agents as unknown as InsightState["agents"], scorecards, trust };
  return { state, doc, switchOn, cells, grants, proposals, ceilings };
}
