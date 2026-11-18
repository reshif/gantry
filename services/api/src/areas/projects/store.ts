import type { ApproverRule, Catalog, Decision, Project, ProjectFlow } from "@gantry/domain";
import type { Queryable, Tx } from "@gantry/db";
import type { FastifyRequest } from "fastify";
import type { CommandSpec } from "../../core/command.js";
import { refuseDecision } from "../../core/decide.js";
import { notFound, stale } from "../../core/errors.js";
import { readCatalog, readProjects } from "../../core/read/index.js";
import { draftOf, type CatalogParts, type FlowDraft } from "./flowedit.js";

/** One project as the legacy `G.store.projects` shape, read inside the caller's transaction or from the pool. */
export async function readProject(db: Queryable, orgId: string, id: string): Promise<Project | null> {
  return (await readProjects(db, orgId)).find((p) => p.id === id) ?? null;
}

export const projectVersion = (orgId: string, id: string) => async (tx: Tx): Promise<number | null> =>
  (await tx.query<{ version: number }>(`select version from projects where org_id = $1 and id = $2`, [orgId, id])).rows[0]?.version ?? null;

export interface ProjectRow {
  id: string;
  name: string;
  key: string;
  status: "new" | "onboarding" | "active" | "archived";
  version: number;
  owner_id: string | null;
  template_id: string | null;
  regulated: boolean;
  config: Record<string, unknown>;
  current_flow_version: number | null;
}

/** Locks the project row for the rest of the transaction and re-checks `If-Match` against the locked row (a concurrent command may have won). */
export async function lockProject(tx: Tx, orgId: string, id: string, ifMatch: number | null): Promise<ProjectRow> {
  const { rows } = await tx.query<ProjectRow>(
    `select id, name, key, status, version, owner_id, template_id, regulated, config, current_flow_version from projects where org_id = $1 and id = $2 for update`,
    [orgId, id],
  );
  const r = rows[0];
  if (!r) throw notFound("No such project.");
  if (ifMatch !== null && r.version !== ifMatch) throw stale();
  return r;
}

/**
 * Spec 15.4: a stopped scope refuses with the reason, and the refusal is audited like any denial.
 * `edit` (flow, config, classes): refused in an archived or killed project and while the factory is killed.
 * `light` (approvers, members): refused only in an archived project, so access can still be revoked during an incident.
 */
export async function refuseIfStopped(_req: FastifyRequest, _spec: Pick<CommandSpec, "action" | "scope">, tx: Tx, orgId: string, projectId: string, level: "edit" | "light" = "edit"): Promise<void> {
  const p = (await tx.query<{ name: string; status: string }>(`select name, status from projects where org_id = $1 and id = $2`, [orgId, projectId])).rows[0];
  if (!p) throw notFound("No such project.");
  let reason: string | null = p.status === "archived" ? `${p.name} is archived and read-only. Unarchive it to change it.` : null;
  if (!reason && level === "edit") {
    const s = (
      await tx.query<{ scope_type: string; reason: string }>(
        `select scope_type, reason from stops where org_id = $1 and lifted_at is null and mode = 'kill' and (scope_type = 'factory' or (scope_type = 'project' and project_id = $2)) order by scope_type limit 1`,
        [orgId, projectId],
      )
    ).rows[0];
    if (s) reason = `${s.scope_type === "factory" ? "The factory" : p.name} is killed: ${s.reason || "no reason given"}. Restore it to change its configuration.`;
  }
  if (!reason) return;
  // The command pipeline audits this refusal as a denial (in its own transaction) when it reaches it.
  const d: Decision = { allowed: false, reason, rule: { kind: "stop", id: "STOP", name: "Stop state" }, needs: "" };
  throw refuseDecision(d);
}

/** Loads the project's flow, approver rules and the org catalogue as an editable draft. */
export async function loadDraft(tx: Tx, orgId: string, projectId: string): Promise<{ draft: FlowDraft; project: Project }> {
  const project = await readProject(tx, orgId, projectId);
  if (!project) throw notFound("No such project.");
  const cat = await readCatalog(tx, orgId);
  const draft = draftOf(projectId, project.flow as ProjectFlow, project.approvers as Record<string, ApproverRule>, cat);
  return { draft, project };
}

/** Appends a new catalogue (stations only ever append). The org row is locked so two projects adding stations do not race. */
export async function saveCatalog(tx: Tx, orgId: string, parts: CatalogParts): Promise<void> {
  await tx.query(`select 1 from orgs where id = $1 for update`, [orgId]);
  await tx.query(
    `update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{catalog}', coalesce(settings->'catalog', '{}'::jsonb) || $2::jsonb), version = version + 1, updated_at = now() where id = $1`,
    [orgId, JSON.stringify({ stations: parts.stations, gates: parts.gates, bays: parts.bays, classes: parts.classes })],
  );
}

/** Publishes a new immutable flow version, makes it current, keeps `gate_modes` in step, and bumps the project's version. */
export async function publishFlow(tx: Tx, orgId: string, projectId: string, flow: ProjectFlow, by: string, note: string): Promise<number> {
  const v = Number((await tx.query(`select coalesce(max(version), 0) + 1 as v from flow_versions where org_id = $1 and project_id = $2`, [orgId, projectId])).rows[0].v);
  await tx.query(`insert into flow_versions (org_id, project_id, version, doc, note, published_at, published_by) values ($1,$2,$3,$4::jsonb,$5, now(), $6)`, [orgId, projectId, v, JSON.stringify(flow), note, by]);
  await tx.query(`update projects set current_flow_version = $3, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [orgId, projectId, v]);
  for (const [gateId, g] of Object.entries(flow.gates)) {
    if (g.absent) continue;
    await tx.query(
      `insert into gate_modes (org_id, project_id, gate_id, mode, enabled) values ($1,$2,$3,$4,$5)
       on conflict (org_id, project_id, gate_id) do update set mode = excluded.mode, enabled = excluded.enabled`,
      [orgId, projectId, gateId, g.mode, g.enabled],
    );
  }
  return v;
}

/** Publishes a new version of one gate's approver rule. */
export async function publishRule(tx: Tx, orgId: string, projectId: string, gateId: string, rule: ApproverRule, by: string, note = ""): Promise<number> {
  await tx.query(`insert into approver_rules (org_id, project_id, gate_id) values ($1,$2,$3) on conflict do nothing`, [orgId, projectId, gateId]);
  const v = Number((await tx.query(`select coalesce(max(version), 0) + 1 as v from approver_rule_versions where org_id = $1 and project_id = $2 and gate_id = $3`, [orgId, projectId, gateId])).rows[0].v);
  await tx.query(`insert into approver_rule_versions (org_id, project_id, gate_id, version, rule, note, published_at, published_by) values ($1,$2,$3,$4,$5::jsonb,$6, now(), $7)`, [orgId, projectId, gateId, v, JSON.stringify(rule), note, by]);
  await tx.query(`update approver_rules set current_version = $4, updated_at = now() where org_id = $1 and project_id = $2 and gate_id = $3`, [orgId, projectId, gateId, v]);
  return v;
}

/** Persists a draft: catalogue (when an entry was appended), approver rules that changed, and a new flow version. Returns the flow version. */
export async function persistDraft(tx: Tx, orgId: string, d: FlowDraft, by: string, note: string): Promise<number> {
  if (d.catalogChanged) await saveCatalog(tx, orgId, d.catalog);
  for (const gateId of d.rulesChanged) {
    const rule = d.approvers[gateId];
    if (rule) await publishRule(tx, orgId, d.projectId, gateId, rule, by, note);
  }
  return publishFlow(tx, orgId, d.projectId, d.flow, by, note);
}

export async function openWorkOrders(db: Queryable, orgId: string, projectId: string, where: { position?: string; cls?: string }): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from work_orders where org_id = $1 and project_id = $2 and state not in ('done','killed','declined')
       and ($3::text is null or position = $3) and ($4::text is null or class = $4)`,
    [orgId, projectId, where.position ?? null, where.cls ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function openByClass(db: Queryable, orgId: string, projectId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ class: string; n: string }>(
    `select class, count(*) as n from work_orders where org_id = $1 and project_id = $2 and state not in ('done','killed','declined') group by class`,
    [orgId, projectId],
  );
  return Object.fromEntries(rows.map((r) => [r.class, Number(r.n)]));
}

export type { Catalog };

/** The caller holds a factory-scope Factory Admin grant now (decided from the role assignments, never from a role name in a request). Null when not. */
export async function factoryAdminActor(tx: Tx, a: { orgId: string; personId: string | null; now: Date }): Promise<{ id: string; name: string } | null> {
  if (!a.personId) return null;
  const { rows } = await tx.query<{ name: string }>(
    `select p.name from people p where p.org_id = $1 and p.id = $2 and p.status = 'active' and exists (select 1 from effective_role_assignments r where r.org_id = p.org_id and r.person_id = p.id and r.role_id = 'factory_admin' and r.project_id is null and r.revoked_at is null and (r.expires_at is null or r.expires_at > now()))`,
    [a.orgId, a.personId],
  );
  return rows[0] ? { id: a.personId, name: rows[0].name } : null;
}
