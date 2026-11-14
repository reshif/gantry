import type { Queryable } from "@gantry/db";
import { ms } from "../../core/read/rows.js";
import { apiStopId, type StopTarget } from "./targets.js";

export interface Impact { projects: number; workOrders: number; running: number; slots: number; prs: number; list: Array<{ id: string; title: string; state: string; position: string }> }

/** What a stop would touch (legacy `killImpact`): open work orders in scope, running agents, held slots and open pull requests. A read. */
export async function stopImpact(db: Queryable, orgId: string, t: StopTarget): Promise<Impact> {
  const where = t.scope === "factory" ? "true" : t.scope === "project" ? "w.project_id = $2" : t.scope === "repo" ? "w.repo_id = $2" : "(w.id = $2 or w.parent_id = $2)";
  const params: unknown[] = t.scope === "factory" ? [orgId] : [orgId, t.target];
  const wos = (await db.query<{ id: string; title: string; state: string; position: string }>(
    `select w.id, w.title, w.state, w.position from work_orders w where w.org_id = $1 and ${where} and w.state not in ('done','killed','declined') and w.position <> 'declined' order by w.id`, params,
  )).rows;
  const ids = wos.map((w) => w.id);
  const slots = ids.length ? Number((await db.query(`select count(*)::int as n from slots where org_id = $1 and state = 'held' and wo_id = any($2::text[])`, [orgId, ids])).rows[0].n) : 0;
  const prs = ids.length ? Number((await db.query(`select count(*)::int as n from pull_requests where org_id = $1 and state = 'open' and wo_id = any($2::text[])`, [orgId, ids])).rows[0].n) : 0;
  const projects = t.scope === "factory" ? Number((await db.query(`select count(*)::int as n from projects where org_id = $1 and status <> 'archived'`, [orgId])).rows[0].n) : t.scope === "project" ? 1 : 0;
  return { projects, workOrders: wos.length, running: wos.filter((w) => w.state === "running").length, slots, prs, list: wos };
}

/** The active stops, in the id convention the web uses. */
export async function listStops(db: Queryable, orgId: string, only?: { projects: string[] | "all" }) {
  const { rows } = await db.query<{ id: string; scope_type: string; project_id: string | null; repo_id: string | null; wo_id: string | null; mode: string; reason: string; in_flight: string | null; set_by: string; set_at: Date; version: number; fencing: string }>(
    `select id, scope_type, project_id, repo_id, wo_id, mode, reason, in_flight, set_by, set_at, version, fencing::text from stops where org_id = $1 and lifted_at is null order by set_at`, [orgId],
  );
  return rows
    .filter((r) => !only || only.projects === "all" || r.scope_type === "factory" || (r.project_id && only.projects.includes(r.project_id)))
    .map((r) => ({
      id: apiStopId(r.scope_type, r.scope_type === "project" ? r.project_id : r.scope_type === "repo" ? r.repo_id : r.wo_id), row: r.id, scope: r.scope_type === "wo" ? "workorder" : r.scope_type, mode: r.mode, reason: r.reason, inFlight: r.in_flight,
      by: r.set_by, at: ms(r.set_at) ?? 0, version: r.version, fencing: Number(r.fencing),
    }));
}
