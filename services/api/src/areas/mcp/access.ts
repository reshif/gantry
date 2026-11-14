/** The effective-access check on the MCP screen (spec 8.8 GET /mcp/access-check): the same scope function the gateway uses, plus the tool rules. */
import type { Queryable } from "@gantry/db";
import { scopeVerdict } from "./scope.js";
import { readServerRows, readToolRows } from "./store.js";

export interface AccessQuery { server: string; tool: string; agent: string; project: string; repo?: string | undefined; station: string; cls?: string | undefined }
export interface AccessDecision { allowed: boolean; gated?: boolean; reason: string; rule: string }

const no = (reason: string, rule: string): AccessDecision => ({ allowed: false, reason, rule });

export async function checkAccess(db: Queryable, orgId: string, q: AccessQuery): Promise<AccessDecision> {
  const srv = (await readServerRows(db, orgId, q.server))[0];
  if (!srv) return no("No such MCP server.", "server");
  const tool = (await readToolRows(db, orgId, q.server)).find((t) => t.name === q.tool);
  if (!tool) return no("Pick a tool.", "tool");
  const proj = (await db.query<{ name: string; config: { mcp?: unknown } }>(`select name, config from projects where org_id = $1 and id = $2`, [orgId, q.project])).rows[0];
  if (!proj) return no(`No such project ${q.project}.`, "project scope");
  const label = async (table: string, id: string | undefined): Promise<string | undefined> => (id ? (await db.query<{ name: string }>(`select name from ${table} where org_id = $1 and id = $2`, [orgId, id])).rows[0]?.name : undefined);
  const v = scopeVerdict(srv, {
    project: q.project, projectEnabled: Array.isArray(proj.config.mcp) ? (proj.config.mcp as string[]) : [], serverId: srv.id, repo: q.repo || undefined, agent: q.agent, station: q.station, cls: q.cls || undefined,
  }, { server: srv.name, project: proj.name, ...(q.repo ? { repo: await label("repos", q.repo) ?? q.repo } : {}), agent: (await label("agents", q.agent)) ?? q.agent });
  if (!srv.enabled) return no(`${srv.name} is disabled${srv.disabled_reason ? `: ${srv.disabled_reason}` : "."}`, "server disabled");
  if (v) return no(v.reason, v.rule);
  if (tool.pending_hash) return no(`The definition of ${tool.name} changed and is waiting for re-approval.`, "definition");
  if (!tool.allowed) return no(`${tool.name} is denied on this server.`, "tool deny");
  if (tool.tool_class === "write") return { allowed: true, gated: true, reason: `${tool.name} writes, so each call needs a station pre-authorisation for the work order and attempt.`, rule: "write pre-authorisation" };
  return { allowed: true, reason: "Allowed by project, repo, agent, station, work class and tool scope.", rule: "scope" };
}
