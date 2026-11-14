/**
 * Workload figures (spec 13.5), computed from the work order records with the domain's workload functions: approvals waiting and response time per person and team,
 * approvals per day, questions answered, after-hours load, the share of waiting gates where one person is the only eligible approver, time work waited on people per gate,
 * and human minutes per work order by class and project. Scoped to the projects the viewer can see.
 */
import type { Queryable } from "@gantry/db";
import { inHours, visibleProjects, workloadSummary, type Act } from "@gantry/domain";
import { notFound } from "../../core/errors.js";
import { loadPolicyState } from "../../core/read/state.js";
import { readTeams } from "../../core/read/index.js";
import { loadInsight } from "../trust/store.js";
import { MIN_N, suggestions, type Suggestion } from "./suggest.js";

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface WoRef {
  id: string;
  title: string;
  project: string;
  cls: string;
}
export interface WorkloadOut {
  at: number;
  days: number;
  /** The scope asked for: "all" or a project id. */
  scope: string;
  minN: number;
  /** The projects the viewer can see (the scope picker) and whether they hold a factory-wide role. */
  projects: Array<{ id: string; name: string }>;
  factoryWide: boolean;
  ids: string[];
  totals: { gatesWaiting: number; soleGates: number; noneGates: number; timedN: number; medianWaitMin: number | null; acts: number; afterHours: number; minutes: number };
  rows: Array<{
    person: string; name: string; team: string | null; waiting: number; glass: number; approvals: number; perDay: number; answered: number; waitN: number; medianResponseMin: number | null;
    afterHours: number; n: number; sole: number; minutes: number; away: { from: number; to: number; delegate: string | null } | null; oncall: boolean;
    waitingGates: Array<{ wo: WoRef; gate: string; since: number; eligible: number }>; recent: Array<Pick<Act, "kind" | "at" | "wo" | "gate" | "waitMin">>;
  }>;
  teams: Array<{ team: string; name: string; people: number; waiting: number; approvals: number; answered: number; minutes: number; waitN: number; medianResponseMin: number | null; afterHours: number; n: number; sole: number }>;
  byCls: Array<{ key: string; minutes: number; workOrders: number; perWO: number }>;
  byProject: Array<{ key: string; minutes: number; workOrders: number; perWO: number }>;
  bottlenecks: Array<{ project: string; gate: string; decisions: number; medianWaitMin: number | null; open: number; oldestMin: number; station: string | null; minEligible: number | null }>;
  needsPerson: Array<{ id: string; title: string; project: string; bayReason: string | null }>;
  suggestions: Suggestion[];
}

const ref = (w: { id: string; title: string; project: string; cls: string }): WoRef => ({ id: w.id, title: w.title, project: w.project, cls: w.cls });

export async function computeWorkload(db: Queryable, orgId: string, viewer: string, q: { scope?: string | null; days: number }, now: Date): Promise<WorkloadOut> {
  const policy = await loadPolicyState(db, orgId);
  const visible = visibleProjects(policy, viewer).filter((p) => p.status !== "archived");
  const scope = q.scope && q.scope !== "all" ? q.scope : "all";
  if (scope !== "all" && !visible.some((p) => p.id === scope)) throw notFound("No such project.");
  const ids = scope === "all" ? visible.map((p) => p.id) : [scope];
  const t = now.getTime();
  const insight = await loadInsight(db, orgId, { projects: ids }, now);
  const state = { ...insight.state, teams: await readTeams(db, orgId) };
  const m = workloadSummary(state, { ids, days: q.days }, t);
  const timed = m.acts.filter((a) => a.waitMin != null && a.kind !== "answer").map((a) => a.waitMin as number);
  const minutes = m.acts.reduce((s, a) => s + ({ approve: 6, confirm: 4, answer: 3 } as const)[a.kind], 0);
  const afterHours = m.acts.filter((a) => !inHours(a.at)).length;
  const viewerPerson = policy.people.find((p) => p.id === viewer);
  return {
    at: t, days: q.days, scope, minN: MIN_N, ids,
    projects: visible.map((p) => ({ id: p.id, name: p.name })),
    factoryWide: !!viewerPerson && viewerPerson.roles.some((g) => g.scope === "factory"),
    totals: {
      gatesWaiting: m.gates.length, soleGates: m.gates.filter((g) => g.eligible.length === 1).length, noneGates: m.gates.filter((g) => !g.eligible.length).length,
      timedN: timed.length, medianWaitMin: median(timed), acts: m.acts.length, afterHours, minutes,
    },
    rows: m.rows.map((r) => ({
      person: r.person, name: r.name, team: r.team, waiting: r.waiting, glass: r.glass, approvals: r.approvals, perDay: r.perDay, answered: r.answered, waitN: r.waitN, medianResponseMin: r.medianResponseMin,
      afterHours: r.afterHours, n: r.n, sole: r.sole, minutes: r.minutes, away: r.away, oncall: r.oncall,
      waitingGates: r.waitingGates.map((g) => ({ wo: ref(g.wo), gate: g.gate, since: g.since, eligible: g.eligible.length })),
      recent: r.acts.slice().sort((a, b) => b.at - a.at).slice(0, 14).map((a) => ({ kind: a.kind, at: a.at, wo: a.wo, ...(a.gate ? { gate: a.gate } : {}), waitMin: a.waitMin ?? null })),
    })),
    teams: m.teams.map((x) => ({ team: x.team, name: x.name, people: x.people, waiting: x.waiting, approvals: x.approvals, answered: x.answered, minutes: x.minutes, waitN: x.waitN, medianResponseMin: x.medianResponseMin, afterHours: x.afterHours, n: x.n, sole: x.sole })),
    byCls: m.byCls, byProject: m.byProject,
    bottlenecks: m.bottlenecks.map((b) => ({ project: b.project, gate: b.gate, decisions: b.decisions, medianWaitMin: b.medianWaitMin, open: b.open, oldestMin: b.oldestMin, station: b.station, minEligible: b.minEligible })),
    needsPerson: m.needsPerson.map((w) => ({ id: w.id, title: w.title, project: w.project, bayReason: w.bayReason ?? null })),
    suggestions: suggestions(state, m, q.days),
  };
}

