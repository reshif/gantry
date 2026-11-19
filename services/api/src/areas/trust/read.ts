/**
 * GET /trust/cells: the legacy `G.store.trust` shape, with what the screen would otherwise compute from work orders: each cell's evidence (strict counting, spec 13.3),
 * the criteria for its next level and what is missing, the ceiling in force, the projected saving, and whether a promotion is pending. Counts ride with every rate.
 */
import type { Queryable } from "@gantry/db";
import { flowOf, trust, trustAgentFor, trustCellId, type Trust, type TrustCell, type TrustCeiling, type TrustEvidence, type TrustMeets } from "@gantry/domain";
import { MIN_RUNS, MAX_GRANTABLE, probationCap, probationOf } from "./config.js";
import { ceilingFor } from "./record.js";
import { loadInsight, toCell, type Insight } from "./store.js";

export interface CellOut extends TrustCell {
  /** The cell's version, for If-Match. 0 for a cell that has not been created yet. */
  rev: number;
  virtual?: boolean;
  /** The gate this agent is judged at. */
  gate: string | null;
  evidence: TrustEvidence;
  meets: TrustMeets;
  ceiling: { max: number; ids: string[] };
  /** What the cell actually runs at: the grant, capped by ceilings, and by L1 while levels above L1 are switched off. */
  effective: number;
  projection: number;
  /** Set while the cell runs one level lower after an agent version change (spec 13.3 "Version change"). */
  probation: { runsLeft: number; since: string; fromVersion: string | null; toVersion: string | null; kind: string } | null;
  /** The proposal waiting on this cell. */
  pending: string | null;
}

export interface TrustOut extends Trust {
  cells: CellOut[];
  ceilings: Array<TrustCeiling & { version: number }>;
  levelsAboveL1: boolean;
  criteriaVersion: number;
  minRuns: number;
  soakDays: number;
  maxGrantable: number;
  /** Per project: gate decisions in the last 7 days and how many ran under trust. */
  coverage: Record<string, { total: number; auto: number }>;
}

export async function readTrust(db: Queryable, orgId: string, o: { visible: readonly string[]; project?: string | undefined }, now = new Date(), pre?: Insight): Promise<TrustOut> {
  const projects = o.project ? o.visible.filter((p) => p === o.project) : o.visible;
  const ins = pre ?? (await loadInsight(db, orgId, { projects }, now));
  const { state } = ins;
  const vis = new Set(projects);
  const nowMs = now.getTime();
  const real = state.trust.cells.filter((c) => vis.has(c.project));
  const gateOf = (agent: string): string | null => state.catalog.gates.find((g) => g.id !== "G0G1" && trustAgentFor(state, g.id) === agent)?.id ?? null;
  const pendingOf = new Map(state.trust.proposals.filter((p) => p.status === "pending").map((p) => [p.cell, p.id]));
  const dbCell = new Map(ins.cells.map((c) => [c.id, c]));
  const out = (c: TrustCell, virtual: boolean): CellOut => {
    const gate = gateOf(c.agent);
    const p = state.projects.find((x) => x.id === c.project);
    const ceil = ceilingFor(state.trust.ceilings, { regulated: !!p?.regulated, cls: c.cls, project: c.project, gate });
    const m = trust.meets(state, c, { strict: true, now: nowMs, soakDays: ins.doc.soakDays });
    const ev = m.evidence ?? trust.evidence(state, c, { strict: true, now: nowMs, soakDays: ins.doc.soakDays });
    const next = m.next;
    const prob = probationOf(dbCell.get(c.id)?.data ?? {});
    return {
      ...c, cleanRuns: ev.cleanRuns, rev: dbCell.get(c.id)?.version ?? 0, ...(virtual ? { virtual: true } : {}), gate, evidence: ev, meets: m, ceiling: { max: ceil.max, ids: ceil.ceilings.map((x) => x.id) },
      effective: Math.min(c.level, ceil.max, ins.switchOn ? MAX_GRANTABLE : 1, prob ? probationCap(c.level) : 4), probation: prob,
      projection: next ? trust.projection(state, c, next, nowMs) : 0, pending: pendingOf.get(c.id) ?? null,
    };
  };
  const cells: CellOut[] = real.map((c) => out(c, false));
  if (o.project && vis.has(o.project)) {
    const p = state.projects.find((x) => x.id === o.project);
    if (p) {
      const agents = [...new Set(state.catalog.gates.filter((g) => g.id !== "G0G1").map((g) => trustAgentFor(state, g.id)).filter((a): a is string => !!a))];
      for (const a of agents) {
        for (const cls of flowOf(state.catalog, p).classes) {
          const id = trustCellId(a, cls.id, p.id);
          if (state.trust.cells.some((c) => c.id === id)) continue;
          cells.push(out({ id, agent: a, cls: cls.id, project: p.id, repo: null, level: 1, since: 0, cleanRuns: 0, history: [] }, true));
        }
      }
    }
  }
  const coverage: TrustOut["coverage"] = {};
  for (const p of projects) {
    const c = trust.coverage(state, p, nowMs);
    coverage[p] = { total: c.total, auto: c.auto };
  }
  const ids = new Set(real.map((c) => c.id));
  return {
    sampleRate: ins.doc.sampleRate, criteria: ins.doc.criteria, ceilings: ins.ceilings, cells,
    proposals: state.trust.proposals.filter((p) => ids.has(p.cell)), nextProposal: state.trust.nextProposal, seededAt: 0,
    levelsAboveL1: ins.switchOn, criteriaVersion: ins.doc.version, minRuns: MIN_RUNS, soakDays: ins.doc.soakDays, maxGrantable: MAX_GRANTABLE, coverage,
  };
}

export { toCell };
