import type { Catalog, FlowState, PolicyState, WorkOrder } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { reads } from "./rows.js";
import { haltInfo, killInfo, readActiveStops, readCatalog, readFreezes, readMatrix, readOrg, readPeople, readPolicies, readProjects, readRepos, type ActiveStop } from "./index.js";

/**
 * Builds the permission engine's input from rows (spec 14.3). `stops.factory` comes from the active factory stop; project,
 * repo and work-order stops are folded into the records the engine reads. One call is a handful of reads: callers cache it per request.
 */
export async function loadPolicyState(db: Queryable, orgId: string): Promise<PolicyState & { catalog: Catalog; activeStops: ActiveStop[] }> {
  const stops = await readActiveStops(db, orgId);
  const org = await readOrg(db, orgId);
  // Only the columns the decision point uses: the full project read joins flow versions, approver rules and budgets, and the stop path
  // (spec 8.5, I7) must not fail because the flow engine's tables do.
  const [people, matrix, policies, freezes, projects, repos, catalog, teams] = await reads(db, [
    () => readPeople(db, orgId), () => readMatrix(db, orgId), () => readPolicies(db, orgId), () => readFreezes(db, orgId), () => policyProjects(db, orgId).then((r) => foldProjects(r, stops)), () => policyRepos(db, orgId).then((r) => foldRepos(r, stops)), () => readCatalog(db, orgId, org),
    () => db.query<{ id: string; name: string }>(`select id, name from teams where org_id = $1 order by created_at, id`, [orgId]).then((r) => r.rows),
  ]);
  const f = stops.find((s) => s.scope === "factory" && s.mode === "kill");
  return {
    people, matrix: matrix.value, policies, freezes,
    projects,
    repos,
    stops: { factory: f ? { by: f.by, at: f.at, reason: f.reason, scope: "factory", mode: f.inFlight ?? "hold" } : null },
    catalog,
    teams,
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

type PolicyProject = PolicyState["projects"][number];
type PolicyRepo = PolicyState["repos"][number];

export interface ProjectRow { id: string; name: string; status: string; regulated: boolean }
export interface RepoRow { id: string; name: string; project_id: string }

export async function policyProjects(db: Queryable, orgId: string): Promise<ProjectRow[]> {
  const { rows } = await db.query<ProjectRow>(`select id, name, status, regulated from projects where org_id = $1 order by position nulls last, created_at, id`, [orgId]);
  return rows;
}

export async function policyRepos(db: Queryable, orgId: string): Promise<RepoRow[]> {
  const { rows } = await db.query<RepoRow>(`select id, name, project_id from repos where org_id = $1 order by created_at, id`, [orgId]);
  return rows;
}

/** Folds the active stops into the project records the engine reads. */
export function foldProjects(rows: ProjectRow[], stops: ActiveStop[]): PolicyProject[] {
  return rows.map((r) => {
    const kill = stops.find((s) => s.scope === "project" && s.project === r.id && s.mode === "kill");
    const halt = stops.find((s) => s.scope === "project" && s.project === r.id && s.mode === "halt");
    return { id: r.id, name: r.name, status: r.status, killed: kill ? killInfo(kill) : null, halted: halt ? haltInfo(halt) : null, regulated: r.regulated } as PolicyProject;
  });
}

export function foldRepos(rows: RepoRow[], stops: ActiveStop[]): PolicyRepo[] {
  return rows.map((r) => {
    const halt = stops.find((s) => s.scope === "repo" && s.repo === r.id && s.mode === "halt");
    return { id: r.id, name: r.name, project: r.project_id, halted: halt ? haltInfo(halt) : null } as PolicyRepo;
  });
}
