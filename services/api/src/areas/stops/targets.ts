/** Stop scopes and targets (spec 9.7). API ids are `${scope}:${targetId}` with scope factory|project|repo|workorder; rows use scope_type factory|project|repo|wo. */
import type { Queryable } from "@gantry/db";
import { invalid, refuse } from "../../core/errors.js";
import { readStopSnapshot } from "../../core/stop-snapshot.js";

export type ScopeType = "factory" | "project" | "repo" | "wo";
export type ApiScope = "factory" | "project" | "repo" | "workorder";

export interface StopTarget {
  scope: ScopeType;
  /** project id, repo id or work order id; null for the factory. */
  target: string | null;
  project: string | null;
  repo: string | null;
  wo: string | null;
  /** What the person typed to confirm a kill: the project name; the factory needs KILL FACTORY. */
  name: string;
  regulated: boolean;
}

export const scopeFromApi = (s: string): ScopeType => (s === "workorder" || s === "wo" ? "wo" : s === "factory" || s === "project" || s === "repo" ? s : (() => { throw invalid("Scope is factory, project, repo or workorder."); })());
export const scopeToApi = (s: string): ApiScope => (s === "wo" ? "workorder" : (s as ApiScope));
/** The id the web uses: `${scope}:${targetId}`. */
export const apiStopId = (scope: string, target: string | null): string => `${scopeToApi(scope)}:${target ?? ""}`;

export function parseStopId(id: string): { scope: ScopeType; target: string | null } {
  const i = id.indexOf(":");
  if (i < 0) throw invalid("A stop id looks like project:payments.");
  const scope = scopeFromApi(id.slice(0, i));
  const target = id.slice(i + 1) || null;
  if (scope !== "factory" && !target) throw invalid("A stop id looks like project:payments.");
  return { scope, target: scope === "factory" ? null : target };
}

export async function resolveTarget(db: Queryable, orgId: string, scopeIn: string, idIn: string | null | undefined): Promise<StopTarget> {
  const scope = scopeFromApi(scopeIn);
  if (scope === "factory") return { scope, target: null, project: null, repo: null, wo: null, name: "the factory", regulated: false };
  const id = (idIn ?? "").trim();
  if (!id) throw invalid("Say which one.");
  // Spec 8.5, I7: if the projects or repos tables cannot be read, the target comes from the break-glass snapshot. Work orders have no fallback: the lookup is one row of work_orders.
  const snap = async () => (await readStopSnapshot(db, orgId).catch(() => null))?.snapshot ?? null;
  if (scope === "project") {
    const p = await (async () => {
      try {
        return (await db.query<{ id: string; name: string; regulated: boolean }>(`select id, name, regulated from projects where org_id = $1 and id = $2`, [orgId, id])).rows[0];
      } catch (err) {
        const s = await snap();
        if (!s) throw err;
        return s.projects.find((x) => x.id === id);
      }
    })();
    if (!p) throw refuse("not_found", "No such project.");
    return { scope, target: p.id, project: p.id, repo: null, wo: null, name: p.name, regulated: p.regulated };
  }
  if (scope === "repo") {
    const r = await (async () => {
      try {
        return (await db.query<{ id: string; name: string; project_id: string }>(`select id, name, project_id from repos where org_id = $1 and (id = $2 or name = $2) order by (id = $2) desc limit 1`, [orgId, id])).rows[0];
      } catch (err) {
        const s = await snap();
        if (!s) throw err;
        return s.repos.find((x) => x.id === id || x.name === id);
      }
    })();
    if (!r) throw refuse("not_found", "No such repo.");
    return { scope, target: r.id, project: r.project_id, repo: r.id, wo: null, name: r.name, regulated: false };
  }
  const w = (await db.query<{ id: string; project_id: string; repo_id: string | null }>(`select id, project_id, repo_id from work_orders where org_id = $1 and id = $2`, [orgId, id.toUpperCase()]).catch((err: unknown) => {
    throw Object.assign(new Error("Work orders cannot be read right now, so this work order cannot be looked up. Kill its project instead."), { cause: err, statusCode: 503 });
  })).rows[0];
  if (!w) throw refuse("not_found", "No such work order.");
  return { scope, target: w.id, project: w.project_id, repo: w.repo_id, wo: w.id, name: w.id, regulated: false };
}

/**
 * The catalogue action a stop command needs. Halt and resume of a project, repo or work order use the andon rights (project-scoped);
 * the whole factory needs its own factory-scoped rights, because a project-scoped right asked with no project counts a grant held on
 * any project, which would let an engineer on one project stop every line. Kill and restore use the per-scope rights.
 */
export const stopAction = (verb: "halt" | "resume" | "kill" | "restore", scope: ScopeType): string =>
  (verb === "halt" || verb === "resume") && scope === "factory" ? `${verb}.factory`
  : verb === "halt" ? "line.halt" : verb === "resume" ? "line.resume" : `${verb}.${scope === "wo" ? "workorder" : scope === "repo" ? "project" : scope}`;
