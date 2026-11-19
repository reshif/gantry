/**
 * Rules the engine itself enforces on configuration: spec 5.1 (I1-I9) and 14.4.
 * Each check returns a Result so the command pipeline can refuse with a typed error.
 */
import { DEFAULT_CATALOG, roleMayHold } from "./catalog.js";
import { err, gantryError, ok } from "./result.js";
import type { GantryError, Result, RuleRef } from "./result.js";
import type { Catalog, Matrix, Person, RoleGrant } from "./types.js";

const rule = (id: string, name: string): RuleRef => ({ kind: "invariant", id, name });

/** Rights that must stay reachable by at least one active person (spec 14.4, I8, I9). */
export const PROTECTED_RIGHTS = ["policy.edit", "role.edit", "people.manage", "security.manage", "restore.factory"] as const;

/** Actions agents can never approve (I6). */
export const AGENT_FORBIDDEN_ACTIONS: readonly string[] = [
  "policy.edit",
  "role.edit",
  "trust.grant",
  "trust.criteria",
  "eval.run",
  "skill.edit",
  "agent.edit",
  "learning.apply",
  "security.manage",
  "people.manage",
  "flow.edit",
  "onboarding.merge",
];

/** Actions that need a fresh strong sign-in (spec 14.1 / 14.4): kill, restore, policy, role, security and key operations. */
export const STEP_UP_ACTIONS: readonly string[] = [
  "kill.workorder", "kill.project", "kill.factory", "restore.workorder", "restore.project", "restore.factory",
  "policy.edit", "role.edit", "security.manage", "api.keys", "people.manage",
  // S-66: anything that can redirect data or credentials to another host: a vendor or model endpoint and key, an integration or webhook target, an MCP server, the API settings.
  "model.edit", "integration.add", "integration.edit", "mcp.edit",
];

export function isFactoryAdminPerson(p: Person): boolean {
  return p.roles.some((g) => g.role === "factory_admin" && g.scope === "factory");
}

/** Active Factory Admins. */
export function factoryAdmins(people: Person[]): Person[] {
  return people.filter((p) => p.status === "active" && isFactoryAdminPerson(p));
}

/**
 * Change one person's role grants. Refused when it would leave no active Factory Admin, or when a person
 * removes their own admin role (spec 14.4).
 */
export function checkRoleChange(people: Person[], change: { actorId: string; targetId: string; nextRoles: RoleGrant[] }): Result<true, GantryError> {
  const target = people.find((p) => p.id === change.targetId);
  if (!target) return err(gantryError("not_found", "No such person."));
  const wasAdmin = isFactoryAdminPerson(target);
  const stillAdmin = change.nextRoles.some((g) => g.role === "factory_admin" && g.scope === "factory");
  if (wasAdmin && !stillAdmin) {
    if (change.actorId === change.targetId) {
      return err(gantryError("denied", "People cannot remove their own admin role. Ask another Factory Admin.", { rule: rule("INV-14.4-SELF", "Own admin role"), needs: "Another Factory Admin" }));
    }
    const others = factoryAdmins(people).filter((p) => p.id !== change.targetId);
    if (!others.length) {
      return err(gantryError("denied", "The last Factory Admin cannot be removed.", { rule: rule("INV-14.4-LAST", "Last Factory Admin"), needs: "Another Factory Admin first" }));
    }
  }
  return ok(true);
}

/**
 * A team's role grant (spec 8.9). The role must exist and its level must match the scope (factory role on the factory, project role on a
 * project that exists). Factory Admin is never granted through a team: team membership changes without a role operation, so the
 * last-admin and own-admin rules (14.4) could not be enforced when someone joins or leaves. Factory Admin stays a named-person grant.
 */
export function checkTeamGrant(roles: Array<{ id: string; name: string; level: "factory" | "project" }>, projectIds: string[], grant: { role: string; scope: string }): Result<true, GantryError> {
  const r = roles.find((x) => x.id === grant.role);
  if (!r) return err(gantryError("invalid", "There is no role " + grant.role + "."));
  if (r.id === "factory_admin") return err(gantryError("denied", "Factory Admin cannot be granted to a team. Grant it to named people so the last-admin rules apply.", { rule: rule("INV-TEAM-ADMIN", "Factory Admin is personal"), needs: "Grant Factory Admin to a person" }));
  if ((grant.scope === "factory") !== (r.level === "factory")) return err(gantryError("invalid", r.name + " is a " + r.level + " role and cannot be granted " + (grant.scope === "factory" ? "on the factory" : "on a project") + "."));
  if (grant.scope !== "factory" && !projectIds.includes(grant.scope)) return err(gantryError("invalid", "There is no project " + grant.scope + "."));
  return ok(true);
}

/** Deactivate or delete a person: the same last-admin and own-admin rules apply (spec 14.4). */
export function checkPersonRemoval(people: Person[], change: { actorId: string; targetId: string }): Result<true, GantryError> {
  return checkRoleChange(people, { ...change, nextRoles: [] });
}

/** A role cannot be deleted while assigned (spec 14.4). */
export function checkRoleDelete(people: Person[], roleId: string): Result<true, GantryError> {
  const holders = people.filter((p) => p.roles.some((g) => g.role === roleId));
  if (holders.length) return err(gantryError("conflict", "Role " + roleId + " is assigned to " + holders.length + " " + (holders.length === 1 ? "person" : "people") + " and cannot be deleted.", { rule: rule("INV-14.4-ROLE", "Role in use") }));
  return ok(true);
}

/** A class or station cannot be removed while work is in it (spec 14.4). */
export function checkFlowEntryRemoval(inUse: number, what: string): Result<true, GantryError> {
  if (inUse > 0) return err(gantryError("conflict", what + " cannot be removed while " + inUse + " work " + (inUse === 1 ? "order is" : "orders are") + " in it.", { rule: rule("INV-14.4-FLOW", "Flow entry in use") }));
  return ok(true);
}

/** Protected rights that nobody active can currently exercise. */
export function lockedOutRights(matrix: Matrix, people: Person[]): string[] {
  const missing: string[] = [];
  for (const right of PROTECTED_RIGHTS) {
    const reachable = people.some((p) => p.status === "active" && p.roles.some((g) => g.scope === "factory" && matrix[g.role]?.[right]));
    if (!reachable) missing.push(right);
  }
  return missing;
}

/**
 * Edit one cell of the role matrix. Refused when Factory Admin would lose a protected right, or when no one
 * would be left able to edit the matrix, manage people or security, or restore the factory (I8, I9, spec 14.4).
 */
export function checkMatrixEdit(matrix: Matrix, people: Person[], edit: { role: string; action: string; value: boolean }, catalog: Pick<Catalog, "roles" | "actions"> = DEFAULT_CATALOG): Result<true, GantryError> {
  if (edit.value && !roleMayHold(catalog.roles, catalog.actions, edit.role, edit.action)) {
    const role = catalog.roles.find((r) => r.id === edit.role)?.name ?? edit.role;
    const act = catalog.actions.find((a) => a.id === edit.action)?.name ?? edit.action;
    return err(gantryError("denied", `${role} is a project-level role, so it cannot hold the factory-wide right "${act}". Factory-wide settings (access, security, system health, vendors, prices, budgets, routing) belong to factory-level roles only.`, { rule: rule("INV-FACTORY-ONLY", "Factory rights stay on factory roles"), needs: "Grant it to a factory-level role (Factory Admin, or a role whose level is Factory)" }));
  }
  /* Owner decision 2026-11-19: Factory Admin is universal. Every cell of its column is locked on; no right can be switched off. */
  if (edit.role === "factory_admin" && !edit.value) {
    const protectedRight = (PROTECTED_RIGHTS as readonly string[]).includes(edit.action);
    return err(gantryError("denied", protectedRight ? "Factory Admin cannot lose the right to " + edit.action + "." : "Factory Admin always keeps every right (" + edit.action + "). Its column cannot be switched off.", { rule: rule(protectedRight ? "INV-14.4-ADMIN" : "INV-ADMIN-ALL", "Factory Admin rights"), needs: "Keep it on Factory Admin" }));
  }
  const next: Matrix = { ...matrix, [edit.role]: { ...(matrix[edit.role] ?? {}), [edit.action]: edit.value } };
  const before = new Set(lockedOutRights(matrix, people));
  const lost = lockedOutRights(next, people).filter((r) => !before.has(r));
  if (lost.length) {
    const edits = lost.includes("policy.edit") || lost.includes("role.edit");
    return err(gantryError("denied", edits ? "The permission matrix cannot be edited so that no one can edit it." : "At least one person must always hold the right to " + lost.join(", ") + ".", { rule: rule(edits ? "I9" : "I8", edits ? "Matrix lockout" : "Restore right"), needs: "Keep the right on a role someone holds" }));
  }
  return ok(true);
}

/** Agents can never approve policy, trust, eval, skill, instruction or CI changes (I6). */
export function checkAgentAuthority(principalKind: "person" | "agent" | "api_key" | "trigger" | "service", action: string): Result<true, GantryError> {
  if (principalKind === "agent" && AGENT_FORBIDDEN_ACTIONS.includes(action)) {
    return err(gantryError("denied", "Agents cannot approve changes to policy, trust levels, evals, skills, instructions or CI configuration.", { rule: rule("I6", "Agents cannot approve configuration") }));
  }
  return ok(true);
}

/**
 * I4: the requester of a work order is never its sole approver. Given who approved, does at least one
 * approver other than the requester exist?
 */
export function hasIndependentApprover(requestedBy: string, approvers: string[]): boolean {
  return approvers.some((a) => a !== requestedBy);
}

export function needsStepUp(action: string): boolean {
  return STEP_UP_ACTIONS.includes(action);
}
