/**
 * Team management: create, rename or re-describe, and delete teams (People & teams, spec 8.9). Membership itself is set per person
 * (`setTeams` in people.ts). All three need `people.manage` and run through command(), so they are audited like every other change.
 */
import { randomBytes } from "node:crypto";
import { checkTeamGrant } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { z } from "zod";
import { conflict, invalid, notFound, Refusal } from "../../core/errors.js";
import type { CommandResult } from "../../core/command.js";
import { readTeams } from "../../core/read/index.js";
import { lockOrgConfig, stateIn } from "../access/config.js";
import type { CreateTeamBody, TeamGrantBody, UpdateTeamBody } from "./schemas.js";

/** A stable id from the name: lower-case words joined by hyphens ("Internal Tools" -> "internal-tools"). */
export function teamIdFrom(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

async function teamIn(tx: Tx, orgId: string, id: string) {
  const t = (await readTeams(tx, orgId)).find((x) => x.id === id);
  if (!t) throw notFound("No such team.");
  return t;
}

export async function createTeam(tx: Tx, orgId: string, body: z.infer<typeof CreateTeamBody>): Promise<CommandResult<{ team: { id: string; name: string; desc: string } }>> {
  const id = body.id ?? teamIdFrom(body.name);
  if (!id) throw invalid("Use letters or digits in the team name.");
  const teams = await readTeams(tx, orgId);
  if (teams.some((t) => t.id === id)) throw conflict(`A team with the id ${id} already exists.`);
  if (teams.some((t) => t.name.toLowerCase() === body.name.toLowerCase())) throw conflict(`A team named ${body.name} already exists.`);
  await tx.query(`insert into teams (org_id, id, name, description) values ($1,$2,$3,$4)`, [orgId, id, body.name, body.desc]);
  const team = { id, name: body.name, desc: body.desc };
  return {
    msg: `Team ${body.name} created.`,
    events: [{ type: "teams.create", category: "access", subject: { type: "team", id }, after: team, projectId: null }],
    extra: { team },
    changes: ["teams", "people"],
    project: null,
  };
}

export async function updateTeam(tx: Tx, orgId: string, id: string, body: z.infer<typeof UpdateTeamBody>): Promise<CommandResult> {
  const t = await teamIn(tx, orgId, id);
  const name = body.name ?? t.name;
  const desc = body.desc ?? t.desc;
  if (name.toLowerCase() !== t.name.toLowerCase() && (await readTeams(tx, orgId)).some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
    throw conflict(`A team named ${name} already exists.`);
  }
  await tx.query(`update teams set name = $3, description = $4 where org_id = $1 and id = $2`, [orgId, id, name, desc]);
  return {
    msg: name !== t.name ? `Team ${t.name} renamed to ${name}.` : `Team ${name} saved.`,
    events: [{ type: "teams.update", category: "access", subject: { type: "team", id }, before: { name: t.name, desc: t.desc }, after: { name, desc }, projectId: null }],
    changes: ["teams", "people", "projects"],
    project: null,
  };
}

/**
 * Deleting a team that owns projects or repos is refused: project_teams would cascade away silently and leave a project with no owner.
 * Members are removed from the team (their other teams and roles are untouched).
 */
export async function deleteTeam(tx: Tx, orgId: string, id: string): Promise<CommandResult> {
  const t = await teamIn(tx, orgId, id);
  // One client per transaction: queries run one after another.
  const projects = await tx.query<{ n: number }>(`select count(*)::int as n from project_teams where org_id = $1 and team_id = $2`, [orgId, id]);
  const repos = await tx.query<{ n: number }>(`select count(*)::int as n from repos where org_id = $1 and team_id = $2`, [orgId, id]);
  const members = await tx.query<{ person_id: string }>(`select person_id from team_members where org_id = $1 and team_id = $2 order by person_id`, [orgId, id]);
  const np = projects.rows[0]!.n;
  const nr = repos.rows[0]!.n;
  if (np || nr) {
    const what = [np ? `${np} project${np === 1 ? "" : "s"}` : "", nr ? `${nr} repo${nr === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    throw conflict(`${t.name} owns ${what}. Give them another owning team first.`);
  }
  const held = await tx.query<{ role_id: string; project_id: string | null }>(`select role_id, project_id from team_role_assignments where org_id = $1 and team_id = $2 and revoked_at is null`, [orgId, id]);
  await tx.query(`delete from teams where org_id = $1 and id = $2`, [orgId, id]);
  return {
    msg: `Team ${t.name} deleted.${members.rows.length ? ` ${members.rows.length} member${members.rows.length === 1 ? " was" : "s were"} removed from it.` : ""}`,
    events: [{ type: "teams.delete", category: "access", subject: { type: "team", id }, before: { name: t.name, desc: t.desc, members: members.rows.map((r) => r.person_id), roles: held.rows.map((g) => ({ role: g.role_id, scope: g.project_id ?? "factory" })) }, projectId: null }],
    changes: ["teams", "people"],
    project: null,
  };
}

/**
 * Grant a role to a team at factory or project scope. Members inherit it while they are members and it is neither revoked nor expired.
 * Same checks as a person's grant (role exists, level matches scope, project exists) plus: Factory Admin is never held by a team
 * (domain `checkTeamGrant`). The route needs people.manage and a fresh sign-in, like person grants.
 */
export async function grantTeamRole(tx: Tx, orgId: string, actorId: string, teamId: string, body: z.infer<typeof TeamGrantBody>, now: number): Promise<CommandResult<{ grant: { id: string; role: string; scope: string; expiresAt: number | null } }>> {
  await lockOrgConfig(tx, orgId);
  const team = await teamIn(tx, orgId, teamId);
  const st = await stateIn(tx, orgId);
  const checked = checkTeamGrant(st.catalog.roles, st.projects.map((p) => p.id), body);
  if (!checked.ok) throw new Refusal(checked.error);
  if (body.expiresAt != null && body.expiresAt <= now) throw invalid("The expiry must be in the future.");
  const role = st.catalog.roles.find((r) => r.id === body.role)!;
  const where = body.scope === "factory" ? "the factory" : st.projects.find((p) => p.id === body.scope)?.name ?? body.scope;
  const live = await tx.query<{ id: string }>(
    `select id from team_role_assignments where org_id = $1 and team_id = $2 and role_id = $3 and coalesce(project_id, 'factory') = $4 and revoked_at is null and (expires_at is null or expires_at > now())`,
    [orgId, teamId, body.role, body.scope],
  );
  const same = live.rows[0];
  if (same) return { msg: `${team.name} already has ${role.name} on ${where}.`, events: [], extra: { grant: { id: same.id, role: body.role, scope: body.scope, expiresAt: body.expiresAt ?? null } }, changes: ["teams"], project: null };
  // An expired row still occupies the unique slot until revoked: retire it first so the new grant can take its place.
  await tx.query(`update team_role_assignments set revoked_at = now(), updated_at = now() where org_id = $1 and team_id = $2 and role_id = $3 and coalesce(project_id, 'factory') = $4 and revoked_at is null`, [orgId, teamId, body.role, body.scope]);
  const id = `tra-${randomBytes(6).toString("hex")}`;
  await tx.query(
    `insert into team_role_assignments (org_id, id, team_id, role_id, scope_type, project_id, granted_by, expires_at) values ($1,$2,$3,$4,$5,$6,$7, $8)`,
    [orgId, id, teamId, body.role, body.scope === "factory" ? "factory" : "project", body.scope === "factory" ? null : body.scope, actorId, body.expiresAt != null ? new Date(body.expiresAt) : null],
  );
  const members = (await tx.query<{ n: number }>(`select count(*)::int as n from team_members where org_id = $1 and team_id = $2`, [orgId, teamId])).rows[0]!.n;
  return {
    msg: `${team.name} now has ${role.name} on ${where}. ${members} member${members === 1 ? "" : "s"} inherit${members === 1 ? "s" : ""} it.`,
    events: [{ type: "team.role.grant", category: "access", subject: { type: "team", id: teamId }, before: null, after: { role: body.role, scope: body.scope, expiresAt: body.expiresAt ?? null, members }, projectId: body.scope === "factory" ? null : body.scope }],
    extra: { grant: { id, role: body.role, scope: body.scope, expiresAt: body.expiresAt ?? null } },
    changes: ["teams", "people", "matrix"],
    project: null,
  };
}

/** Revoke one team grant by id. Members lose the inherited role at once (unless they hold it another way). */
export async function revokeTeamRole(tx: Tx, orgId: string, teamId: string, grantId: string): Promise<CommandResult> {
  await lockOrgConfig(tx, orgId);
  const team = await teamIn(tx, orgId, teamId);
  const g = (await tx.query<{ role_id: string; project_id: string | null }>(`select role_id, project_id from team_role_assignments where org_id = $1 and team_id = $2 and id = $3 and revoked_at is null`, [orgId, teamId, grantId])).rows[0];
  if (!g) throw notFound("No such grant on this team.");
  await tx.query(`update team_role_assignments set revoked_at = now(), updated_at = now() where org_id = $1 and id = $2`, [orgId, grantId]);
  const name = (await stateIn(tx, orgId)).catalog.roles.find((r) => r.id === g.role_id)?.name ?? g.role_id;
  return {
    msg: `Removed ${name} from ${team.name}.`,
    events: [{ type: "team.role.revoke", category: "access", subject: { type: "team", id: teamId }, before: { role: g.role_id, scope: g.project_id ?? "factory" }, after: null, projectId: g.project_id }],
    changes: ["teams", "people", "matrix"],
    project: null,
  };
}
