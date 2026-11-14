import type { Catalog, FlowState, Person, Project, WorkOrder } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { loadFlowState } from "../../core/index.js";
import { ms, num, obj } from "../../core/read/rows.js";

/**
 * The slice of work-order state the home screen reads, built from the rows (`work_orders`, `gate_instances`, `gate_votes`,
 * `conversations`). It fills the fields the domain's approver and gate functions look at and leaves the rest of the legacy
 * record alone: fields a row does not hold stay empty rather than guessed. The work-order area owns the full record.
 */
export interface HomeWorkOrder extends WorkOrder {
  /** Since when the work order has waited at its open gate (ms). */
  waitingSince: number;
}

interface WoRow {
  id: string; project_id: string; repo_id: string | null; title: string; class: string; priority: string; source: string; position: string; state: string;
  submitter: string | null; risk: string | null; sla_due_at: Date | null; closed_at: Date | null; created_at: Date; data: unknown;
}

const OPEN = `('done','killed','declined')`;

export async function loadHomeWorkOrders(db: Queryable, orgId: string, catalog: Pick<Catalog, "stations" | "bays">, now = Date.now()): Promise<HomeWorkOrder[]> {
  const since = new Date(now - 7 * 86_400_000);
  const [wos, gates, votes, convs] = await Promise.all([
    db.query<WoRow>(
      `select id, project_id, repo_id, title, class, priority, source, position, state, submitter, risk, sla_due_at, closed_at, created_at, data from work_orders
       where org_id = $1 and source not in ('eval','onboarding') and (state not in ${OPEN} or state = 'killed' or closed_at >= $2) order by created_at`,
      [orgId, since],
    ),
    db.query<{ id: string; wo_id: string; gate_id: string; opened_at: Date }>(`select id, wo_id, gate_id, opened_at from gate_instances where org_id = $1 and status = 'open'`, [orgId]),
    db.query<{ gate_instance_id: string; voter: string; vote: string; at: Date }>(
      `select v.gate_instance_id, v.voter, v.vote, v.at from gate_votes v join gate_instances g on g.org_id = v.org_id and g.id = v.gate_instance_id where v.org_id = $1 and g.status = 'open'`, [orgId]),
    db.query<{ wo_id: string; status: string; data: unknown }>(`select wo_id, status, data from conversations where org_id = $1 and wo_id is not null and status = 'open'`, [orgId]),
  ]);
  const gatesBy = new Map<string, typeof gates.rows>();
  for (const g of gates.rows) (gatesBy.get(g.wo_id) ?? gatesBy.set(g.wo_id, []).get(g.wo_id)!).push(g);
  const openConv = new Map(convs.rows.map((c) => [c.wo_id, c]));
  const stationIds = catalog.stations.map((s) => s.id);
  const bayIds = new Set(catalog.bays.map((b) => b.id));
  return wos.rows.map((r) => {
    const d = obj(r.data);
    const created = ms(r.created_at) ?? 0;
    const g: WorkOrder["gates"] = {};
    let since = 0;
    for (const gi of gatesBy.get(r.id) ?? []) {
      const opened = ms(gi.opened_at) ?? created;
      since = Math.max(since, opened);
      g[gi.gate_id] = {
        status: "waiting",
        approvals: votes.rows.filter((v) => v.gate_instance_id === gi.id && v.vote === "approve").map((v) => ({ by: v.voter, at: ms(v.at) ?? 0 })) as never,
        rejections: [], checks: [], waitingSince: opened,
      };
    }
    const conv = openConv.get(r.id);
    const cd = obj(conv?.data);
    const raised = Array.isArray(cd.raised) ? (cd.raised as WorkOrder["conv"]["raised"]) : [];
    const wo = {
      ...d,
      id: r.id, project: r.project_id, repo: r.repo_id ?? "", title: r.title, cls: r.class, priority: r.priority, source: r.source, requestedBy: r.submitter ?? "", createdAt: created,
      station: Math.max(0, stationIds.indexOf(r.position)), state: r.state, bay: bayIds.has(r.position) ? r.position : null, bayReason: typeof d.bayReason === "string" ? d.bayReason : "",
      blockReason: typeof d.blockReason === "string" ? d.blockReason : null, failReason: typeof d.failReason === "string" ? d.failReason : null,
      doneAt: ms(r.closed_at) ?? null, risk: r.risk ?? "normal", paths: Array.isArray(d.paths) ? d.paths : [], slaDue: ms(r.sla_due_at) ?? 0,
      history: Array.isArray(d.history) ? d.history : [], gates: g, killed: (d.killed as WorkOrder["killed"]) ?? null, ...(d.heldByKill ? { heldByKill: true } : {}), split: d.split === true,
      conv: { messages: [], qi: 0, answers: {}, misses: [], decisions: [], awaiting: "", questions: [], ...(typeof d.conv === "object" && d.conv ? (d.conv as object) : {}), raised, done: !conv },
      waitingSince: since || created,
    } as unknown as HomeWorkOrder;
    return wo;
  });
}

/** Flow state with the home screen's work orders. The work-order area's own loader can replace this when it lands. */
export async function loadHomeState(db: Queryable, orgId: string): Promise<FlowState & { workOrders: HomeWorkOrder[] }> {
  const st = await loadFlowState(db, orgId);
  const workOrders = await loadHomeWorkOrders(db, orgId, st.catalog);
  return { ...st, workOrders };
}

export const inFlight = (w: Pick<WorkOrder, "state" | "bay">): boolean => w.state !== "done" && w.state !== "killed" && w.bay !== "declined";

export interface WaitingGate {
  wo: HomeWorkOrder;
  gate: string;
  age: number;
  slaH: number;
  late: boolean;
}

/** Legacy `waitingGates`: gates open on work orders that are in flight and not parked in a bay, oldest first. */
export function waitingGates(wos: readonly HomeWorkOrder[], projects: readonly Project[], now: number, projectId?: string): WaitingGate[] {
  const out: WaitingGate[] = [];
  for (const w of wos) {
    if (projectId && w.project !== projectId) continue;
    if (w.bay || !inFlight(w)) continue;
    const p = projects.find((x) => x.id === w.project);
    for (const [gid, gi] of Object.entries(w.gates)) {
      if (gi.status !== "waiting") continue;
      const slaH = num(p?.approvers[gid]?.escalateH);
      const age = Math.max(0, now - (gi.waitingSince ?? w.waitingSince));
      out.push({ wo: w, gate: gid, age, slaH, late: slaH ? age > slaH * 3_600_000 : false });
    }
  }
  return out.sort((a, b) => b.age - a.age);
}

export const activePeople = (people: readonly Person[]): Person[] => people.filter((p) => p.status === "active");
