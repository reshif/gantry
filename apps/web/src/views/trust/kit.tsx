/**
 * Shared pieces of the Trust screen (legacy views/trust.js): the selection state kept across tabs and screens, the level glyphs, a rate shown with its count
 * ("insufficient data" for a small sample, spec 13.3), and the ladder's rows. The server computes each cell's evidence, ceiling and next-level criteria.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { TRUST_LEVELS, flowOf, trustAgentFor, trustCellId, type Catalog, type Gate, type Project, type TrustCell, type TrustProposal } from "@gantry/domain";
import { updatePrefs } from "../../lib/prefs";
import { navigate } from "../../lib/router";
import { navigateTab } from "../tabparam";

export const MIN_RUNS = 5;
export type TrustTab = "ladder" | "proposals" | "demotions" | "rules";
export const trustUi = { tab: "ladder" as TrustTab, project: null as string | null, repo: "", sel: null as { agent: string | null; cls: string } | null, propFilter: "pending", demoFilter: "all", hiProposal: null as string | null, view: "list" as "list" | "matrix" };
let tick = 0;
const listeners = new Set<() => void>();
export const rerender = (): void => {
  tick++;
  listeners.forEach((l) => l());
};
export const useTrustUi = (): number => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => tick);

export interface CellOut extends TrustCell {
  rev: number;
  virtual?: boolean;
  gate: string | null;
  evidence: NonNullable<TrustCell["evidence"]>;
  meets: NonNullable<TrustCell["meets"]>;
  ceiling: { max: number; ids: string[] };
  effective: number;
  projection: number;
  pending: string | null;
}

/** Other screens deep-link here: { cell, proposal, project, cls, agent, tab }. Cells and proposals are looked up in what the screen has loaded. */
export function trustFocus(o: { cell?: string | null; proposal?: string | null; project?: string | null; cls?: string | null; agent?: string | null; tab?: string | null }, cells: readonly TrustCell[] = [], proposals: readonly TrustProposal[] = []): void {
  const prop = o.proposal ? proposals.find((x) => x.id === o.proposal) : null;
  const cell = (o.cell ? cells.find((c) => c.id === o.cell) : null) ?? (prop ? cells.find((c) => c.id === prop.cell) : null);
  if (cell) {
    trustUi.project = cell.project;
    trustUi.repo = cell.repo || "";
    trustUi.sel = { agent: cell.agent, cls: cell.cls };
  } else if (o.project) {
    trustUi.project = o.project;
    trustUi.repo = "";
    if (o.cls) trustUi.sel = { agent: o.agent || null, cls: o.cls };
  }
  if (prop) {
    trustUi.tab = "proposals";
    trustUi.propFilter = prop.status === "pending" ? "pending" : "all";
    trustUi.hiProposal = prop.id;
  } else trustUi.tab = (o.tab === "policy" ? "rules" : (o.tab as TrustTab)) || "ladder";
  rerender();
  navigateTab("trust", trustUi.tab);
}
/** Asks the Trust screen to open at a cell, from another screen. */
export function goTrustCell(cellId: string): void {
  updatePrefs({ trustFocus: { cell: cellId } } as never);
  navigate("trust");
}

export const lv = (n: number) => TRUST_LEVELS[Math.max(0, Math.min(4, n))]!;
export const code = (n: number): string => `L${n}`;
export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export { trustCellId };

/** Four rungs filled up to the level, so the level reads by shape as well as colour. */
export function Rungs({ level, cls }: { level: number; cls?: string }) {
  return (
    <span className={`tr-rungs lvl-${level}${cls ? ` ${cls}` : ""}`} aria-hidden="true">
      {[1, 2, 3, 4].map((i) => <span key={i} className={`tr-rung${i <= level ? " is-on" : ""}`} />)}
    </span>
  );
}
export function LevelTag({ level, extra }: { level: number; extra?: string }) {
  return (
    <span className={`tr-lvl lvl-${level}${extra ? ` ${extra}` : ""}`} title={`${code(level)} ${lv(level).name}`}>
      <Rungs level={level} /><span className="mono">{code(level)}</span><span className="tr-lvl-name">{lv(level).name}</span>
    </span>
  );
}
/** A rate with its sample size; "insufficient data" for a small count. */
export function Rate({ value, n, min = MIN_RUNS, fmtv }: { value: number; n: number; min?: number; fmtv?: (v: number) => string }) {
  if (!n || n < min) return <span className="tr-rate is-thin"><span className="muted">insufficient data</span><span className="mono small muted">{` n=${n || 0}`}</span></span>;
  return <span className="tr-rate"><span className="mono">{fmtv ? fmtv(value) : pct(value)}</span><span className="mono small muted">{` n=${n}`}</span></span>;
}

export interface LadderRow { agent: string; gate: (Gate & { mode: string }) | null; off?: boolean }

/** Rows of the ladder for a project: one per agent judged at a human or mixed gate in its flow, then agents with cells whose gate is off in this flow. */
export function ladderRows(cat: Catalog, p: Project, cells: readonly TrustCell[]): LadderRow[] {
  const flow = flowOf(cat, p);
  const rows: LadderRow[] = [];
  const seen = new Set<string>();
  for (const g of flow.gates) {
    if (g.id === "G0G1" || !g.enabled || g.mode === "auto") continue;
    const ag = trustAgentFor({ catalog: cat }, g.id);
    if (!ag || seen.has(ag)) continue;
    seen.add(ag);
    rows.push({ agent: ag, gate: g as LadderRow["gate"] });
  }
  for (const c of cells) {
    if (c.project === p.id && !seen.has(c.agent)) {
      seen.add(c.agent);
      const g = gateForAgent(cat, c.agent);
      rows.push({ agent: c.agent, gate: g ? { ...g, mode: "off" } : null, off: true });
    }
  }
  return rows;
}
export const gateForAgent = (cat: Catalog, agent: string): Gate | undefined => cat.gates.find((g) => g.id !== "G0G1" && trustAgentFor({ catalog: cat }, g.id) === agent);

export const KV = ({ k, v, extra }: { k: string; v: ReactNode; extra?: ReactNode }) => <div className="tr-kvrow"><dt>{k}</dt><dd>{v}{extra ?? null}</dd></div>;
