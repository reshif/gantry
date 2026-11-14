import type { ApproverRule, Project } from "@gantry/domain";
import type { Queryable } from "@gantry/db";

/** Per-project portfolio numbers (legacy `G.portfolio.metrics` and `projectHealth`), computed from the tables. Never invented: an empty project reports zeros. */
export interface PortfolioMetrics {
  /** Open work orders at a station. */
  wip: number;
  /** Open work orders parked in a bay. */
  bays: number;
  /** Gates waiting for a decision, oldest wait in ms, and how many are past their escalation time. */
  gates: number;
  oldest: number;
  late: number;
  /** Agent working time over lead time for work shipped in the last 7 days (null when none shipped); `effN` is the sample. */
  eff: number | null;
  effN: number;
  /** Gate decisions in the last 7 days and how many passed under trust. */
  cov: { total: number; auto: number; share: number };
  /** Blocked or failing work and security holds. */
  bad: number;
  haltedRepos: number;
  /** Open work orders by station or bay id (`blocked`: blocked or failed ones), by class, and gates waiting by gate id; coding slots held. */
  byPosition: Record<string, { n: number; blocked: number }>;
  byClass: Record<string, number>;
  byGate: Record<string, number>;
  slotsUsed: number;
  /** Repos that are not Ready yet. */
  onboarding: number;
  health: { id: "killed" | "halted" | "attention" | "new" | "onboarding" | "ok" | "archived"; label: string; icon: string; detail?: string };
}

const DAY = 86_400_000;
const num = (v: unknown): number => Number(v ?? 0) || 0;

export async function portfolioMetrics(db: Queryable, orgId: string, projects: Project[], factoryKilled: boolean, haltedRepoCounts: Record<string, number>, now = Date.now()): Promise<Record<string, PortfolioMetrics>> {
  const since = new Date(now - 7 * DAY);
  const [open, gates, cov, shipped, byCls, slots, onb] = await Promise.all([
    db.query<{ project_id: string; position: string; state: string; n: string }>(
      `select project_id, position, state, count(*) as n from work_orders where org_id = $1 and state not in ('done','killed','declined') group by project_id, position, state`,
      [orgId],
    ),
    db.query<{ project_id: string; gate_id: string; opened_at: Date }>(
      `select w.project_id, g.gate_id, g.opened_at from gate_instances g join work_orders w on w.org_id = g.org_id and w.id = g.wo_id
       where g.org_id = $1 and g.status = 'open' and w.state not in ('done','killed','declined','parked')`,
      [orgId],
    ),
    db.query<{ project_id: string; trust: string; total: string }>(
      `select w.project_id, count(*) filter (where d.trust_grant_id is not null) as trust, count(*) as total from gate_decisions d join work_orders w on w.org_id = d.org_id and w.id = d.wo_id
       where d.org_id = $1 and d.at >= $2 group by w.project_id`,
      [orgId, since],
    ),
    db.query<{ project_id: string; n: string; lead_ms: string; act_ms: string }>(
      `select w.project_id, count(*) as n,
              coalesce(sum(extract(epoch from (w.closed_at - w.created_at)) * 1000), 0) as lead_ms,
              coalesce(sum((select coalesce(sum(extract(epoch from (a.ended_at - a.started_at)) * 1000), 0) from attempts a where a.org_id = w.org_id and a.wo_id = w.id and a.started_at is not null and a.ended_at is not null)), 0) as act_ms
       from work_orders w where w.org_id = $1 and w.state = 'done' and w.closed_at >= $2 group by w.project_id`,
      [orgId, since],
    ),
    db.query<{ project_id: string; class: string; n: string }>(`select project_id, class, count(*) as n from work_orders where org_id = $1 and state not in ('done','killed','declined') group by project_id, class`, [orgId]),
    db.query<{ project_id: string; n: string }>(`select project_id, count(*) as n from slots where org_id = $1 and state = 'held' group by project_id`, [orgId]),
    db.query<{ project_id: string; n: string }>(`select project_id, count(*) as n from repos where org_id = $1 and onboarding_stage <> 'ready' group by project_id`, [orgId]),
  ]);
  const out: Record<string, PortfolioMetrics> = {};
  for (const p of projects) {
    const bayIds = new Set(p.flow.bays);
    let wip = 0;
    let bays = 0;
    let bad = 0;
    const byPosition: PortfolioMetrics["byPosition"] = {};
    for (const r of open.rows.filter((x) => x.project_id === p.id)) {
      const n = num(r.n);
      const cell = (byPosition[r.position] ??= { n: 0, blocked: 0 });
      cell.n += n;
      if (r.state === "blocked" || r.state === "failed") cell.blocked += n;
      if (bayIds.has(r.position) || r.state === "parked") bays += n;
      else wip += n;
      if (r.state === "blocked" || r.state === "failed" || r.position === "sechold") bad += n;
    }
    const byGate: Record<string, number> = {};
    const waiting = gates.rows
      .filter((x) => x.project_id === p.id)
      .map((g) => {
        byGate[g.gate_id] = (byGate[g.gate_id] ?? 0) + 1;
        const rule = (p.approvers as Record<string, ApproverRule>)[g.gate_id];
        const age = now - new Date(g.opened_at).getTime();
        return { age, late: rule?.escalateH ? age > rule.escalateH * 3_600_000 : false };
      });
    const c = cov.rows.find((x) => x.project_id === p.id);
    const total = num(c?.total);
    const auto = num(c?.trust);
    const s = shipped.rows.find((x) => x.project_id === p.id);
    const lead = num(s?.lead_ms);
    const late = waiting.filter((g) => g.late).length;
    const haltedRepos = haltedRepoCounts[p.id] ?? 0;
    out[p.id] = {
      wip, bays, gates: waiting.length, oldest: waiting.reduce((m, g) => Math.max(m, g.age), 0), late,
      eff: lead ? num(s?.act_ms) / lead : null, effN: num(s?.n),
      cov: { total, auto, share: total ? auto / total : 0 },
      bad, haltedRepos, byPosition, byGate,
      byClass: Object.fromEntries(byCls.rows.filter((x) => x.project_id === p.id).map((x) => [x.class, num(x.n)])),
      slotsUsed: num(slots.rows.find((x) => x.project_id === p.id)?.n),
      onboarding: num(onb.rows.find((x) => x.project_id === p.id)?.n),
      health: healthOf(p, { factoryKilled, bad, late, haltedRepos }),
    };
  }
  return out;
}

function healthOf(p: Project, m: { factoryKilled: boolean; bad: number; late: number; haltedRepos: number }): PortfolioMetrics["health"] {
  if (m.factoryKilled) return { id: "killed", label: "Factory kill", icon: "st-kill", detail: "Stopped by the factory kill switch" };
  if (p.killed) return { id: "killed", label: "Killed", icon: "st-kill" };
  if (p.status === "archived") return { id: "archived", label: "Archived", icon: "st-park" };
  if (p.halted) return { id: "halted", label: "Halted (andon)", icon: "halt" };
  if (m.bad || m.late || m.haltedRepos) {
    const detail = [m.bad ? `${m.bad} blocked or failing` : null, m.late ? `${m.late} gate${m.late > 1 ? "s" : ""} past SLA` : null, m.haltedRepos ? `${m.haltedRepos} repo halted` : null].filter(Boolean).join(", ");
    return { id: "attention", label: "Needs attention", icon: "alert", detail };
  }
  if (p.status === "new") return { id: "new", label: "Setting up", icon: "rocket" };
  if (p.status === "onboarding") return { id: "onboarding", label: "Onboarding repos", icon: "rocket" };
  return { id: "ok", label: "Healthy", icon: "st-done" };
}
