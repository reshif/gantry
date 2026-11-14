/**
 * Workload suggestions (spec 13.5): where a person, a rule or a trust level is the way to relieve people. Each carries the action the screen offers (a deep link to the fix).
 * Ported from legacy/js/views/workload.js; the figures come from the domain's workload summary, the trust facts from the domain's trust functions.
 */
import { fmt, gateDef, trust, trustAgentFor, trustCellId, MIN, type InsightState, type workloadSummary } from "@gantry/domain";

type Summary = ReturnType<typeof workloadSummary>;
export const MIN_N = 5;

export interface Suggestion {
  key: string;
  kind: "approver" | "trust" | "delegate";
  icon: string;
  weight: number;
  text: string;
  action: {
    id: string;
    label: string;
    type: "config" | "delegate" | "person" | "trust";
    project?: string;
    gate?: string | null;
    person?: string;
    cell?: string;
    cls?: string | null;
    proposal?: string | null;
  };
}

const mins = (m: number | null | undefined): string => (m == null ? "–" : m < 60 ? `${Math.round(m)}m` : fmt.dur(m * MIN));

export function suggestions(state: InsightState, m: Summary, days: number): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (s: Suggestion): void => {
    if (seen.has(s.key)) return;
    seen.add(s.key);
    out.push(s);
  };
  const gateLabel = (id: string): string => gateDef(state.catalog, id)?.label ?? id;
  const projName = (id: string): string => state.projects.find((p) => p.id === id)?.name ?? id;
  const clsName = (id: string): string => state.catalog.classes.find((c) => c.id === id)?.name ?? id;
  const cellLabel = (c: { agent: string; cls: string; project: string; repo?: string | null }): string =>
    `${state.agents.find((a) => a.id === c.agent)?.name ?? c.agent} · ${clsName(c.cls)} · ${projName(c.project)}${c.repo ? ` · ${c.repo}` : ""}`;

  for (const r of m.rows) {
    if (r.sole >= 1) {
      const g0 = r.soleGates[0]!;
      add({
        key: `sole:${r.person}`, kind: "approver", icon: "people", weight: 3 + r.sole,
        text: `${r.name} is the only eligible approver on ${r.sole} waiting gate${r.sole > 1 ? "s" : ""} (${r.soleGates.slice(0, 3).map((g) => `${g.wo.id} at ${gateLabel(g.gate)}`).join(", ")}). Add a second approver to ${r.sole > 1 ? "those rules" : "that rule"}.`,
        action: { id: `wl-sg-sole-${r.person}`, label: "Open approver rules", type: "config", project: g0.wo.project, gate: g0.gate },
      });
    }
    if (r.away && r.waiting && !r.away.delegate) {
      add({ key: `away:${r.person}`, kind: "delegate", icon: "swap", weight: 4, text: `${r.name} is away with ${r.waiting} approvals waiting and no delegate.`, action: { id: `wl-sg-away-${r.person}`, label: "Set a delegate", type: "delegate", person: r.person } });
    } else if (r.waiting >= 4 && !r.away) {
      add({
        key: `load:${r.person}`, kind: "delegate", icon: "swap", weight: 1 + r.waiting / 4,
        text: `${r.name} has ${r.waiting} approvals waiting. If they are going to be away, set a delegate so work does not stall.`,
        action: { id: `wl-sg-del-${r.person}`, label: "Delegate while away", type: "delegate", person: r.person },
      });
    }
    if (r.n >= MIN_N && r.afterHours / r.n > 0.3) {
      add({
        key: `ah:${r.person}`, kind: "approver", icon: "clock", weight: 2,
        text: `${r.name} did ${r.afterHours} of ${r.n} acts (${fmt.pct(r.afterHours / r.n)}) out of hours in the last ${days === 1 ? "24 hours" : `${days} days`}. Spread on-call approvals across more people.`,
        action: { id: `wl-sg-ah-${r.person}`, label: `Open ${r.name.split(" ")[0]} in People`, type: "person", person: r.person },
      });
    }
  }
  for (const x of state.trust.proposals.filter((p) => p.status === "pending")) {
    const c = state.trust.cells.find((y) => y.id === x.cell);
    if (!c || !m.ids.includes(c.project)) continue;
    add({
      key: `tp:${x.id}`, kind: "trust", icon: "trust", weight: 2 + (x.savedPerWeek || 0) / 3,
      text: `Raise trust for ${cellLabel(c)} from L${x.from} to L${x.to}: the evidence meets the criteria and it saves about ${x.savedPerWeek || 0} human approvals a week.`,
      action: { id: `wl-sg-tp-${x.id}`, label: `Review proposal ${x.id}`, type: "trust", cell: c.id, proposal: x.id, project: c.project, cls: c.cls },
    });
  }
  for (const b of m.bottlenecks.slice(0, 4)) {
    if ((b.medianWaitMin || 0) < 60 && b.oldestMin < 120) continue;
    const item = b.items[0];
    const cls = item ? item.wo.cls : null;
    const agent = trustAgentFor(state, b.gate);
    const cell = cls && agent ? trust.cell(state, agent, cls, b.project) : null;
    const ceil = cls ? trust.ceiling(state, b.project, cls, b.gate) : { max: 4 };
    const lvl = cell ? cell.level : 1;
    const trustable = !!cls && lvl < Math.min(3, ceil.max) && b.gate !== "G0G1";
    add({
      key: `bn:${b.project}${b.gate}`, kind: trustable ? "trust" : "approver", icon: trustable ? "trust" : "gate", weight: 2 + (b.medianWaitMin || 0) / 120,
      text: `Work waits a median ${b.decisions ? `${mins(b.medianWaitMin)} over ${b.decisions} decision${b.decisions > 1 ? "s" : ""}` : "(no decisions yet)"} at ${gateLabel(b.gate)} in ${projName(b.project)}${b.open ? `, ${b.open} open now, oldest ${mins(b.oldestMin)}` : ""}. ` +
        (trustable ? `The ${clsName(cls!)} cell runs at L${lvl} (ceiling L${ceil.max}); raising it moves routine approvals off people.` : `Add an approver to share the load${ceil.max < 3 && cls ? ` (trust is capped at L${ceil.max} here).` : "."}`),
      action: trustable
        ? { id: `wl-sg-bt-${b.project}-${b.gate}`, label: `Open trust for ${clsName(cls!)}`, type: "trust", cell: cell ? cell.id : trustCellId(agent!, cls!, b.project), project: b.project, cls, proposal: null }
        : { id: `wl-sg-ba-${b.project}-${b.gate}`, label: "Open approver rules", type: "config", project: b.project, gate: b.gate },
    });
  }
  out.sort((a, b) => b.weight - a.weight);
  // Interleave kinds so one kind does not crowd out the others.
  const by = new Map<string, Suggestion[]>();
  for (const s of out) (by.get(s.kind) ?? by.set(s.kind, []).get(s.kind)!).push(s);
  const mixed: Suggestion[] = [];
  while (mixed.length < out.length) for (const list of by.values()) if (list.length) mixed.push(list.shift()!);
  return mixed;
}
