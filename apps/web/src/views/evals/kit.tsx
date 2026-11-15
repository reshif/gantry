/**
 * Shared pieces of the Evals screen (legacy views/evals.js): the selection state kept across tabs and screens, the data every tab reads,
 * and the small renderers. A run is real work through the production runtime now, so its progress comes from the server, not from a local timer.
 */
import { useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { DAY, fmt, type Agent, type EvalRun, type Suite } from "@gantry/domain";
import { useAgents, useAllSuiteRuns, useEvalsFactory, useScorecards, useSkills, useSuites, useVendors } from "../../api/queries";
import type { AgentRow, AgentVersionRow } from "../agents/kit";
import { Icon } from "../../ui/Icon";

export type EvalsTab = "agents" | "suites" | "factory";
export const evalsUi = { tab: "agents" as EvalsTab, agent: null as string | null, suite: null as string | null, run: null as string | null, a: null as string | null, b: null as string | null, runVersion: null as string | null, runModel: null as string | null, repeats: 1 };
let tick = 0;
const listeners = new Set<() => void>();
export const rerender = (): void => {
  tick++;
  listeners.forEach((l) => l());
};
export const useEvalsUi = (): number => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => tick);

/** Other screens (agents) open a suite here. */
export function evalsFocus(o: { agent?: string; suite?: string; version?: string }): void {
  evalsUi.tab = "suites";
  if (o.agent) evalsUi.agent = o.agent;
  if (o.suite) {
    evalsUi.suite = o.suite;
    evalsUi.run = null;
    evalsUi.a = evalsUi.b = null;
    evalsUi.runModel = null;
  }
  evalsUi.runVersion = o.version ?? null;
  rerender();
}

export type RunRow = EvalRun;

export interface EvalsData {
  agents: AgentRow[];
  suites: Suite[];
  runs: RunRow[];
  runsOf: (suiteId: string) => RunRow[];
  scorecards: NonNullable<ReturnType<typeof useScorecards>["data"]>;
  extra: ReturnType<typeof useEvalsFactory>["data"];
  skills: NonNullable<ReturnType<typeof useSkills>["data"]>;
  models: Array<{ value: string; label: string }>;
  pending: boolean;
  /** The page's primary reads (agents, suites, runs, scorecards) as one query for `Async`: data once all have loaded, the first failure otherwise. */
  q: { data: true | undefined; error: Error | null; isPending: boolean; isError: boolean; refetch: () => Promise<unknown> };
}

export function useEvalsData(): EvalsData {
  const agentsQ = useAgents();
  const agents = (agentsQ.data ?? []) as unknown as AgentRow[];
  const suitesQ = useSuites();
  const suites = suitesQ.data ?? [];
  const runQ = useAllSuiteRuns();
  const runs = [...(runQ.data ?? [])].sort((a, b) => a.at - b.at);
  const sc = useScorecards();
  const fx = useEvalsFactory();
  const skills = useSkills().data ?? [];
  const vendors = useVendors().data ?? [];
  const models: Array<{ value: string; label: string }> = [];
  for (const v of vendors) for (const m of v.models ?? []) if (v.connected && m.enabled) models.push({ value: m.id, label: m.name });
  return {
    agents, suites, runs, runsOf: (id) => runs.filter((r) => r.suite === id), scorecards: sc.data ?? {}, extra: fx.data, skills, models,
    pending: suitesQ.isPending || sc.isPending || runQ.isPending,
    q: combine([agentsQ, suitesQ, runQ, sc]),
  };
}

export const agentOf = (d: Pick<EvalsData, "agents">, id: string | null | undefined): AgentRow | undefined => d.agents.find((a) => a.id === id);
export const suiteOf = (d: Pick<EvalsData, "suites">, id: string | null | undefined): Suite | undefined => d.suites.find((s) => s.id === id);

/** The model a version pins (from its saved snapshot), else the agent's working model. */
export function versionModel(a: AgentRow, v: AgentVersionRow): string {
  try {
    const snap = v.snapshot ? (JSON.parse(String(v.snapshot)) as { model?: string }) : null;
    return snap?.model || a.model;
  } catch {
    return a.model;
  }
}

/** Below this many tasks or work orders a rate is "insufficient data" (spec 13.3 uses the same floor). */
export const MIN_N = 5;

export function weekLabels(n: number): string[] {
  const out: string[] = [];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 7 * DAY + 330 * 60_000);
    out.push(`${d.getUTCDate()} ${months[d.getUTCMonth()]}`);
  }
  return out;
}

/** The weeks that have a point to draw: those with finished attempts. A week with none is not a 0%, it is no data. */
export function weeksOf(sc: { trend: { success: number[]; cost: number[]; n?: number[] } } | undefined, labels: string[]): { idx: number[]; labels: string[]; success: number[]; cost: number[] } {
  const t = sc?.trend;
  const idx = t ? t.success.map((_, i) => i).filter((i) => (t.n ? (t.n[i] ?? 0) > 0 : (t.success[i] ?? 0) > 0)) : [];
  return { idx, labels: idx.map((i) => labels[i] ?? ""), success: idx.map((i) => t!.success[i] ?? 0), cost: idx.map((i) => t!.cost[i] ?? 0) };
}

/** Whether a scorecard figure has anything behind it. A rate over nothing is "–", not 0%. */
export function metricHas(c: { counts?: { attempts: number; decisions: number; tests?: number }; costPerWO: number } | undefined, key: string): boolean {
  if (!c) return false;
  const n = c.counts;
  if (!n) return true;
  if (key === "taskSuccess" || key === "minutesPerStation") return n.attempts > 0;
  if (key === "testPass") return (n.tests ?? 0) > 0;
  if (key === "costPerWO") return c.costPerWO > 0;
  return n.decisions > 0;
}

export const rowKeys = (fn: () => void) => ({
  onClick: fn,
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  },
});

export function PassMark({ pass }: { pass: boolean }) {
  return pass ? (
    <span className="state state-done compact"><Icon name="st-done" /><span className="sr">Pass</span></span>
  ) : (
    <span className="state state-failed compact"><Icon name="st-fail" /><span className="sr">Fail</span></span>
  );
}

/** A score with the number of tasks behind it and its 95% range (spec 13.2): "83% (5 of 6 tasks, 44% to 97%)". */
export function ScoreN({ r, short }: { r: Pick<RunRow, "score" | "count" | "passed" | "range" | "status">; short?: boolean }) {
  if (r.status && r.status !== "completed") return <span className="muted small">{r.status === "failed" ? "no graded result" : r.status}</span>;
  const n = r.count ?? 0;
  const range = r.range ?? [0, 0];
  return (
    <span className="ev-scoren">
      <span className="mono">{fmt.pct(r.score)}</span>
      {n ? <span className="mono small muted">{short ? ` n=${n}` : ` ${r.passed ?? 0} of ${n} tasks, range ${fmt.pct(range[0])} to ${fmt.pct(range[1])}`}</span> : null}
    </span>
  );
}

export const asAgent = (a: AgentRow): Agent => a as unknown as Agent;
export type { ReactNode };

type QLike = { data: unknown; error: Error | null; isPending: boolean; isError: boolean; refetch: () => Promise<unknown> };
function combine(qs: QLike[]): EvalsData["q"] {
  const failed = qs.find((x) => x.isError && x.data === undefined);
  const ready = qs.every((x) => x.data !== undefined);
  return {
    data: ready ? true : undefined,
    error: failed?.error ?? null,
    isPending: !ready && !failed,
    isError: !!failed,
    refetch: () => Promise.all(qs.filter((x) => x.isError).map((x) => x.refetch())),
  };
}
