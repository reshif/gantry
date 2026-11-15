import { randomBytes, createHash } from "node:crypto";
import { checkRoleChange, type Person, type RoleGrant } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import { conflict, invalid, notFound, refuse, Refusal } from "../../core/errors.js";
import type { CommandResult } from "../../core/command.js";
import { emailDomainAllowed } from "../../core/security.js";
import { readPeople, readSecurity, readTeams } from "../../core/read/index.js";
import { lockOrgConfig, stateIn } from "../access/config.js";
import type { z } from "zod";
import type { AwayBody, InviteBody } from "./schemas.js";

export const personVersion = async (tx: Tx, orgId: string, id: string): Promise<number | null> =>
  (await tx.query(`select version from people where org_id = $1 and id = $2`, [orgId, id])).rows[0]?.version ?? null;

async function personIn(tx: Tx, orgId: string, id: string): Promise<Person> {
  const p = (await readPeople(tx, orgId)).find((x) => x.id === id);
  if (!p) throw notFound("No such person.");
  return p;
}

const bump = (tx: Tx, orgId: string, id: string): Promise<{ rows: Array<{ version: number }> }> =>
  tx.query(`update people set version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`, [orgId, id]);

const versionOf = (p: Person): number => (p as Person & { version?: number }).version ?? 1;

const factoryRolesOf = (p: Person): string => p.roles.filter((g) => g.scope === "factory" && !g.via).map((g) => g.role).join(",") || "none";

/** Invite: a person row in status `invited` (the policy engine grants nothing until they sign in), their teams and roles, an invites row, and an email through the outbox. */
export async function invitePerson(tx: Tx, orgId: string, publicUrl: string, by: string, body: z.infer<typeof InviteBody>): Promise<CommandResult<{ person: Person; version: number }>> {
  await lockOrgConfig(tx, orgId);
  const st = await stateIn(tx, orgId);
  const security = (await readSecurity(tx, orgId)).value;
  if (!emailDomainAllowed(body.email, security.domains)) throw invalid(`${body.email.split("@")[1]} is not an allowed domain. Add it in Security first.`);
  if (st.people.some((p) => p.email.toLowerCase() === body.email)) throw conflict(`${body.email} is already in the org.`);
  const teams = new Set((await readTeams(tx, orgId)).map((t) => t.id));
  for (const t of body.teams) if (!teams.has(t)) throw invalid(`There is no team ${t}.`);
  const roles = new Map(st.catalog.roles.map((r) => [r.id, r]));
  const projects = new Set(st.projects.map((p) => p.id));
  const grants: RoleGrant[] = [];
  for (const g of body.roles) {
    const r = roles.get(g.role);
    if (!r) throw invalid(`There is no role ${g.role}.`);
    if ((g.scope === "factory") !== (r.level === "factory")) throw invalid(`${r.name} is a ${r.level} role and cannot be granted ${g.scope === "factory" ? "on the factory" : "on a project"}.`);
    if (g.scope !== "factory" && !projects.has(g.scope)) throw invalid(`There is no project ${g.scope}.`);
    if (!grants.some((x) => x.role === g.role && x.scope === g.scope)) grants.push(g);
  }
  const local = body.email.split("@")[0]!.replace(/[^a-z0-9]/g, "");
  const id = `p-${local || "user"}-${randomBytes(2).toString("hex")}`;
  await tx.query(`insert into people (org_id, id, name, title, email, status, data) values ($1,$2,$3,'Invited',$4,'invited',$5::jsonb)`, [orgId, id, body.name, body.email, JSON.stringify({ invitedBy: by, invitedAt: Date.now() })]);
  for (const t of body.teams) await tx.query(`insert into team_members (org_id, team_id, person_id) values ($1,$2,$3)`, [orgId, t, id]);
  for (const g of grants) {
    await tx.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, project_id, granted_by) values ($1,$2,$3,$4,$5,$6,$7)`, [orgId, `ra-${randomBytes(6).toString("hex")}`, id, g.role, g.scope === "factory" ? "factory" : "project", g.scope === "factory" ? null : g.scope, by]);
  }
  // The emailed link carries a one-time token: only a sign-in that presents it (with a provider-verified matching address)
  // claims this invited person. Knowing or controlling the address alone is not enough (core/auth/signin.ts).
  const token = randomBytes(24).toString("base64url");
  await tx.query(`insert into invites (org_id, id, email, role_id, project_id, invited_by, token_hash, expires_at) values ($1,$2,$3,$4,$5,$6,$7, now() + interval '14 days')`, [
    orgId, id, body.email, grants[0]?.role ?? null, grants.find((g) => g.scope !== "factory")?.scope ?? null, by, createHash("sha256").update(token).digest("hex"),
  ]);
  const person = await personIn(tx, orgId, id);
  return {
    msg: `Invite sent to ${body.email}.`,
    events: [{ type: "people.invite", category: "access", subject: { type: "person", id }, before: null, after: { name: body.name, email: body.email, teams: body.teams, roles: grants }, projectId: null }],
    outbox: [{ destination: "smtp", payload: { kind: "invite", to: body.email, name: body.name, invitedBy: by, link: `${publicUrl.replace(/\/$/, "")}/auth/login?invite=${token}&login_hint=${encodeURIComponent(body.email)}` } }],
    extra: { person, version: versionOf(person) },
    changes: ["people"],
    project: null,
  };
}

/** An administrator marks the invite accepted (the person otherwise becomes active on first sign-in). */
export async function acceptInvite(tx: Tx, orgId: string, id: string): Promise<CommandResult<{ version: number }>> {
  await lockOrgConfig(tx, orgId);
  const p = await personIn(tx, orgId, id);
  if (p.status !== "invited") throw conflict(`${p.name} is already ${p.status === "active" ? "active" : p.status}.`);
  const title = p.title === "Invited" ? (await stateIn(tx, orgId)).catalog.roles.find((r) => r.id === p.roles[0]?.role)?.name ?? "Member" : p.title;
  await tx.query(`update people set status = 'active', title = $3 where org_id = $1 and id = $2`, [orgId, id, title]);
  await tx.query(`update invites set status = 'accepted', accepted_at = now(), updated_at = now() where org_id = $1 and id = $2 and status = 'pending'`, [orgId, id]);
  const v = (await bump(tx, orgId, id)).rows[0]!.version;
  return {
    msg: `${p.name} is active.`,
    events: [{ type: "people.accept", category: "access", subject: { type: "person", id }, before: "invited", after: "active", projectId: null }],
    extra: { version: v },
    changes: ["people"],
    project: null,
  };
}

/** Grant or revoke one factory-level role. Spec 14.4 invariants apply: the last Factory Admin stays, and nobody removes their own admin role. */
export async function setFactoryRole(tx: Tx, orgId: string, actorId: string, id: string, roleId: string, add: boolean): Promise<CommandResult<{ version: number }>> {
  await lockOrgConfig(tx, orgId);
  const st = await stateIn(tx, orgId);
  const role = st.catalog.roles.find((r) => r.id === roleId);
  if (!role || role.level !== "factory") throw invalid("Pick a factory-level role (Factory Admin, Auditor or a custom factory role).");
  const p = st.people.find((x) => x.id === id);
  if (!p) throw notFound("No such person.");
  // Only the person's own grant can be granted or removed here; a role held through a team changes with the team (teams.ts).
  const has = p.roles.some((g) => g.role === roleId && g.scope === "factory" && !g.via);
  const before = factoryRolesOf(p);
  if (has === add) return { msg: `${p.name} ${add ? "already is" : "is not"} ${role.name}.`, events: [], extra: { version: versionOf(p) }, changes: ["people"], project: null };
  // Escalation guards: people.manage can be handed to a custom role, so it must not be a path to Factory Admin or to more rights for oneself.
  if (add && actorId === id) throw refuse("denied", `You cannot grant yourself ${role.name}. Ask another administrator.`);
  const actor = st.people.find((x) => x.id === actorId);
  if (roleId === "factory_admin" && !actor?.roles.some((g) => g.role === "factory_admin" && g.scope === "factory"))
    throw refuse("denied", `Only a Factory Admin can ${add ? "grant" : "remove"} Factory Admin.`, { needs: "factory_admin" });
  const nextRoles = add ? [...p.roles, { role: roleId, scope: "factory" }] : p.roles.filter((g) => !(g.role === roleId && g.scope === "factory" && !g.via));
  const checked = checkRoleChange(st.people, { actorId, targetId: id, nextRoles });
  if (!checked.ok) throw new Refusal(checked.error);
  if (add) await tx.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, granted_by) values ($1,$2,$3,$4,'factory',$5)`, [orgId, `ra-${randomBytes(6).toString("hex")}`, id, roleId, actorId]);
  else await tx.query(`update role_assignments set revoked_at = now(), updated_at = now() where org_id = $1 and person_id = $2 and role_id = $3 and scope_type = 'factory' and revoked_at is null`, [orgId, id, roleId]);
  const v = (await bump(tx, orgId, id)).rows[0]!.version;
  const after = nextRoles.filter((g) => g.scope === "factory" && !g.via).map((g) => g.role).join(",") || "none";
  return {
    msg: `${add ? "Granted" : "Removed"} ${role.name}${add ? " to " : " from "}${p.name}.`,
    events: [{ type: add ? "role.grant" : "role.revoke", category: "access", subject: { type: "person", id }, before, after, projectId: null }],
    extra: { version: v },
    changes: ["people", "matrix"],
    project: null,
  };
}

export async function setTeams(tx: Tx, orgId: string, id: string, teams: string[]): Promise<CommandResult<{ version: number }>> {
  const p = await personIn(tx, orgId, id);
  const known = new Set((await readTeams(tx, orgId)).map((t) => t.id));
  for (const t of teams) if (!known.has(t)) throw invalid(`There is no team ${t}.`);
  const next = [...new Set(teams)];
  await tx.query(`delete from team_members where org_id = $1 and person_id = $2 and not (team_id = any($3::text[]))`, [orgId, id, next]);
  for (const t of next) await tx.query(`insert into team_members (org_id, team_id, person_id) values ($1,$2,$3) on conflict do nothing`, [orgId, t, id]);
  const v = (await bump(tx, orgId, id)).rows[0]!.version;
  return {
    msg: `Teams saved for ${p.name}.`,
    events: [{ type: "people.teams", category: "access", subject: { type: "person", id }, before: p.teams.join(","), after: next.join(","), projectId: null }],
    extra: { version: v },
    changes: ["people", "teams"],
    project: null,
  };
}

export async function setOncall(tx: Tx, orgId: string, id: string, on: boolean): Promise<CommandResult<{ version: number }>> {
  const p = await personIn(tx, orgId, id);
  await tx.query(`update people set oncall = $3 where org_id = $1 and id = $2`, [orgId, id, on]);
  const v = (await bump(tx, orgId, id)).rows[0]!.version;
  return {
    msg: on ? `${p.name} is on call. On-call policies such as POL-106 now apply.` : `${p.name} is off call.`,
    events: [{ type: "people.oncall", category: "access", subject: { type: "person", id }, before: p.oncall, after: on, projectId: null }],
    extra: { version: v },
    changes: ["people"],
    project: null,
  };
}

/** Away with a delegate: the delegate approves instead (spec 9.6). `project` scopes the audit event and the permission check. */
export async function setAway(tx: Tx, orgId: string, id: string, body: z.infer<typeof AwayBody>, now: number): Promise<CommandResult<{ version: number }>> {
  const people = await readPeople(tx, orgId);
  const p = people.find((x) => x.id === id);
  if (!p) throw notFound("No such person.");
  const name = (pid: string | null | undefined): string => people.find((x) => x.id === pid)?.name ?? String(pid ?? "nobody");
  const away = body.away ? { from: body.away.from ?? now, to: body.away.to, delegate: body.away.delegate } : null;
  if (away) {
    const d = people.find((x) => x.id === away.delegate);
    if (!d || d.id === id) throw invalid(`Pick a delegate other than ${p.name}.`);
    if (d.status !== "active") throw invalid(`${d.name} has not accepted the invite yet and cannot approve.`);
    if (!(away.to > away.from)) throw invalid("The end must be after the start.");
  }
  await tx.query(`update people set away = $3::jsonb where org_id = $1 and id = $2`, [orgId, id, away ? JSON.stringify(away) : null]);
  const v = (await bump(tx, orgId, id)).rows[0]!.version;
  return {
    msg: away ? `${p.name} is away; ${name(away.delegate)} approves instead.` : `${p.name} is back.`,
    events: [{ type: "approvers.delegate", category: "approvals", subject: { type: "person", id }, before: p.away ? name(p.away.delegate) : "present", after: away ? name(away.delegate) : "present", projectId: body.project ?? null }],
    extra: { version: v },
    changes: ["people"],
    project: body.project ?? null,
  };
}
