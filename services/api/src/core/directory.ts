/**
 * The project directory (Wave 3, F3/F5). The factory registers (people, teams, agents, skills, MCP servers, integrations) are
 * factory-level reads. Someone who only holds project roles still has to see who and what works on their own projects: the
 * names on the floor, the agent staffing a station, the teams on the project. For them the same list endpoints answer with a
 * directory view instead of a 403: only the rows that touch a project they can see, with the fields that would tell them about
 * other projects or about configuration (instructions, skill bodies, server URLs, other projects' grants) removed.
 *
 * The read gate decides which view a request gets and marks it on `req.gx.directory`; each list handler passes its rows through
 * `directoryOf` before answering. Detail reads under the same paths stay strictly gated.
 */
import { visibleProjects, type Agent, type McpServer, type Person, type Skill, type Team } from "@gantry/domain";
import type { FastifyRequest } from "fastify";
import { policyState } from "./decide.js";

/** The list endpoints that have a directory view. Exact paths only (no sub-resources). */
export const DIRECTORY_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/people",
  "/api/v1/teams",
  "/api/v1/agents",
  "/api/v1/skills",
  "/api/v1/mcp/servers",
  "/api/v1/integrations",
  "/api/v1/integration-types",
]);

/** The projects this reader may see, when they get the directory view; null when they hold the factory-level read. */
export async function directoryScope(req: FastifyRequest): Promise<Set<string> | null> {
  if (!req.gx.directory) return null;
  const who = req.gx.principal?.kind === "person" ? req.gx.principal.id : null;
  if (!who) return new Set();
  const st = await policyState(req);
  return new Set(visibleProjects(st, who).map((p) => p.id));
}

const touches = (scope: "all" | readonly string[] | null | undefined, mine: Set<string>): boolean => scope === "all" || (Array.isArray(scope) && scope.some((x) => mine.has(x)));
const shownGrant = (g: { role: string; scope: string }, mine: Set<string>): boolean => mine.has(g.scope) || (g.scope === "factory" && g.role === "factory_admin");

/** People who hold a role on one of the reader's projects (and the Factory Admins, who act on every project). */
export function directoryPeople(rows: Person[], mine: Set<string>, teams: Team[] = []): Person[] {
  const visibleTeams = new Set(directoryTeams(teams, mine).map((t) => t.id));
  return rows
    .filter((p) => p.status !== "deactivated" && p.roles.some((g) => shownGrant(g, mine)))
    .map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title,
      email: p.email,
      github: p.github,
      status: p.status,
      oncall: p.oncall,
      away: p.away,
      teams: p.teams.filter((t) => visibleTeams.has(t)),
      roles: p.roles.filter((g) => shownGrant(g, mine)),
    }));
}

/** Teams that hold a role on one of the reader's projects, with only those grants. */
export function directoryTeams(rows: Team[], mine: Set<string>): Team[] {
  return rows
    .filter((t) => (t.roles ?? []).some((g) => mine.has(g.scope)))
    .map((t) => ({ ...t, roles: (t.roles ?? []).filter((g) => mine.has(g.scope)) }));
}

/** Agents that work on one of the reader's projects. Instructions, version history and other projects' overrides are dropped. */
export function directoryAgents(rows: Agent[], mine: Set<string>): Agent[] {
  return rows
    .filter((a) => touches(a.projects, mine))
    .map((a) => ({
      ...a,
      instructions: "",
      versions: [],
      projects: a.projects === "all" ? "all" : a.projects.filter((x) => mine.has(x)),
      overrides: Object.fromEntries(Object.entries(a.overrides ?? {}).filter(([k]) => mine.has(k))),
    }));
}

/** Skills available on one of the reader's projects: names and descriptions, not their bodies. */
export function directorySkills(rows: Skill[], mine: Set<string>): Skill[] {
  return rows
    .filter((s) => touches(s.projects, mine))
    .map((s) => ({ ...s, body: "", versions: [], resources: [], projects: s.projects === "all" ? "all" : s.projects.filter((x) => mine.has(x)) }));
}

/** MCP servers available on one of the reader's projects, without where they live or how they authenticate. */
export function directoryServers(rows: McpServer[], mine: Set<string>): McpServer[] {
  return rows
    .filter((s) => touches(s.projects, mine))
    .map((s) => ({ ...s, url: "", auth: "", authMask: "", authHeader: null, healthDetail: null, projects: s.projects === "all" ? "all" : s.projects.filter((x) => mine.has(x)) }));
}
