/** MCP registry reads (spec 8.8): rows to the legacy `G.store.mcp` and `mcpUsage` shapes the screen reads. */
import type { McpServer, McpTool, McpUsage } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { asScope } from "./scope.js";

export interface ServerRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  disabled_reason: string | null;
  secret_enc: string | null;
  secret_mask: string | null;
  version: number;
  transport: "http" | "sse";
  protocol_revision: string;
  auth_mode: "none" | "bearer" | "header";
  auth_header: string | null;
  sensitivity: string;
  health: string;
  health_detail: string | null;
  discovered_at: Date | null;
  projects: unknown;
  repos: unknown;
  agents: unknown;
  stations: unknown;
  classes: unknown;
}

export interface ToolRow {
  server_id: string;
  name: string;
  definition_hash: string;
  tool_class: "read" | "write";
  allowed: boolean;
  definition: { description?: string; inputSchema?: unknown; annotations?: unknown; title?: string } | null;
  hint: "read" | "write" | null;
  pending_hash: string | null;
}

const SERVER_SQL = `select s.id, s.name, s.url, s.enabled, s.disabled_reason, s.secret_enc, s.secret_mask, s.version, s.transport, s.protocol_revision, s.auth_mode, s.auth_header,
       s.sensitivity, s.health, s.health_detail, s.discovered_at, sc.projects, sc.repos, sc.agents, sc.stations, sc.classes
  from mcp_servers s left join mcp_scopes sc on sc.org_id = s.org_id and sc.server_id = s.id`;

export async function readServerRows(db: Queryable, orgId: string, id?: string, lock = false): Promise<ServerRow[]> {
  const { rows } = await db.query<ServerRow>(`${SERVER_SQL} where s.org_id = $1 ${id ? "and s.id = $2" : ""} order by s.created_at, s.id ${lock ? "for update of s" : ""}`, id ? [orgId, id] : [orgId]);
  return rows;
}

export async function readToolRows(db: Queryable, orgId: string, id?: string): Promise<ToolRow[]> {
  const { rows } = await db.query<ToolRow>(
    `select server_id, name, definition_hash, tool_class, allowed, definition, hint, pending_hash from mcp_tools where org_id = $1 ${id ? "and server_id = $2" : ""} order by server_id, name`,
    id ? [orgId, id] : [orgId],
  );
  return rows;
}

export const authLabel = (mode: ServerRow["auth_mode"], header: string | null): string => (mode === "none" ? "None" : mode === "bearer" ? "Bearer token" : `API key (${header ?? "x-api-key"})`);

export function toolOf(t: ToolRow): McpTool {
  return { name: t.name, write: t.tool_class === "write", allowed: t.allowed, hint: t.hint, description: t.definition?.description ?? "", hash: t.definition_hash, ...(t.pending_hash ? { changed: true } : {}) };
}

export function serverOf(r: ServerRow, tools: ToolRow[]): McpServer {
  return {
    id: r.id, name: r.name, transport: r.transport, url: r.url,
    auth: authLabel(r.auth_mode, r.auth_header), authMode: r.auth_mode, authHeader: r.auth_header, authMask: r.secret_mask || "none",
    health: r.enabled || r.health !== "healthy" ? r.health : "offline",
    sensitivity: r.sensitivity,
    // Spec 12.4: write tools always need a station pre-authorisation. There is no switch that turns that off.
    writeGate: true,
    tools: tools.filter((t) => t.server_id === r.id).map(toolOf),
    projects: asScope(r.projects, []), repos: asScope(r.repos, []), agents: asScope(r.agents, []), stations: asScope(r.stations, []), classes: asScope(r.classes, "all"),
    protocolRevision: r.protocol_revision, enabled: r.enabled, disabledReason: r.disabled_reason, healthDetail: r.health_detail,
    discoveredAt: r.discovered_at ? r.discovered_at.getTime() : null, version: r.version,
  };
}

export async function readServers(db: Queryable, orgId: string): Promise<McpServer[]> {
  const [rows, tools] = await Promise.all([readServerRows(db, orgId), readToolRows(db, orgId)]);
  return rows.map((r) => serverOf(r, tools));
}

export async function readServer(db: Queryable, orgId: string, id: string): Promise<McpServer | null> {
  const [row] = await readServerRows(db, orgId, id);
  return row ? serverOf(row, await readToolRows(db, orgId, id)) : null;
}

export interface CallFilter {
  server?: string | undefined;
  agent?: string | undefined;
  project?: string | undefined;
  outcome?: string | undefined;
  limit: number;
  before?: number | undefined;
}

interface CallRow {
  id: string;
  at: Date;
  server_id: string;
  tool: string;
  agent_id: string | null;
  project_id: string | null;
  outcome: string;
  latency_ms: number | null;
  wo_id: string | null;
  station: string | null;
  args_hash: string | null;
  reason: string | null;
}

export async function readCalls(db: Queryable, orgId: string, f: CallFilter): Promise<McpUsage[]> {
  const args: unknown[] = [orgId];
  const where: string[] = ["org_id = $1"];
  const add = (column: string, op: string, v: unknown): void => {
    args.push(v);
    where.push(`${column} ${op} $${args.length}`);
  };
  if (f.server) add("server_id", "=", f.server);
  if (f.agent) add("agent_id", "=", f.agent);
  if (f.project) add("project_id", "=", f.project);
  if (f.outcome) add("outcome", "=", f.outcome);
  if (f.before) add("id", "<", f.before);
  args.push(f.limit);
  const { rows } = await db.query<CallRow>(
    `select id, at, server_id, tool, agent_id, project_id, outcome, latency_ms, wo_id, station, args_hash, reason from mcp_calls where ${where.join(" and ")} order by id desc limit $${args.length}`,
    args,
  );
  return rows.map((r) => ({
    id: Number(r.id), at: r.at.getTime(), server: r.server_id, tool: r.tool, agent: r.agent_id ?? "", project: r.project_id ?? "",
    outcome: r.outcome, ms: r.latency_ms ?? 0, wo: r.wo_id, station: r.station, argsHash: r.args_hash, reason: r.reason,
  }));
}
