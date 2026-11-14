/**
 * MCP scope resolution (spec 12.4): which projects, repos, agents, stations and work classes may use a server.
 * One pure function shared by the run spec (which servers a run sees), the gateway's authorisation and the access check on the screen,
 * so the three cannot disagree. An empty list means nobody; "all" means everyone, including ones added later.
 */
export type ScopeList = "all" | string[];

export interface ScopeRow {
  projects: unknown;
  repos: unknown;
  agents: unknown;
  stations: unknown;
  classes: unknown;
}

/** `undefined` for repo and cls means "any" (the access check's "Any repo"); `null` means the run has none, which only an "all" scope accepts. */
export interface ScopeQuery {
  project: string;
  /** The project's own list of enabled servers (Project config). */
  projectEnabled: readonly string[];
  serverId: string;
  repo: string | null | undefined;
  agent: string | null;
  station: string | null;
  cls: string | null | undefined;
}

export interface ScopeVerdict {
  code: "project" | "project-config" | "repo" | "agent" | "station" | "class";
  reason: string;
  rule: string;
}

export const inList = (v: unknown, x: string | null): boolean => v === "all" || (Array.isArray(v) && x !== null && v.includes(x));

export const asScope = (v: unknown, fallback: ScopeList): ScopeList => (v === "all" ? "all" : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback);

export function scopeVerdict(s: ScopeRow, q: ScopeQuery, names: { server: string; project?: string; repo?: string; agent?: string; station?: string; cls?: string }): ScopeVerdict | null {
  const project = names.project ?? q.project;
  if (!inList(s.projects, q.project)) return { code: "project", reason: `${names.server} is not scoped to ${project}.`, rule: "project scope" };
  if (!q.projectEnabled.includes(q.serverId)) return { code: "project-config", reason: `${project} has not enabled ${names.server} in Project config.`, rule: "project config" };
  if (q.repo !== undefined && !inList(s.repos, q.repo)) return { code: "repo", reason: `Repo ${names.repo ?? q.repo ?? "(none)"} is outside this server's repo scope.`, rule: "repo scope" };
  if (!inList(s.agents, q.agent)) return { code: "agent", reason: `${names.agent ?? q.agent ?? "This agent"} is not allowed to use ${names.server}.`, rule: "agent scope" };
  if (!inList(s.stations, q.station)) return { code: "station", reason: `Not available at ${names.station ?? q.station ?? "this station"}.`, rule: "station scope" };
  if (q.cls !== undefined && !inList(s.classes ?? "all", q.cls)) return { code: "class", reason: `Not available for ${names.cls ?? q.cls ?? "this"} work.`, rule: "class scope" };
  return null;
}
