import { checkMatrixEdit, type Matrix } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import { conflict, invalid, notFound, refuse, Refusal } from "../../core/errors.js";
import type { CommandResult } from "../../core/command.js";
import { readMatrix, readPeople } from "../../core/read/index.js";
import { lockOrgConfig, publishMatrix, stateIn } from "./config.js";

export const matrixVersion = async (tx: Tx, orgId: string): Promise<number> => (await readMatrix(tx, orgId)).version;

/** One cell of the role matrix (spec 8.9, 14.4). Every edit publishes a new immutable matrix version. */
export async function setMatrixCell(tx: Tx, orgId: string, by: string, roleId: string, actionId: string, on: boolean): Promise<CommandResult<{ version: number }>> {
  await lockOrgConfig(tx, orgId);
  const st = await stateIn(tx, orgId);
  const role = st.catalog.roles.find((r) => r.id === roleId);
  const action = st.catalog.actions.find((a) => a.id === actionId);
  if (!role) throw notFound(`There is no role ${roleId}.`);
  if (!action) throw invalid(`There is no action ${actionId}.`);
  // policy.edit must not be self-elevating: adding a right to a role the editor holds (directly or through a team) needs a Factory Admin.
  const editor = st.people.find((p) => p.id === by);
  if (on && editor?.roles.some((g) => g.role === roleId) && !editor.roles.some((g) => g.role === "factory_admin" && g.scope === "factory"))
    throw refuse("denied", `You hold ${role.name}, so you cannot add rights to it. Ask a Factory Admin.`, { needs: "factory_admin" });
  const cur = await readMatrix(tx, orgId, st.catalog.actions);
  const before = !!cur.value[roleId]?.[actionId];
  const checked = checkMatrixEdit(cur.value, await readPeople(tx, orgId), { role: roleId, action: actionId, value: on }, st.catalog);
  if (!checked.ok) throw new Refusal(checked.error);
  if (before === on) return { msg: `${role.name} already ${on ? "can" : "cannot"} ${action.name.toLowerCase()}.`, events: [], extra: { version: cur.version }, changes: ["matrix"], project: null };
  const next: Matrix = { ...cur.value, [roleId]: { ...(cur.value[roleId] ?? {}), [actionId]: on } };
  const version = await publishMatrix(tx, orgId, next, `${role.name} ${on ? "may" : "may not"} ${actionId}`, by);
  return {
    msg: `${role.name} ${on ? "can now" : "can no longer"} ${action.name.toLowerCase()}.`,
    events: [{ type: "policy.matrix", category: "access", subject: { type: "matrix", id: `${roleId}:${actionId}` }, before, after: on, projectId: null }],
    extra: { version },
    changes: ["matrix", "policies"],
    project: null,
  };
}

export { conflict };
