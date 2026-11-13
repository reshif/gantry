/**
 * Route table ported from legacy app.js: same ids, titles, groups, icons and canSee rules.
 * Visibility is display only (the server decides); it reads the roles on `me.person`.
 */
import type { Me } from "../api/types";

export interface RouteDef {
  id: string;
  title: string;
  group: string;
  icon: string;
  /** A project route needs at least one visible project. */
  project?: boolean;
  /** false: reachable by hash but not listed in the nav. */
  nav?: boolean;
  canSee?: (me: Me, ctx: RouteCtx) => boolean;
}

/** Extra facts a rule may use that are not roles. */
export interface RouteCtx {
  /** Result of the audit.view permission, when already resolved. */
  canAudit?: boolean | undefined;
}

export const anyRole = (me: Me, roles: readonly string[]): boolean => me.person.roles.some((g) => roles.includes(g.role));

export const FACTORY_READ = ["factory_admin", "auditor"] as const;
export const BUILD_READ = [...FACTORY_READ, "project_admin", "line_lead"] as const;

export const ROUTES: readonly RouteDef[] = [
  { id: "home", title: "Home", group: "Overview", icon: "home" },
  { id: "projects", title: "Projects", group: "Overview", icon: "project" },
  { id: "console", title: "Console", group: "Overview", icon: "console" },
  { id: "floor", title: "Floor", group: "Project", icon: "belt", project: true },
  { id: "work-orders", title: "Work orders", group: "Project", icon: "list", project: true },
  { id: "conversations", title: "Conversations", group: "Project", icon: "chat", project: true },
  { id: "onboarding", title: "Onboarding", group: "Project", icon: "rocket", project: true },
  { id: "project-config", title: "Project config", group: "Project", icon: "filter", project: true },
  { id: "record", title: "Work order record", group: "Project", icon: "record", project: true, nav: false },
  { id: "agents", title: "Agents", group: "Agents", icon: "agent", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "skills", title: "Skills", group: "Agents", icon: "skill", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "models", title: "Models", group: "Agents", icon: "model", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "evals", title: "Evals", group: "Agents", icon: "eval", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "trust", title: "Trust", group: "Agents", icon: "trust", canSee: (me) => anyRole(me, [...BUILD_READ, "approver", "release_manager"]) },
  { id: "learning", title: "Learning", group: "Agents", icon: "learn", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "integrations", title: "Integrations", group: "Connect", icon: "plug", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "notifications", title: "Notifications", group: "Connect", icon: "bell", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "mcp", title: "MCP servers", group: "Connect", icon: "server", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "api", title: "API & triggers", group: "Connect", icon: "api", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "people", title: "People & teams", group: "Govern", icon: "people", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "workload", title: "Workload", group: "Govern", icon: "workload", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "access", title: "Access", group: "Govern", icon: "lock", canSee: (me) => anyRole(me, FACTORY_READ) },
  { id: "security", title: "Security", group: "Govern", icon: "shield", canSee: (me) => anyRole(me, FACTORY_READ) },
  { id: "audit", title: "Audit", group: "Govern", icon: "ledger", canSee: (me, ctx) => ctx.canAudit === true || anyRole(me, ["project_admin"]) || (ctx.canAudit === undefined && anyRole(me, FACTORY_READ)) },
];

export const NAV_GROUPS = ["Overview", "Project", "Agents", "Connect", "Govern"] as const;

export const routeDef = (id: string): RouteDef | undefined => ROUTES.find((r) => r.id === id);

export function canSeeRoute(id: string, me: Me | null, ctx: RouteCtx = {}): boolean {
  if (!me) return false;
  const r = routeDef(id);
  if (!r) return false;
  if (r.project && !me.projects.length) return false;
  return r.canSee ? r.canSee(me, ctx) : true;
}

/** The route to show for a hash id: unknown ids and routes the person cannot see fall back to home. */
export function resolveRoute(id: string, me: Me | null, ctx: RouteCtx = {}): { id: string; denied: RouteDef | null } {
  const def = routeDef(id);
  if (!def) return { id: "home", denied: null };
  if (!canSeeRoute(id, me, ctx)) return { id: "home", denied: id === "home" ? null : def };
  return { id, denied: null };
}

/** Visible projects the person may pick, and the current one (first when the stored one is not visible). */
export function pickProject(me: Me | null, stored: string | null): string | null {
  if (!me || !me.projects.length) return null;
  return me.projects.some((p) => p.id === stored) ? stored : (me.projects[0]?.id ?? null);
}
