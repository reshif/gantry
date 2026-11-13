import type { Catalog, FlowState, PolicyState, WorkOrder } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { reads } from "./rows.js";
import { readActiveStops, readCatalog, readFreezes, readMatrix, readOrg, readPeople, readPolicies, readProjects, readRepos, type ActiveStop } from "./index.js";

/**
 * Builds the permission engine's input from rows (spec 14.3). `stops.factory` comes from the active factory stop; project,
 * repo and work-order stops are folded into the records the engine reads. One call is a handful of reads: callers cache it per request.
 */
export async function loadPolicyState(db: Queryable, orgId: string): Promise<PolicyState & { catalog: Catalog; activeStops: ActiveStop[] }> {
  const stops = await readActiveStops(db, orgId);
  const org = await readOrg(db, orgId);
  const [people, matrix, policies, freezes, projects, repos, catalog] = await reads(db, [
    () => readPeople(db, orgId), () => readMatrix(db, orgId), () => readPolicies(db, orgId), () => readFreezes(db, orgId), () => readProjects(db, orgId, stops), () => readRepos(db, orgId, stops), () => readCatalog(db, orgId, org),
  ]);
  const f = stops.find((s) => s.scope === "factory" && s.mode === "kill");
  return {
    people, matrix: matrix.value, policies, freezes,
    projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status, killed: p.killed, halted: p.halted, regulated: p.regulated })),
    repos: repos.map((r) => ({ id: r.id, name: r.name, project: r.project, halted: r.halted })),
    stops: { factory: f ? { by: f.by, at: f.at, reason: f.reason, scope: "factory", mode: f.inFlight ?? "hold" } : null },
    catalog,
    activeStops: stops,
  };
}

export interface FlowLoadOptions {
  /** Work orders are owned by the work-order area; it supplies its loader. Default: none. */
  workOrders?: (db: Queryable, orgId: string) => Promise<WorkOrder[]>;
}

/** Policy state plus full projects, repos, work orders and the full catalogue (domain `FlowState`). */
export async function loadFlowState(db: Queryable, orgId: string, opts: FlowLoadOptions = {}): Promise<FlowState> {
  const base = await loadPolicyState(db, orgId);
  const [projects, repos, workOrders] = await reads(db, [() => readProjects(db, orgId, base.activeStops), () => readRepos(db, orgId, base.activeStops), () => (opts.workOrders ? opts.workOrders(db, orgId) : Promise.resolve([] as WorkOrder[]))]);
  const { activeStops: _a, ...state } = base;
  return { ...state, projects, repos, workOrders, catalog: base.catalog };
}
