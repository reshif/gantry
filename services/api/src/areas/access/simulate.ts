import { can, findPerson, permissionSources, simulate, visibleProjects, type Catalog, type Decision, type PolicyState, type SimulationResult } from "@gantry/domain";

export interface SimulateQuestion {
  person: string;
  action: string;
  project?: string | null;
  repo?: string | null;
  time?: number;
}

/**
 * The access simulator (spec 8.9). It calls domain `simulate()`, which calls the same `can()` the decision point uses for
 * enforcement, so the simulator and the engine cannot disagree. A project-scoped question needs a project (or a repo, which names one).
 */
export function runSimulation(st: PolicyState, q: SimulateQuestion, now: number): SimulationResult | { error: string } {
  if (!st.people.some((p) => p.id === q.person)) return { error: "No such person." };
  const act = (st.catalog?.actions ?? []).find((a) => a.id === q.action);
  if (!act) return { error: `There is no action ${q.action}.` };
  if (q.project && !st.projects.some((p) => p.id === q.project)) return { error: "No such project." };
  if (q.repo && !st.repos.some((r) => r.id === q.repo)) return { error: "No such repo." };
  return simulate(st, { person: q.person, action: q.action, project: q.project ?? null, repo: q.repo ?? null, time: q.time ?? now }, now);
}

export interface EffectivePermissions {
  person: string;
  at: number;
  projects: Array<{ id: string; name: string }>;
  actions: Array<{ id: string; name: string; group: string; scope: "project" | "factory" }>;
  /**
   * Project-scoped actions: `cells[actionId][projectId] = [allowed (1 or 0), deciding rule id, sources]`. `sources` lists where the role that grants
   * it comes from: "direct" and/or team ids (names in `teams`); empty when no role grants it. The reason for one cell comes from the simulator.
   */
  cells: Record<string, Record<string, [0 | 1, string, string[]]>>;
  /** Team names for the ids that appear as sources. */
  teams: Record<string, string>;
  /** The person's roles with their source: `via` is the team id for an inherited role. */
  grants: Array<{ role: string; roleName: string; scope: string; via: string | null }>;
  /** Deciding rules seen in `cells`, so a cell carries only the id. */
  rules: Record<string, { kind: string; name: string }>;
  /** Factory-scoped actions with the full decision (there are few). */
  factory: Record<string, Pick<Decision, "allowed" | "reason" | "rule" | "needs"> & { sources: string[] }>;
}

/**
 * Every action in every project the viewer can see, decided now by `can()`. Cells are compact tuples: for a dozen projects and
 * thirty actions the reasons alone would be tens of kilobytes, and only the cell the analyst opens needs its reason.
 */
export function effectivePermissions(st: PolicyState & { catalog: Catalog }, viewerId: string, personId: string, at: number): EffectivePermissions {
  const actions = st.catalog.actions;
  const visible = visibleProjects(st, viewerId).filter((p) => p.status !== "archived");
  const rules: EffectivePermissions["rules"] = {};
  const cells: EffectivePermissions["cells"] = {};
  const factory: EffectivePermissions["factory"] = {};
  const person = findPerson(st, personId)!;
  const used = new Set<string>(person.roles.flatMap((g) => (g.via ? [g.via] : [])));
  const src = (action: string, project: string | null, scoped: boolean): string[] => {
    const s = permissionSources(st, person, action, project, scoped);
    for (const x of s) if (x !== "direct") used.add(x);
    return s;
  };
  for (const a of actions) {
    if (a.scope === "factory") {
      const d = can(st, personId, a.id, { time: at });
      factory[a.id] = { allowed: d.allowed, reason: d.reason, rule: d.rule, needs: d.needs, sources: d.allowed ? src(a.id, null, false) : [] };
      continue;
    }
    const row: Record<string, [0 | 1, string, string[]]> = {};
    for (const p of visible) {
      const d = can(st, personId, a.id, { project: p.id, time: at });
      row[p.id] = [d.allowed ? 1 : 0, d.rule.id, d.allowed ? src(a.id, p.id, true) : []];
      rules[d.rule.id] ??= { kind: d.rule.kind, name: d.rule.name ?? "" };
    }
    cells[a.id] = row;
  }
  return {
    person: personId,
    at,
    projects: visible.map((p) => ({ id: p.id, name: p.name })),
    actions: actions.map((a) => ({ id: a.id, name: a.name, group: a.group, scope: a.scope })),
    cells,
    teams: Object.fromEntries([...used].map((id) => [id, st.teams?.find((t) => t.id === id)?.name ?? id])),
    grants: person.roles.map((g) => ({ role: g.role, roleName: st.catalog.roles.find((r) => r.id === g.role)?.name ?? g.role, scope: g.scope, via: g.via ?? null })),
    rules,
    factory,
  };
}
