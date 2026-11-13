import { checkRoleDelete, type Matrix, type Role } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import { conflict, invalid, notFound, Refusal } from "../../core/errors.js";
import type { CommandResult } from "../../core/command.js";
import { readMatrix, readPeople, readPolicies, readRoles } from "../../core/read/index.js";
import { lockOrgConfig, publishMatrix, stateIn } from "./config.js";
import type { z } from "zod";
import type { RoleCreate, RolePatch } from "./schemas.js";

export const roleVersion = async (tx: Tx, orgId: string, id: string): Promise<number | null> =>
  (await tx.query(`select version from roles where org_id = $1 and id = $2`, [orgId, id])).rows[0]?.version ?? null;

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const roleOf = (r: { id: string; name: string; level: string; desc: string; base: string | null; version: number }): Role & { version: number } =>
  ({ id: r.id, name: r.name, level: r.level as Role["level"], custom: true, base: r.base, ...(r.desc ? { desc: r.desc } : {}), version: r.version });

/** A custom role is cloned from an existing one: its matrix row starts as a copy of the base role's row (legacy G.catalog.addRole). */
export async function addRole(tx: Tx, orgId: string, by: string, body: z.infer<typeof RoleCreate>): Promise<CommandResult<{ role: Role }>> {
  await lockOrgConfig(tx, orgId);
  const st = await stateIn(tx, orgId);
  const id = body.id ?? slug(body.name);
  if (!/^[a-z][a-z0-9_]{1,49}$/.test(id)) throw invalid("That name cannot be turned into a role id. Use letters and numbers.");
  if (st.catalog.roles.some((r) => r.id === id || r.name.toLowerCase() === body.name.toLowerCase())) throw conflict(`A role called ${body.name} exists.`);
  const baseId = body.base ?? "viewer";
  const base = st.catalog.roles.find((r) => r.id === baseId);
  if (!base) throw invalid("Unknown base role.");
  await tx.query(`insert into roles (org_id, id, name, level, builtin, description, data) values ($1,$2,$3,$4,false,$5,$6::jsonb)`, [orgId, id, body.name, body.level, body.desc, JSON.stringify({ base: baseId })]);
  const cur = await readMatrix(tx, orgId, st.catalog.actions);
  await publishMatrix(tx, orgId, { ...cur.value, [id]: { ...(cur.value[baseId] ?? {}) } }, `Role ${id} cloned from ${baseId}`, by);
  const role = roleOf({ id, name: body.name, level: body.level, desc: body.desc, base: baseId, version: 1 });
  return {
    msg: `${body.name} created with the rights of ${base.name}. Adjust them in the matrix.`,
    events: [{ type: "role.add", category: "access", subject: { type: "role", id }, after: { id, name: body.name, level: body.level, base: baseId }, projectId: null }],
    extra: { role },
    changes: ["matrix", "people"],
    project: null,
  };
}

export async function updateRole(tx: Tx, orgId: string, roleId: string, body: z.infer<typeof RolePatch>): Promise<CommandResult<{ version: number }>> {
  await lockOrgConfig(tx, orgId);
  const cur = (await readRoles(tx, orgId)).find((r) => r.id === roleId);
  if (!cur) throw notFound("No such role.");
  if (!cur.custom) throw conflict(`${cur.name} is built in. Edit its rights in the matrix.`);
  const next = { name: body.name ?? cur.name, desc: body.desc ?? cur.desc ?? "", level: body.level ?? cur.level };
  if (next.level !== cur.level) {
    const holders = (await readPeople(tx, orgId)).filter((p) => p.roles.some((g) => g.role === roleId));
    if (holders.length) throw conflict(`${holders.length} ${holders.length === 1 ? "person holds" : "people hold"} ${cur.name}. A role's scope cannot change while it is held.`);
  }
  const st = await stateIn(tx, orgId);
  if (next.name.toLowerCase() !== cur.name.toLowerCase() && st.catalog.roles.some((r) => r.id !== roleId && r.name.toLowerCase() === next.name.toLowerCase())) throw conflict(`A role called ${next.name} exists.`);
  const { rows } = await tx.query(`update roles set name = $3, description = $4, level = $5, version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`, [orgId, roleId, next.name, next.desc, next.level]);
  const version = rows[0]!.version as number;
  return {
    msg: `${next.name} saved.`,
    events: [{ type: "role.edit", category: "access", subject: { type: "role", id: roleId }, before: { name: cur.name, desc: cur.desc ?? "", level: cur.level }, after: next, projectId: null }],
    extra: { version },
    changes: ["matrix", "people"],
    project: null,
  };
}

/** Spec 14.4: a role cannot be deleted while assigned. Also refused while an approver rule or a policy names it. */
export async function removeRole(tx: Tx, orgId: string, by: string, roleId: string): Promise<CommandResult> {
  await lockOrgConfig(tx, orgId);
  const cur = (await readRoles(tx, orgId)).find((r) => r.id === roleId);
  if (!cur) throw notFound("No such role.");
  if (!cur.custom) throw conflict(`${cur.name} is built in and cannot be removed.`);
  const held = checkRoleDelete(await readPeople(tx, orgId), roleId);
  if (!held.ok) throw new Refusal({ ...held.error, msg: held.error.msg.replace(`Role ${roleId}`, cur.name) });
  const rules = await tx.query<{ project_id: string; gate_id: string }>(
    `select r.project_id, r.gate_id from approver_rules r join approver_rule_versions v on v.org_id = r.org_id and v.project_id = r.project_id and v.gate_id = r.gate_id and v.version = r.current_version
     where r.org_id = $1 and v.rule->'roles' ? $2`,
    [orgId, roleId],
  );
  if (rules.rows.length) throw conflict(`Approver rules in ${[...new Set(rules.rows.map((r) => r.project_id))].join(", ")} use ${cur.name}. Change them first.`);
  const pols = (await readPolicies(tx, orgId)).filter((p) => p.roles.includes(roleId));
  if (pols.length) throw conflict(`${pols.map((p) => p.id).join(", ")} ${pols.length === 1 ? "names" : "name"} ${cur.name}. Change ${pols.length === 1 ? "it" : "them"} first.`);
  // Only revoked or expired grants can remain (nobody holds it now); their history lives in the audit log.
  await tx.query(`delete from role_assignments where org_id = $1 and role_id = $2`, [orgId, roleId]);
  const m = await readMatrix(tx, orgId);
  const next: Matrix = { ...m.value };
  delete next[roleId];
  await publishMatrix(tx, orgId, next, `Role ${roleId} removed`, by);
  await tx.query(`delete from roles where org_id = $1 and id = $2`, [orgId, roleId]);
  return {
    msg: `${cur.name} removed.`,
    events: [{ type: "role.remove", category: "access", subject: { type: "role", id: roleId }, before: cur.name, after: null, projectId: null }],
    changes: ["matrix", "people"],
    project: null,
  };
}
