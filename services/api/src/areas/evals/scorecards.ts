/**
 * Scorecards and the factory-wide view (spec 8.7, 13.2), computed from what actually happened: attempts, gate decisions, usage and onboarding rows.
 * Eval carrier work orders (source 'eval') never count as live work. A rate with nothing behind it is 0 and carries its count, so the screen can say "insufficient data".
 */
import type { Queryable } from "@gantry/db";
import type { EvalExtra, Scorecard } from "@gantry/domain";
import { readCatalog } from "../../core/read/index.js";

const DAY = 86_400_000;
const WEEKS = 8;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface ScorecardOut extends Scorecard {
  /** What each figure is made of, so the screen can show the count beside the rate. */
  counts: { attempts: number; decisions: number; workOrders: number; tests: number };
}

interface AttemptRow { agent: string | null; state: string; started_at: Date | null; ended_at: Date; wo_id: string; project_id: string; cls: string }
interface DecisionRow { wo_id: string; gate_id: string; decision: string; at: Date; instance: string; opened_at: Date; project_id: string; station: string | null }

/** The station-staffing agents and the gate behind each station. */
async function layout(db: Queryable, orgId: string): Promise<{ agents: Array<{ id: string; station: string | null; stations: string[] }>; gatesAfter: Map<string, string[]> }> {
  const catalog = await readCatalog(db, orgId);
  const { rows } = await db.query<{ id: string; station: string | null; data: Record<string, unknown> }>(`select id, station, data from agents where org_id = $1 order by created_at, id`, [orgId]);
  const gatesAfter = new Map<string, string[]>();
  for (const g of catalog.gates) gatesAfter.set(g.after, [...(gatesAfter.get(g.after) ?? []), g.id]);
  return {
    agents: rows.map((a) => ({ id: a.id, station: a.station, stations: [...new Set([...(a.station ? [a.station] : []), ...(Array.isArray(a.data.stations) ? (a.data.stations as unknown[]).filter((s): s is string => typeof s === "string") : [])])] })),
    gatesAfter,
  };
}

export async function readScorecards(db: Queryable, orgId: string, now = new Date()): Promise<Record<string, ScorecardOut>> {
  const t0 = new Date(now.getTime() - WEEKS * 7 * DAY);
  const { agents, gatesAfter } = await layout(db, orgId);
  // A transaction client runs one query at a time (the flow engine reads scorecards inside its own): serialise there, run concurrently on a pool.
  let chain: Promise<unknown> = Promise.resolve();
  const isTx = "release" in db;
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => (isTx ? ((chain = chain.then(fn, fn)) as Promise<T>) : fn());
  const [att, cost, dec, tests] = await Promise.all([
    serial(() => db.query<AttemptRow>(
      `select a.data->>'agent' as agent, a.state, a.started_at, a.ended_at, a.wo_id, w.project_id, w.class as cls from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id
        where a.org_id = $1 and w.source <> 'eval' and a.state in ('succeeded','failed') and a.ended_at >= $2`, [orgId, t0])),
    serial(() => db.query<{ agent: string | null; wo_id: string; cost: string; at: Date }>(
      `select a.data->>'agent' as agent, ru.wo_id, ru.cost_micros::text as cost, ru.at from run_usage ru join attempts a on a.org_id = ru.org_id and a.id = ru.attempt_id join work_orders w on w.org_id = a.org_id and w.id = a.wo_id
        where ru.org_id = $1 and w.source <> 'eval' and ru.at >= $2`, [orgId, t0])),
    serial(() => db.query<DecisionRow>(
      `select d.wo_id, i.gate_id, d.decision, d.at, i.id as instance, i.opened_at, w.project_id, i.station from gate_decisions d join gate_instances i on i.org_id = d.org_id and i.id = d.gate_instance_id join work_orders w on w.org_id = d.org_id and w.id = d.wo_id
        where d.org_id = $1 and w.source <> 'eval' and d.decided_by is not null and d.decision in ('approved','rejected') and d.at >= $2`, [orgId, t0])),
    serial(() => db.query<{ agent: string | null; status: string; n: string }>(
      `select a.data->>'agent' as agent, t.status, count(*)::text as n from test_results t join attempts a on a.org_id = t.org_id and a.id = t.attempt_id join work_orders w on w.org_id = a.org_id and w.id = a.wo_id
        where t.org_id = $1 and w.source <> 'eval' and t.status in ('passed','failed') and t.created_at >= $2 group by 1, 2`, [orgId, new Date(now.getTime() - 7 * DAY)])),
  ]);
  const out: Record<string, ScorecardOut> = {};
  const week = (t: number): number => WEEKS - 1 - Math.min(WEEKS - 1, Math.floor((now.getTime() - t) / (7 * DAY)));
  for (const a of agents) {
    const mine = att.rows.filter((r) => r.agent === a.id);
    const last7 = mine.filter((r) => now.getTime() - r.ended_at.getTime() < 7 * DAY);
    const ok7 = last7.filter((r) => r.state === "succeeded");
    const gates = new Set(a.stations.flatMap((s) => gatesAfter.get(s) ?? []));
    const decisions = dec.rows.filter((d) => gates.has(d.gate_id) && now.getTime() - d.at.getTime() < 7 * DAY);
    const firstBy = new Map<string, string>();
    const rejectedPairs = new Set<string>();
    for (const d of dec.rows.filter((x) => gates.has(x.gate_id) && now.getTime() - x.at.getTime() < 7 * DAY).sort((x, y) => x.at.getTime() - y.at.getTime())) {
      const k = `${d.wo_id}|${d.gate_id}`;
      if (!firstBy.has(k)) firstBy.set(k, d.decision);
      if (d.decision === "rejected") rejectedPairs.add(k);
    }
    const pairs = firstBy.size;
    const rejections = decisions.filter((d) => d.decision === "rejected").length;
    const woCost7 = new Map<string, number>();
    for (const c of cost.rows.filter((x) => x.agent === a.id && now.getTime() - x.at.getTime() < 7 * DAY)) woCost7.set(c.wo_id, (woCost7.get(c.wo_id) ?? 0) + Number(c.cost) / 1e6);
    const success: number[] = [];
    const costTrend: number[] = [];
    const weekN: number[] = [];
    for (let w = 0; w < WEEKS; w++) {
      const ws = mine.filter((r) => week(r.ended_at.getTime()) === w);
      success.push(ws.length ? r3(ws.filter((r) => r.state === "succeeded").length / ws.length) : 0);
      weekN.push(ws.length);
      const per = new Map<string, number>();
      for (const c of cost.rows.filter((x) => x.agent === a.id && week(x.at.getTime()) === w)) per.set(c.wo_id, (per.get(c.wo_id) ?? 0) + Number(c.cost) / 1e6);
      costTrend.push(per.size ? r3([...per.values()].reduce((s, n) => s + n, 0) / per.size) : 0);
    }
    const testsPassed = Number(tests.rows.find((t) => t.agent === a.id && t.status === "passed")?.n ?? 0);
    const testsTotal = testsPassed + Number(tests.rows.find((t) => t.agent === a.id && t.status === "failed")?.n ?? 0);
    const mins = ok7.filter((r) => r.started_at).map((r) => (r.ended_at.getTime() - r.started_at!.getTime()) / 60_000);
    out[a.id] = {
      taskSuccess: last7.length ? r3(ok7.length / last7.length) : 0,
      firstPass: pairs ? r3([...firstBy.values()].filter((d) => d === "approved").length / pairs) : 0,
      testPass: testsTotal ? r3(testsPassed / testsTotal) : 0,
      rework: pairs ? r3(rejectedPairs.size / pairs) : 0,
      costPerWO: woCost7.size ? r3([...woCost7.values()].reduce((s, n) => s + n, 0) / woCost7.size) : 0,
      minutesPerStation: mins.length ? Math.round(mins.reduce((s, n) => s + n, 0) / mins.length) : 0,
      gateRejections: rejections,
      overrideRate: decisions.length ? r3(rejections / decisions.length) : 0,
      trend: { success, cost: costTrend, n: weekN },
      counts: { attempts: last7.length, decisions: decisions.length, workOrders: new Set(last7.map((r) => r.wo_id)).size, tests: testsTotal },
    };
  }
  return out;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface FactoryOut extends EvalExtra {
  /** Repos by onboarding stage. */
  onboardingStages: Record<string, number>;
  /** How many records each table rests on. */
  counts: { workOrders: number; classified: number; decisions: number; attempts: number };
}

export async function readFactory(db: Queryable, orgId: string, now = new Date(), projects: readonly string[] | null = null): Promise<FactoryOut> {
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since90 = new Date(now.getTime() - 90 * DAY);
  const scope = projects ? `and w.project_id = any($3::text[])` : "";
  const args = (since: Date): unknown[] => (projects ? [orgId, since, [...projects]] : [orgId, since]);
  const [att, wos, dec, repos, runs] = await Promise.all([
    db.query<AttemptRow>(
      `select a.data->>'agent' as agent, a.state, a.started_at, a.ended_at, a.wo_id, w.project_id, w.class as cls from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id
        where a.org_id = $1 and w.source <> 'eval' and a.state in ('succeeded','failed') and a.ended_at >= $2 ${scope}`, args(since30)),
    db.query<{ id: string; cls: string; project_id: string; state: string; created_at: Date; closed_at: Date | null; suggested: string | null; overridden: string | null }>(
      `select w.id, w.class as cls, w.project_id, w.state, w.created_at, w.closed_at, w.data->>'clsSuggested' as suggested, w.data->>'clsOverridden' as overridden from work_orders w
        where w.org_id = $1 and w.source <> 'eval' and w.created_at >= $2 ${scope}`, args(since90)),
    db.query<DecisionRow & { reason: string | null }>(
      `select d.wo_id, i.gate_id, d.decision, d.at, i.id as instance, i.opened_at, w.project_id, i.station, d.detail->>'reason' as reason from gate_decisions d join gate_instances i on i.org_id = d.org_id and i.id = d.gate_instance_id
         join work_orders w on w.org_id = d.org_id and w.id = d.wo_id where d.org_id = $1 and w.source <> 'eval' and d.decided_by is not null and d.decision in ('approved','rejected') and d.at >= $2 ${scope}`, args(since30)),
    db.query<{ id: string; project_id: string; stage: string; ready_at: Date | null; created_at: Date }>(
      `select r.id, r.project_id, r.onboarding_stage as stage, r.ready_at, r.created_at from repos r where r.org_id = $1 ${projects ? "and r.project_id = any($2::text[])" : ""}`, projects ? [orgId, [...projects]] : [orgId]),
    db.query<{ repo_id: string; status: string; blocker: string | null }>(`select repo_id, status, blocker from onboarding_runs where org_id = $1`, [orgId]),
  ]);
  const { agents } = await layout(db, orgId);
  const agentOf = new Map(agents.map((a) => [a.id, a]));
  void agentOf;

  // Agent by project success.
  const heat: Record<string, Record<string, number | null>> = {};
  const projIds = [...new Set([...att.rows.map((r) => r.project_id), ...repos.rows.map((r) => r.project_id)])];
  for (const a of agents) {
    heat[a.id] = {};
    for (const p of projIds) {
      const rs = att.rows.filter((r) => r.agent === a.id && r.project_id === p);
      heat[a.id]![p] = rs.length ? r3(rs.filter((r) => r.state === "succeeded").length / rs.length) : null;
    }
  }

  // Intake classification: actual (final) class by predicted class.
  const confusion: Record<string, Record<string, number>> = {};
  const classes = [...new Set(wos.rows.flatMap((w) => [w.cls, w.suggested ?? w.cls]))].sort();
  let classified = 0;
  for (const c of classes) confusion[c] = Object.fromEntries(classes.map((p) => [p, 0]));
  for (const w of wos.rows) {
    const pred = w.suggested ?? w.cls;
    confusion[w.cls]![pred] = (confusion[w.cls]![pred] ?? 0) + 1;
    classified++;
  }
  const overridden = wos.rows.filter((w) => w.overridden != null && w.overridden !== "").length;

  // Per class: work orders, success (finished without a rejection), median cycle, rework.
  const rejectedWos = new Set(dec.rows.filter((d) => d.decision === "rejected").map((d) => d.wo_id));
  const perClass: EvalExtra["perClass"] = {};
  for (const c of classes) {
    const mine = wos.rows.filter((w) => w.cls === c);
    const done = mine.filter((w) => w.state === "done");
    const clean = done.filter((w) => !rejectedWos.has(w.id));
    const cyc = median(done.filter((w) => w.closed_at).map((w) => (w.closed_at!.getTime() - w.created_at.getTime()) / 3_600_000));
    perClass[c] = { count: mine.length, success: done.length ? r3(clean.length / done.length) : 0, cycleH: cyc === null ? 0 : Math.round(cyc), rework: done.length ? r3((done.length - clean.length) / done.length) : 0 };
  }

  // Onboarding.
  const stages: Record<string, number> = {};
  for (const r of repos.rows) stages[r.stage] = (stages[r.stage] ?? 0) + 1;
  const ready = repos.rows.filter((r) => r.ready_at);
  const days = ready.map((r) => (r.ready_at!.getTime() - r.created_at.getTime()) / DAY).sort((a, b) => a - b);
  const reasons = new Map<string, number>();
  for (const r of runs.rows) if (r.status === "failed" || r.status === "needs_person") reasons.set(r.blocker || "Needs a person", (reasons.get(r.blocker || "Needs a person") ?? 0) + 1);

  // Gate rejection reasons and the override rate at each human gate.
  const reasonCount = new Map<string, number>();
  for (const d of dec.rows.filter((x) => x.decision === "rejected")) reasonCount.set((d.reason ?? "").trim() || "No reason given", (reasonCount.get((d.reason ?? "").trim() || "No reason given") ?? 0) + 1);
  const byGate = new Map<string, { n: number; rej: number }>();
  for (const d of dec.rows) {
    const g = byGate.get(d.gate_id) ?? { n: 0, rej: 0 };
    g.n++;
    if (d.decision === "rejected") g.rej++;
    byGate.set(d.gate_id, g);
  }
  const med = median(days);
  return {
    heat, confusion, perClass,
    overrideRate: classified ? r3(overridden / classified) : 0,
    onboarding: {
      attempts: runs.rows.length ? new Set(runs.rows.map((r) => r.repo_id)).size : repos.rows.length,
      ready: ready.length,
      successRate: repos.rows.length ? r3(ready.length / repos.rows.length) : 0,
      medianDays: med === null ? 0 : Math.round(med * 10) / 10,
      p90Days: days.length ? Math.round(days[Math.min(days.length - 1, Math.floor(days.length * 0.9))]! * 10) / 10 : 0,
      failedReasons: [...reasons].sort((a, b) => b[1] - a[1]),
    },
    gateRejections: [...reasonCount].sort((a, b) => b[1] - a[1]).slice(0, 8),
    humanOverride: Object.fromEntries([...byGate].map(([g, v]) => [g, r3(v.n ? v.rej / v.n : 0)])),
    onboardingStages: stages,
    counts: { workOrders: wos.rows.length, classified, decisions: dec.rows.length, attempts: att.rows.length },
  };
}
