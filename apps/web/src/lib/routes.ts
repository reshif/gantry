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
  /** Read permission (POST /api/v1/can). Access is default-deny: the item is hidden until the server allows it. */
  perm?: string;
}

/** Extra facts a rule may use that are not roles. */
export interface RouteCtx {
  /** Result of the audit.view permission, when already resolved. */
  canAudit?: boolean | undefined;
}

export const anyRole = (me: Me, roles: readonly string[]): boolean => me.person.roles.some((g) => roles.includes(g.role));

/**
 * Factory-wide pages (Access, Security, System health, Models with vendors, prices, budgets and routing) are for factory-level roles
 * only, held at factory scope: the same rule the server applies (a factory-scope right never reaches a project role). Display only.
 */
export const factoryRole = (me: Me, roles: readonly string[] = FACTORY_READ): boolean => me.person.roles.some((g) => g.scope === "factory" && roles.includes(g.role));

/** Factory-level roles that read the factory registers (the route rules are display only; the read rights decide). */
export const FACTORY_READ = ["factory_admin", "auditor", "factory_manager", "security_reviewer"] as const;
export const BUILD_READ = [...FACTORY_READ, "project_admin", "line_lead"] as const;

export const ROUTES: readonly RouteDef[] = [
  { id: "home", title: "Home", group: "Overview", icon: "home" },
  { id: "inbox", title: "Inbox", group: "Overview", icon: "mail" },
  { id: "projects", title: "Projects", group: "Overview", icon: "project" },
  { id: "workspace", title: "Agents at work", group: "Overview", icon: "chat" },
    { id: "console", title: "Console", group: "Overview", icon: "console" },
  { id: "floor", title: "Floor", group: "Project", icon: "belt", project: true },
  { id: "work-orders", title: "Work orders", group: "Project", icon: "list", project: true },
  { id: "conversations", title: "Conversations", group: "Project", icon: "chat", project: true },
  { id: "onboarding", title: "Onboarding", group: "Project", icon: "rocket", project: true },
  { id: "project-config", title: "Project config", group: "Project", icon: "filter", project: true },
  { id: "record", title: "Work order", group: "Project", icon: "record", project: true, nav: false },
  { id: "traveler", title: "Traveler", group: "Project", icon: "record", project: true, nav: false },
  { id: "dossier", title: "Dossier", group: "Project", icon: "record", project: true, nav: false },
  { id: "changes", title: "Changes", group: "Project", icon: "branch", project: true, nav: false },
  { id: "agents", title: "Agents", group: "Agents", icon: "agent", perm: "agents.view", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "skills", title: "Skills", group: "Agents", icon: "skill", perm: "agents.view", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "models", title: "Models", group: "Agents", icon: "model", perm: "models.view", canSee: (me) => factoryRole(me) },
  { id: "evals", title: "Evals", group: "Agents", icon: "eval", perm: "agents.view", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "trust", title: "Trust", group: "Agents", icon: "trust", perm: "agents.view", canSee: (me) => anyRole(me, [...BUILD_READ, "approver", "release_manager"]) },
  { id: "learning", title: "Learning", group: "Agents", icon: "learn", perm: "agents.view", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "integrations", title: "Integrations", group: "Connect", icon: "plug", perm: "integrations.view", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "notifications", title: "Notifications", group: "Connect", icon: "bell", perm: "integrations.view", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "mcp", title: "MCP servers", group: "Connect", icon: "server", perm: "integrations.view", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "api", title: "API and triggers", group: "Connect", icon: "api", perm: "integrations.view", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "people", title: "People", group: "Govern", icon: "people", perm: "people.view", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "person", title: "Person", group: "Govern", icon: "people", nav: false, perm: "people.view", canSee: (me) => anyRole(me, [...FACTORY_READ, "project_admin"]) },
  { id: "account", title: "Account", group: "Govern", icon: "user", nav: false },
  { id: "workload", title: "Workload", group: "Govern", icon: "workload", perm: "people.view", canSee: (me) => anyRole(me, BUILD_READ) },
  { id: "access", title: "Access", group: "Govern", icon: "lock", perm: "policy.view", canSee: (me) => factoryRole(me) },
  { id: "security", title: "Security", group: "Govern", icon: "shield", perm: "policy.view", canSee: (me) => factoryRole(me) },
  { id: "audit", title: "Audit ledger", group: "Govern", icon: "ledger", perm: "audit.view", canSee: (me, ctx) => ctx.canAudit === true || anyRole(me, ["project_admin"]) || (ctx.canAudit === undefined && anyRole(me, FACTORY_READ)) },
  { id: "system", title: "System health", group: "Govern", icon: "server", perm: "integrations.view", canSee: (me) => factoryRole(me) },
  { id: "design-system", title: "Design system", group: "Reference", icon: "info" },
];

/** Read actions behind each nav route, asked once per session. */
export const ROUTE_PERMS: ReadonlyArray<{ id: string; action: string }> = ROUTES.filter((r) => r.perm).map((r) => ({ id: r.id, action: r.perm as string }));

/** A person with no grants at all: only their own profile is readable. */
export const hasNoAccess = (me: Me): boolean => !me.projects.length && !me.person.roles.length;

export const NAV_GROUPS = ["Overview", "Project", "Agents", "Connect", "Govern"] as const;

export const isProjectRoute = (id: string): boolean => !!ROUTES.find((r) => r.id === id)?.project;

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

const FACTORY_WIDE = new Set<string>(FACTORY_READ);

/** Default landing for an empty hash: factory people see Home; someone with exactly one project lands on its Floor. */
export function landingFor(me: Me): { id: string; project: string | null } {
  if (hasNoAccess(me)) return { id: "home", project: null };
  const only = me.projects.length === 1 ? me.projects[0] : undefined;
  if (only && !me.person.roles.some((g) => FACTORY_WIDE.has(g.role))) return { id: "floor", project: only.id };
  return { id: "home", project: null };
}
