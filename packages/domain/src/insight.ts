/**
 * Insight engines derived from state (legacy/js/insight.js): trust ladder decisions and the evidence
 * counting rules of spec 13.3, workload figures (spec 13.5), learning signals and replay over the event log.
 * Every function reads the state passed in and takes `now` explicitly; nothing here mutates.
 */
import { TRUST_LEVELS } from "./catalog.js";
import { DAY, IST_OFFSET_MS, MIN } from "./format.js";
import { gateAfter, gateDecision, gateDef, gateKind, stationDef } from "./flow.js";
import type { FlowState } from "./flow.js";
import type { Agent, EventEntry, LearningSignal, Person, Scorecard, Team, Trust, TrustCell, TrustCeiling, TrustLevelDef, WorkOrder } from "./types.js";

export interface InsightState extends FlowState {
  teams: Team[];
  agents: Agent[];
  scorecards: Record<string, Scorecard>;
  trust: Trust;
  events?: EventEntry[];
}

/** FNV-1a, used for deterministic sampling (same work order and gate always sample the same way). */
export function hash(str: string): number {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return x >>> 0;
}
function median(a: number[]): number {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)] as number;
}
/** True median (mean of the two middle values for even counts); null when empty. */
function medianN(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/* ================================================================== trust ladder ======= */

/** The agent whose work a gate judges: the agent staffing the station before it. */
export function trustAgentFor(state: Pick<FlowState, "catalog">, gateId: string): string | null {
  const g = gateDef(state.catalog, gateId);
  const st = g ? stationDef(state.catalog, g.after) : null;
  return st ? st.agent : null;
}
export function trustCellId(agent: string, cls: string, project: string, repo?: string | null): string {
  return agent + "|" + cls + "|" + project + (repo ? "|" + repo : "");
}

const isBad = (w: WorkOrder) => (w.outcomes ?? []).some((o) => o.kind === "revert" || o.kind === "incident");
const hadRework = (w: WorkOrder) => (w.sendbacks ?? []).length > 0 || Object.values(w.gates).some((g) => g.rejections.length > 0);

export interface TrustDecision {
  auto: boolean;
  level: number | null;
  reason: string;
  sampled?: boolean;
  guardrail?: boolean;
  riskTagged?: boolean;
}
export interface TrustEvidence {
  runs: number;
  cleanRuns: number;
  evalScore: number;
  rework: number;
  incidents: number;
  incidentWos: string[];
}
export interface TrustMeets {
  ok: boolean;
  next: number | null;
  missing: string[];
  evidence?: TrustEvidence;
}

export const trust = {
  level(n: number): TrustLevelDef {
    return TRUST_LEVELS[Math.max(0, Math.min(4, n))] as TrustLevelDef;
  },

  /** The cell for (agent, class, project), preferring a per-repo cell when one exists. */
  cell(state: Pick<InsightState, "trust">, agent: string, cls: string, project: string, repo?: string | null): TrustCell | null {
    const cells = state.trust.cells;
    return (repo && cells.find((c) => c.id === trustCellId(agent, cls, project, repo))) || cells.find((c) => c.id === trustCellId(agent, cls, project)) || null;
  },

  /** Ceilings that apply to (project, class, gate): the lowest `max` wins. */
  ceiling(state: Pick<InsightState, "trust" | "projects">, projectId: string, cls: string, gateId: string | null): { max: number; ceilings: TrustCeiling[] } {
    const p = state.projects.find((x) => x.id === projectId);
    const hits = state.trust.ceilings.filter((c) => {
      if (c.enabled === false) return false;
      if (c.when.regulated && !(p && p.regulated)) return false;
      if (c.when.cls && c.when.cls !== cls) return false;
      if (c.when.project && c.when.project !== projectId) return false;
      if (c.when.gate && c.when.gate !== gateId) return false;
      return true;
    });
    return { max: hits.reduce((m, c) => Math.min(m, c.max), 4), ceilings: hits };
  },

  /** Effective level for a work order at a gate: the cell's grant capped by ceilings. */
  levelFor(state: InsightState, wo: Pick<WorkOrder, "cls" | "project" | "repo">, gateId: string) {
    const agent = trustAgentFor(state, gateId);
    const cell = agent ? trust.cell(state, agent, wo.cls, wo.project, wo.repo) : null;
    const granted = cell ? cell.level : 1;
    const ceil = trust.ceiling(state, wo.project, wo.cls, gateId);
    return { agent, cell, granted, ceiling: ceil.max, ceilings: ceil.ceilings, effective: Math.min(granted, ceil.max) };
  },

  /**
   * Should this gate pass under trust? Never for G0+G1; G6 needs L4; L3 passes within guardrails; L2 samples
   * a share for human review; L0 and L1 always need a person. `opts.riskTags` (spec 13.3 "never automatic"):
   * any risk-tagged change needs a person whatever the level.
   */
  decide(state: InsightState, wo: Pick<WorkOrder, "id" | "cls" | "project" | "repo" | "guardrail">, gateId: string, opts: { riskTags?: readonly string[] } = {}): TrustDecision {
    const g = gateDef(state.catalog, gateId);
    if (!g || gateId === "G0G1") return { auto: false, level: null, reason: "The brief is always confirmed by a person." };
    const lv = trust.levelFor(state, wo, gateId);
    const L = lv.effective;
    const gr = wo.guardrail;
    const guardBad = !!gr && (gr.over || (gr.protectedTouched && gr.protectedTouched.length > 0));
    if (opts.riskTags && opts.riskTags.length) return { auto: false, level: L, riskTagged: true, reason: "Risk-tagged change (" + opts.riskTags.join(", ") + "): a person must approve." };
    if (gateId === "G6" && L < 4) return { auto: false, level: L, reason: "Release confirmation needs L4; this cell runs at " + trust.level(L).code + "." };
    if (L >= 3) {
      if (guardBad) return { auto: false, level: L, reason: "Guardrail: " + (gr?.over ? "diff of " + gr.size + " lines is over the limit" : "touches protected paths") + "; a person must approve.", guardrail: true };
      return { auto: true, level: L, reason: trust.level(L).code + " " + trust.level(L).name + ": passes within guardrails." };
    }
    if (L === 2) {
      const rate = state.trust.sampleRate || 5;
      const sampled = hash(wo.id + ":" + gateId) % rate === 0;
      if (guardBad) return { auto: false, level: L, reason: "Guardrail breach; a person must approve.", guardrail: true };
      return sampled
        ? { auto: false, level: L, sampled: true, reason: "L2 spot check: sampled for human review (1 in " + rate + ")." }
        : { auto: true, level: L, sampled: false, reason: "L2 spot-checked: not sampled this time (1 in " + rate + " are reviewed)." };
    }
    return { auto: false, level: L, reason: trust.level(L).code + " " + trust.level(L).name + ": a person approves." + (lv.granted > L ? " Capped by " + lv.ceilings.map((c) => c.id).join(", ") + "." : "") };
  },

  /**
   * Evidence for a cell, derived from finished work orders and agent evals.
   *
   * Legacy counting (default): a clean run is a finished work order with no send-back, rejection, revert or incident.
   * Strict counting (spec 13.3, `opts.strict`): additionally a clean run must carry at least one gate decision made
   * by a person (an unattended pass is not evidence), must not have been killed or run on a fallback model, and must
   * have outlived the soak period (`soakDays`, proposed 14) without an attributed revert or incident.
   */
  evidence(state: InsightState, cell: TrustCell, opts: { strict?: boolean; now?: number; soakDays?: number } = {}): TrustEvidence {
    const wos = state.workOrders.filter((w) => w.project === cell.project && w.cls === cell.cls && (!cell.repo || w.repo === cell.repo));
    const done = wos.filter((w) => w.state === "done" && !w.split);
    let clean = done.filter((w) => !hadRework(w) && !isBad(w));
    if (opts.strict) {
      const now = opts.now ?? Date.now();
      const soak = (opts.soakDays ?? 14) * DAY;
      const agent = state.agents.find((a) => a.id === cell.agent);
      clean = clean.filter((w) => {
        const personDecided = Object.values(w.gates).some((g) => g.decision && g.decision.mode === "human" && !!g.decision.by);
        const onFallback = !!agent && w.history.some((h) => h.agent === cell.agent && h.model !== agent.model && agent.fallbacks.includes(h.model));
        const soaked = !!w.doneAt && now - w.doneAt >= soak;
        return personDecided && !onFallback && soaked;
      });
    }
    const incidents = done.filter(isBad);
    const ag = state.agents.find((a) => a.id === cell.agent);
    const sc = state.scorecards[cell.agent];
    return {
      runs: done.length,
      cleanRuns: opts.strict ? clean.length : Math.max(cell.cleanRuns || 0, clean.length),
      evalScore: ag ? ag.evalScore : 0,
      rework: sc?.rework || 0,
      incidents: incidents.length,
      incidentWos: incidents.map((w) => w.id),
    };
  },

  /** Does a cell meet the criteria for the next level? */
  meets(state: InsightState, cell: TrustCell, opts: { strict?: boolean; now?: number; soakDays?: number } = {}): TrustMeets {
    const next = cell.level + 1;
    if (next > 4) return { ok: false, next: null, missing: ["Already at the top level."] };
    const crit = state.trust.criteria[String(next)];
    const ev = trust.evidence(state, cell, opts);
    const miss: string[] = [];
    if (crit) {
      if (ev.cleanRuns < crit.cleanRuns) miss.push(ev.cleanRuns + " of " + crit.cleanRuns + " clean runs");
      if (ev.evalScore < crit.evalMin) miss.push("eval " + Math.round(ev.evalScore * 100) + "% under " + Math.round(crit.evalMin * 100) + "%");
      if (ev.rework > crit.reworkMax) miss.push("rework " + Math.round(ev.rework * 100) + "% over " + Math.round(crit.reworkMax * 100) + "%");
      if (ev.incidents > crit.incidentsMax) miss.push(ev.incidents + " incident" + (ev.incidents > 1 ? "s" : "") + " in the window");
    }
    const ceil = trust.ceiling(state, cell.project, cell.cls, null);
    if (next > ceil.max) miss.push("ceiling " + ceil.ceilings.map((c) => c.id).join(", ") + " caps at L" + ceil.max);
    return { ok: !miss.length, next, missing: miss, evidence: ev };
  },

  /**
   * Automatic demotion (spec 13.3): an attributed revert or incident drops the cell to L1; two failures in the
   * last ten reviewed runs drop it one level. Null when no demotion applies.
   */
  demotion(state: InsightState, cell: TrustCell): { to: number; reason: string; cause: { type: string; wo?: string } } | null {
    if (cell.level <= 1) return null;
    const done = state.workOrders
      .filter((w) => w.project === cell.project && w.cls === cell.cls && (!cell.repo || w.repo === cell.repo) && w.state === "done" && !w.split)
      .sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0));
    const bad = done.find((w) => isBad(w) && (w.doneAt ?? 0) >= cell.since);
    if (bad) {
      const o = (bad.outcomes ?? []).find((x) => x.kind === "revert" || x.kind === "incident");
      return { to: 1, reason: (o && o.kind === "revert" ? "Post-release revert" : "Post-release incident") + " on " + bad.id, cause: { type: o ? o.kind : "incident", wo: bad.id } };
    }
    const lastTen = done.slice(-10);
    const failed = lastTen.filter((w) => hadRework(w));
    if (failed.length >= 2) return { to: cell.level - 1, reason: failed.length + " failures in the last " + lastTen.length + " reviewed runs", cause: { type: "failures" } };
    return null;
  },

  /** Human approvals per week saved by moving a cell from its level to `to`. */
  projection(state: Pick<InsightState, "workOrders" | "trust">, cell: TrustCell, to: number, now: number): number {
    const since = now - 7 * DAY;
    const weekly = state.workOrders.filter((w) => w.project === cell.project && w.cls === cell.cls && w.createdAt >= since).length || 1;
    const share = (L: number) => (L <= 1 ? 1 : L === 2 ? 1 / (state.trust.sampleRate || 5) : 0);
    return Math.max(0, Math.round(weekly * (share(cell.level) - share(to)) * 10) / 10);
  },

  /** Share of gate decisions in the last 7 days that ran under trust. */
  coverage(state: Pick<InsightState, "workOrders">, projectId: string | null, now: number): { total: number; auto: number; share: number } {
    const since = now - 7 * DAY;
    let total = 0;
    let auto = 0;
    for (const w of state.workOrders) {
      if (projectId && w.project !== projectId) continue;
      for (const g of Object.values(w.gates)) {
        const d = g.decision;
        if (d && d.at >= since) {
          total++;
          if (d.mode === "trust") auto++;
        }
      }
    }
    return { total, auto, share: total ? auto / total : 0 };
  },
};

/* ================================================================== workload ========== */

export const WORKLOAD_MINUTES = { approve: 6, confirm: 4, answer: 3 } as const;
export type ActKind = keyof typeof WORKLOAD_MINUTES;

export interface WorkloadOpts {
  /** Limit every result to these project ids (privacy scoping for people who see only some projects). */
  projects?: string[];
  days?: number;
}
export interface Act {
  kind: ActKind;
  by: string;
  at: number;
  wo: string;
  project: string;
  cls: string;
  gate?: string;
  waitMin?: number | null;
}

const inScope = (opts: WorkloadOpts | undefined, pid: string) => !opts || !opts.projects || opts.projects.includes(pid);
/** Business hours: Monday to Friday, 09:00 to 19:00 IST. */
export function inHours(t: number): boolean {
  const d = new Date(t + IST_OFFSET_MS);
  const h = d.getUTCHours();
  const day = d.getUTCDay();
  return day >= 1 && day <= 5 && h >= 9 && h < 19;
}

export interface PersonLoad {
  person: string;
  team: string | undefined;
  waiting: number;
  approvals: number;
  perDay: number;
  answered: number;
  medianResponseMin: number;
  afterHoursShare: number;
  soleShare: number;
  sole: number;
  minutes: number;
}
export interface TeamLoad {
  team: string;
  people: number;
  waiting: number;
  approvals: number;
  minutes: number;
  medianResponseMin: number;
}
export interface MinutesBy {
  key: string;
  minutes: number;
  workOrders: number;
  perWO: number;
}
export interface Bottleneck {
  project: string;
  gate: string;
  decisions: number;
  medianWaitMin: number;
  open: number;
  oldestMin: number;
}
export interface Suggestion {
  kind: "approver" | "trust" | "delegate";
  text: string;
  person?: string;
  project?: string;
  gate?: string;
  cell?: string;
  proposal?: string;
}

export const workload = {
  /** Every human act derived from work orders: confirmations, approvals and answers. */
  acts(state: InsightState, opts: WorkloadOpts | undefined, now: number): Act[] {
    const since = now - (opts?.days || 7) * DAY;
    const out: Act[] = [];
    for (const w of state.workOrders) {
      if (!inScope(opts, w.project)) continue;
      for (const k of Object.keys(w.gates)) {
        const gs = w.gates[k];
        if (!gs) continue;
        for (const a of gs.approvals) {
          if (!state.people.some((p) => p.id === a.by) || a.at < since) continue;
          out.push({ kind: k === "G0G1" ? "confirm" : "approve", by: a.by, at: a.at, wo: w.id, project: w.project, cls: w.cls, gate: k, waitMin: gs.waitingSince ? Math.max(1, Math.round((a.at - gs.waitingSince) / MIN)) : null });
        }
      }
      for (const m of w.conv ? w.conv.messages : []) {
        if (m.at < since || !state.people.some((p) => p.id === m.from)) continue;
        out.push({ kind: "answer", by: m.from, at: m.at, wo: w.id, project: w.project, cls: w.cls });
      }
    }
    return out;
  },

  people(state: InsightState, opts: WorkloadOpts | undefined, now: number): PersonLoad[] {
    const acts = workload.acts(state, opts, now);
    const days = opts?.days || 7;
    const scoped = opts?.projects;
    return state.people
      .filter((p) => {
        if (p.status !== "active") return false;
        if (!scoped) return true;
        return p.roles.some((g) => scoped.includes(g.scope)) || acts.some((a) => a.by === p.id);
      })
      .map((p) => {
        const mine = acts.filter((a) => a.by === p.id);
        const approvals = mine.filter((a) => a.kind !== "answer");
        const waits = approvals.map((a) => a.waitMin).filter((x): x is number => x != null);
        let waiting = 0;
        let sole = 0;
        let eligibleGates = 0;
        for (const w of state.workOrders) {
          if (w.bay || ["done", "killed"].includes(w.state) || !inScope(opts, w.project)) continue;
          for (const k of Object.keys(w.gates)) {
            if (w.gates[k]?.status !== "waiting") continue;
            if (!gateDecision(state, p.id, w, k, now).allowed) continue;
            waiting++;
            eligibleGates++;
            const others = state.people.filter((o) => o.id !== p.id && o.status === "active" && gateDecision(state, o.id, w, k, now).allowed && !(o.roles.length === 1 && o.roles[0]?.role === "factory_admin")).length;
            if (!others) sole++;
          }
        }
        const minutes = mine.reduce((t, a) => t + WORKLOAD_MINUTES[a.kind], 0);
        return {
          person: p.id, team: p.teams[0], waiting, approvals: approvals.length, perDay: +(approvals.length / days).toFixed(1),
          answered: mine.filter((a) => a.kind === "answer").length, medianResponseMin: median(waits),
          afterHoursShare: mine.length ? mine.filter((a) => !inHours(a.at)).length / mine.length : 0,
          soleShare: eligibleGates ? sole / eligibleGates : 0, sole, minutes,
        };
      });
  },

  teams(state: InsightState, opts: WorkloadOpts | undefined, now: number): TeamLoad[] {
    const ppl = workload.people(state, opts, now);
    return state.teams
      .filter((t) => !opts?.projects || ppl.some((r) => r.team === t.id))
      .map((t) => {
        const rows = ppl.filter((r) => r.team === t.id);
        return {
          team: t.id, people: rows.length, waiting: rows.reduce((s, r) => s + r.waiting, 0), approvals: rows.reduce((s, r) => s + r.approvals, 0),
          minutes: rows.reduce((s, r) => s + r.minutes, 0), medianResponseMin: median(rows.map((r) => r.medianResponseMin).filter(Boolean)),
        };
      });
  },

  /** Human minutes per work order, grouped by `cls` or `project`. */
  minutesBy(state: InsightState, key: "cls" | "project", opts: WorkloadOpts | undefined, now: number): MinutesBy[] {
    const out: Record<string, { minutes: number; wos: Set<string> }> = {};
    for (const a of workload.acts(state, opts, now)) {
      const k = a[key];
      const e = (out[k] ??= { minutes: 0, wos: new Set() });
      e.minutes += WORKLOAD_MINUTES[a.kind];
      e.wos.add(a.wo);
    }
    return Object.keys(out)
      .map((k) => {
        const e = out[k] as { minutes: number; wos: Set<string> };
        const n = e.wos.size;
        return { key: k, minutes: e.minutes, workOrders: n, perWO: n ? +(e.minutes / n).toFixed(1) : 0 };
      })
      .sort((a, b) => b.perWO - a.perWO);
  },

  /** Gates ranked by the time work waited on people. */
  bottlenecks(state: InsightState, opts: WorkloadOpts | undefined, now: number): Bottleneck[] {
    const out: Record<string, { project: string; gate: string; waits: number[]; open?: number; oldestMin?: number }> = {};
    for (const a of workload.acts(state, opts, now)) {
      if (a.waitMin == null || !a.gate) continue;
      const k = a.project + ":" + a.gate;
      (out[k] ??= { project: a.project, gate: a.gate, waits: [] }).waits.push(a.waitMin);
    }
    for (const w of state.workOrders) {
      if (w.bay || !inScope(opts, w.project)) continue;
      for (const k of Object.keys(w.gates)) {
        const gs = w.gates[k];
        if (gs?.status !== "waiting") continue;
        const key = w.project + ":" + k;
        const e = (out[key] ??= { project: w.project, gate: k, waits: [] });
        e.open = (e.open || 0) + 1;
        e.oldestMin = Math.max(e.oldestMin || 0, Math.round((now - (gs.waitingSince || w.createdAt)) / MIN));
      }
    }
    return Object.values(out)
      .map((x) => ({ project: x.project, gate: x.gate, decisions: x.waits.length, medianWaitMin: median(x.waits), open: x.open || 0, oldestMin: x.oldestMin || 0 }))
      .sort((a, b) => b.medianWaitMin + b.oldestMin / 4 - (a.medianWaitMin + a.oldestMin / 4));
  },

  suggestions(state: InsightState, opts: WorkloadOpts | undefined, now: number): Suggestion[] {
    const out: Suggestion[] = [];
    for (const r of workload.people(state, opts, now)) {
      const p = state.people.find((x) => x.id === r.person) as Person;
      if (r.sole >= 2) out.push({ kind: "approver", person: r.person, text: p.name + " is the only eligible approver on " + r.sole + " waiting gates. Add a second approver to those rules." });
      if (p.away && p.away.to > now && r.waiting && !p.away.delegate) out.push({ kind: "delegate", person: r.person, text: p.name + " is away with " + r.waiting + " approvals waiting. Set a delegate." });
      if (r.afterHoursShare > 0.3 && r.approvals > 3) out.push({ kind: "approver", person: r.person, text: p.name + " does " + Math.round(r.afterHoursShare * 100) + "% of approvals out of hours. Spread the on-call approvals." });
    }
    state.trust.proposals
      .filter((x) => x.status === "pending")
      .filter((x) => {
        const c = state.trust.cells.find((y) => y.id === x.cell);
        return !!c && inScope(opts, c.project);
      })
      .slice(0, 3)
      .forEach((x) => {
        const c = state.trust.cells.find((y) => y.id === x.cell);
        if (c) out.push({ kind: "trust", cell: c.id, proposal: x.id, text: "Raise trust for " + (state.catalog.classes.find((k) => k.id === c.cls)?.name ?? c.cls) + " in " + (state.projects.find((p) => p.id === c.project)?.name ?? c.project) + " to L" + x.to + ": saves about " + (x.savedPerWeek || 0) + " approvals a week." });
      });
    for (const b of workload.bottlenecks(state, opts, now).slice(0, 2)) {
      if (b.medianWaitMin > 60) out.push({ kind: "approver", project: b.project, gate: b.gate, text: "Work waits a median " + Math.round(b.medianWaitMin) + " min at " + (gateDef(state.catalog, b.gate)?.label ?? b.gate) + " in " + (state.projects.find((p) => p.id === b.project)?.name ?? b.project) + ". Add an approver or raise trust." });
    }
    return out;
  },
};

/** A waiting gate in scope with who may decide it (eligible by rule, or break-glass Factory Admins). */
export interface WaitingGate {
  wo: WorkOrder;
  gate: string;
  since: number;
  eligible: string[];
  /** The eligible people the rule reaches, without Factory Admins (who can always approve and are the standing fallback): "sole approver" counts these. */
  named: string[];
  glass: string[];
  trustNote: string | null;
}

/** Scoped workload detail for the workload view and the console. `ids` are the project ids in scope. */
export function workloadSummary(state: InsightState, o: { ids: string[]; days?: number }, now: number) {
  const days = o.days || 7;
  const ids = o.ids;
  const inIds = (pid: string) => ids.includes(pid);
  const acts = workload.acts(state, { days }, now).filter((a) => inIds(a.project));
  const people = state.people.filter((p) => p.status === "active");
  const gates: WaitingGate[] = [];
  for (const w of state.workOrders) {
    if (!inIds(w.project) || w.bay || ["done", "killed"].includes(w.state)) continue;
    const project = state.projects.find((p) => p.id === w.project);
    for (const k of Object.keys(w.gates)) {
      const gs = w.gates[k];
      if (!gs || gs.status !== "waiting") continue;
      if (gateKind(state.catalog, project, k) === "auto") continue;
      const elig: string[] = [];
      const glass: string[] = [];
      for (const p of people) {
        const d = gateDecision(state, p.id, w, k, now);
        if (!d.allowed) continue;
        if (/break-glass/.test(d.reason)) glass.push(p.id);
        else elig.push(p.id);
      }
      const isFA = (id: string): boolean => (people.find((x) => x.id === id)?.roles ?? []).some((g) => g.role === "factory_admin" && g.scope === "factory");
      gates.push({ wo: w, gate: k, since: gs.waitingSince || w.createdAt, eligible: elig, named: elig.filter((id) => !isFA(id)), glass, trustNote: gs.trustNote || null });
    }
  }
  const rows = people
    .map((p) => {
      const mine = acts.filter((a) => a.by === p.id);
      const appr = mine.filter((a) => a.kind !== "answer");
      const waits = appr.map((a) => a.waitMin).filter((x): x is number => x != null);
      const waiting = gates.filter((g) => g.eligible.includes(p.id));
      const sole = waiting.filter((g) => g.named.length === 1 && g.named[0] === p.id);
      const glass = gates.filter((g) => g.glass.includes(p.id)).length;
      const inProj = p.roles.some((g) => g.scope === "factory" || inIds(g.scope));
      return {
        person: p.id, name: p.name, team: (p.teams || [])[0] ?? null, inProj, acts: mine, waiting: waiting.length, waitingGates: waiting, glass,
        approvals: appr.length, perDay: appr.length / days, answered: mine.length - appr.length, waitN: waits.length, medianResponseMin: medianN(waits),
        afterHours: mine.filter((a) => !inHours(a.at)).length, n: mine.length, sole: sole.length, soleGates: sole,
        minutes: mine.reduce((t, a) => t + WORKLOAD_MINUTES[a.kind], 0), away: p.away && p.away.to > now ? p.away : null, oncall: !!p.oncall,
      };
    })
    .filter((r) => r.inProj && (r.n || r.waiting || r.glass));
  const teams = state.teams
    .map((t) => {
      const rs = rows.filter((r) => r.team === t.id);
      const waits: number[] = [];
      for (const r of rs) for (const a of r.acts) if (a.waitMin != null && a.kind !== "answer") waits.push(a.waitMin);
      return {
        team: t.id, name: t.name, people: rs.length, waiting: rs.reduce((s, r) => s + r.waiting, 0), approvals: rs.reduce((s, r) => s + r.approvals, 0),
        answered: rs.reduce((s, r) => s + r.answered, 0), minutes: rs.reduce((s, r) => s + r.minutes, 0), waitN: waits.length, medianResponseMin: medianN(waits),
        afterHours: rs.reduce((s, r) => s + r.afterHours, 0), n: rs.reduce((s, r) => s + r.n, 0), sole: rs.reduce((s, r) => s + r.sole, 0),
      };
    })
    .filter((t) => t.people);
  const minutesBy = (key: "cls" | "project") => {
    const out: Record<string, { key: string; minutes: number; wos: Set<string> }> = {};
    for (const a of acts) {
      const k = a[key];
      const e = (out[k] ??= { key: k, minutes: 0, wos: new Set() });
      e.minutes += WORKLOAD_MINUTES[a.kind];
      e.wos.add(a.wo);
    }
    return Object.values(out)
      .map((e) => ({ key: e.key, minutes: e.minutes, workOrders: e.wos.size, perWO: e.wos.size ? e.minutes / e.wos.size : 0 }))
      .sort((a, b) => b.perWO - a.perWO);
  };
  const bn: Record<string, { project: string; gate: string; waits: number[]; open: number; oldestMin: number; items: WaitingGate[] }> = {};
  for (const a of acts) {
    if (a.waitMin == null || a.kind === "answer" || !a.gate) continue;
    (bn[a.project + ":" + a.gate] ??= { project: a.project, gate: a.gate, waits: [], open: 0, oldestMin: 0, items: [] }).waits.push(a.waitMin);
  }
  for (const g of gates) {
    const e = (bn[g.wo.project + ":" + g.gate] ??= { project: g.wo.project, gate: g.gate, waits: [], open: 0, oldestMin: 0, items: [] });
    e.open++;
    e.items.push(g);
    e.oldestMin = Math.max(e.oldestMin, Math.round((now - g.since) / MIN));
  }
  const bottlenecks = Object.values(bn)
    .map((x) => ({ ...x, decisions: x.waits.length, medianWaitMin: medianN(x.waits), station: gateDef(state.catalog, x.gate)?.after ?? null, minEligible: x.items.length ? Math.min(...x.items.map((g) => g.eligible.length)) : null }))
    .sort((a, b) => (b.medianWaitMin || 0) + b.oldestMin / 4 - ((a.medianWaitMin || 0) + a.oldestMin / 4));
  const needsPerson = state.workOrders.filter((w) => inIds(w.project) && w.bay === "person" && !["done", "killed"].includes(w.state));
  return { ids, acts, gates, rows, teams, byCls: minutesBy("cls"), byProject: minutesBy("project"), bottlenecks, needsPerson };
}

/* ================================================================== learning ========== */

export interface RawSignal {
  signal: LearningSignal;
  wo: string;
  project: string;
  agent?: string | null;
  gate?: string;
  text: string;
  at: number;
}

/** Raw learning signals from work orders: rejections, send-backs, reverts and incidents, class overrides, intake misses. */
export function learningSignals(state: Pick<InsightState, "workOrders" | "catalog">): RawSignal[] {
  const out: RawSignal[] = [];
  for (const w of state.workOrders) {
    for (const k of Object.keys(w.gates)) for (const r of w.gates[k]?.rejections ?? []) out.push({ signal: "rejection", wo: w.id, project: w.project, agent: trustAgentFor(state, k), gate: k, text: r.reason, at: r.at });
    for (const s of w.sendbacks ?? []) out.push({ signal: "sendback", wo: w.id, project: w.project, agent: stationDef(state.catalog, s.from)?.agent, text: s.note || "sent back", at: s.at });
    for (const o of w.outcomes ?? []) if (o.kind === "revert" || o.kind === "incident") out.push({ signal: o.kind, wo: w.id, project: w.project, agent: "ag-build", text: o.text, at: o.at });
    if (w.clsOverridden) out.push({ signal: "override", wo: w.id, project: w.project, agent: "ag-classifier", text: w.clsOverridden.from + " → " + w.cls + ": " + (w.clsOverridden.reason || ""), at: w.clsOverridden.at });
    for (const m of w.conv ? w.conv.misses : []) out.push({ signal: "miss", wo: w.id, project: w.project, agent: "ag-intake", text: m.text, at: w.createdAt });
  }
  return out;
}

/* ================================================================== replay ============ */

const TRACKED = ["failed", "blocked", "killed"];

/**
 * Diff each work order against the last snapshot and return the events to log (bay stays and state changes),
 * plus the new snapshot. `prev = null` takes the baseline without events (seeding).
 */
export function trackStates(prev: Record<string, { state: string; bay: string | null }> | null, workOrders: readonly WorkOrder[], catalog: { stations: Array<{ id: string }> }): {
  track: Record<string, { state: WorkOrder["state"]; bay: string | null }>;
  events: Array<Omit<EventEntry, "id" | "at">>;
} {
  const track: Record<string, { state: WorkOrder["state"]; bay: string | null }> = {};
  const events: Array<Omit<EventEntry, "id" | "at">> = [];
  for (const w of workOrders) {
    const now = { state: w.state, bay: w.bay || null };
    const before = prev?.[w.id];
    track[w.id] = now;
    if (!before) continue;
    const st = catalog.stations[w.station]?.id;
    if (before.bay !== now.bay) events.push({ type: "wo.bay", project: w.project, wo: w.id, bay: now.bay, from: before.bay, ...(st ? { station: st } : {}), text: now.bay ? w.bayReason || "" : "Back on the belt" });
    if (before.state !== now.state && (TRACKED.includes(now.state) || TRACKED.includes(before.state))) {
      events.push({ type: "wo.state", project: w.project, wo: w.id, from: before.state, to: now.state, ...(st ? { station: st } : {}), text: now.state === "failed" ? w.failReason || "" : now.state === "blocked" ? w.blockReason || "" : "" });
    }
  }
  return { track, events };
}

export interface StateAtWo {
  id: string;
  station: string;
  state: string;
  bay: string | null;
  at?: number;
  gate?: string | null;
  progress?: number;
}
export interface StateAt {
  at: number;
  workOrders: StateAtWo[];
  halted: EventEntry | null;
  killed: EventEntry | null;
  haltedRepos: Record<string, EventEntry>;
}

/**
 * Where was every work order of a project at time t? Station from traveler history; bay and failed, blocked and
 * killed state from the event log; waiting from the gate decision record. At t = now this equals the live floor.
 */
export function stateAt(state: Pick<InsightState, "workOrders" | "projects" | "catalog"> & { events: EventEntry[] }, t: number, projectId?: string | null): StateAt {
  const c = state.catalog;
  const byWo: Record<string, EventEntry[]> = {};
  for (const e of state.events) {
    if (e.wo && e.at <= t && (e.type === "wo.bay" || e.type === "wo.state" || ((e.type === "kill" || e.type === "restore") && e.scope === "workorder"))) (byWo[e.wo] ??= []).push(e);
  }
  const last = (list: EventEntry[] | undefined, pred: (e: EventEntry) => boolean): EventEntry | null => {
    for (let i = (list || []).length - 1; i >= 0; i--) if (pred((list as EventEntry[])[i] as EventEntry)) return (list as EventEntry[])[i] as EventEntry;
    return null;
  };
  const wos: StateAtWo[] = [];
  for (const w of state.workOrders) {
    if (projectId && w.project !== projectId) continue;
    if (w.createdAt > t) continue;
    if (w.doneAt && w.doneAt <= t) {
      wos.push({ id: w.id, station: "done", state: "done", bay: null, at: w.doneAt });
      continue;
    }
    const evs = byWo[w.id] || [];
    let cur = null as WorkOrder["history"][number] | null;
    for (const e of w.history) if (e.startedAt <= t) cur = e;
    if (!cur) cur = w.history[0] as WorkOrder["history"][number];
    const k = last(evs, (e) => e.type === "kill" || e.type === "restore" || (e.type === "wo.state" && (e.to === "killed" || e.from === "killed")));
    const killedNow = k ? k.type === "kill" || (k.type === "wo.state" && k.to === "killed") : !!(w.killed && w.killed.at <= t && w.state === "killed");
    if (killedNow) {
      wos.push({ id: w.id, station: w.killed && w.killed.prev ? (c.stations[w.killed.prev.station]?.id ?? cur.station) : cur.station, state: "killed", bay: null, progress: 0 });
      continue;
    }
    const be = last(evs, (e) => e.type === "wo.bay");
    const parked = be ? (be.bay ?? null) : w.bay && w.bayAt && w.bayAt <= t ? w.bay : null;
    const se = last(evs, (e) => e.type === "wo.state");
    let bad: string | null = se && (se.to === "failed" || se.to === "blocked") ? (se.to as string) : null;
    if (!se && (w.state === "failed" || w.state === "blocked") && cur === w.history[w.history.length - 1]) bad = w.state;
    const station = parked ? (be && be.station) || (w.bay && c.stations[w.station] ? c.stations[w.station]?.id : cur.station) || cur.station : cur.station;
    const running = !cur.endedAt || cur.endedAt > t;
    let gate = !running ? gateAfter(c, cur.station) : null;
    const p = state.projects.find((x) => x.id === w.project);
    let waiting = !running && !!gate && !!w.gates[gate.id] && gateKind(c, p, gate.id) !== "auto" && !(w.gates[gate.id]?.decision && (w.gates[gate.id]?.decision as { at: number }).at <= t);
    /* at Intake the work order waits on the conversation and the brief (G0+G1) until a person confirms it */
    const g01 = w.gates.G0G1;
    if (cur.station === "intake" && g01 && !(g01.decision && g01.decision.at <= t) && !(g01.approvals[0] && g01.approvals[0].at <= t)) {
      waiting = true;
      gate = gateDef(c, "G0G1") ?? null;
    }
    if (!running && !gate && w.gates.G6 && !(w.gates.G6.decision && w.gates.G6.decision.at <= t)) {
      waiting = true;
      gate = gateDef(c, "G6") ?? null;
    }
    const stateNow = parked ? "parked" : bad ? bad : waiting ? "waiting" : "running";
    const progress =
      stateNow !== "running"
        ? running ? Math.min(95, Math.round(((t - cur.startedAt) / (40 * MIN)) * 100)) : 100
        : cur.endedAt ? Math.min(100, Math.round(((t - cur.startedAt) / (cur.endedAt - cur.startedAt)) * 100)) : Math.min(95, Math.round(((t - cur.startedAt) / (40 * MIN)) * 100));
    wos.push({ id: w.id, station, state: stateNow, bay: parked, gate: waiting && gate ? gate.id : null, progress });
  }
  const ev = state.events.filter((e) => (!projectId || e.project === projectId || !e.project) && e.at <= t);
  const lastOf = (types: string[], pred?: (e: EventEntry) => boolean): EventEntry | null => {
    for (let i = ev.length - 1; i >= 0; i--) if (types.includes((ev[i] as EventEntry).type) && (!pred || pred(ev[i] as EventEntry))) return ev[i] as EventEntry;
    return null;
  };
  const h = lastOf(["halt", "resume"], (e) => e.scope === "project");
  const k = lastOf(["kill", "restore"], (e) => e.scope === "project" || e.scope === "factory");
  const haltedRepos: Record<string, EventEntry> = {};
  for (const e of ev) {
    if (e.scope === "repo" && e.type === "halt" && e.repo) haltedRepos[e.repo] = e;
    if (e.scope === "repo" && e.type === "resume" && e.repo) delete haltedRepos[e.repo];
  }
  return { at: t, workOrders: wos, halted: h && h.type === "halt" ? h : null, killed: k && k.type === "kill" ? k : null, haltedRepos };
}

export const replay = {
  /** Events in a window, optionally for a project and types: newest last. */
  events(events: readonly EventEntry[], o: { project?: string; from?: number; to?: number; types?: string[]; includeFactory?: boolean } = {}): EventEntry[] {
    return events.filter(
      (e) => (!o.project || e.project === o.project || (!e.project && o.includeFactory !== false)) && (!o.from || e.at >= o.from) && (!o.to || e.at <= o.to) && (!o.types || o.types.includes(e.type)),
    );
  },
  /** The milestones of one work order for the record's journey scrubber. */
  journey(events: readonly EventEntry[], woId: string): EventEntry[] {
    return events.filter((e) => e.wo === woId);
  },
  range(span: "1d" | "7d", now: number): { from: number; to: number } {
    return { from: now - (span === "7d" ? 7 * DAY : DAY), to: now };
  },
  MARK_TYPES: ["gate.decision", "halt", "resume", "kill", "restore", "release", "trust.auto", "outcome", "wo.state"] as const,
};

