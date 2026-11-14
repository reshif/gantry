/**
 * People, teams, invites, factory roles, on-call, away (spec 8.3, 8.9). Owns:
 *   GET /api/v1/people, GET /api/v1/people/{id}/effective-permissions
 *   GET/POST /api/v1/teams, PATCH/DELETE /api/v1/teams/{id}
 *   GET/POST /api/v1/teams/{id}/roles, DELETE /api/v1/teams/{id}/roles/{grant}      (team role grants; members inherit them)
 *   POST /api/v1/invites, POST /api/v1/invites/{id}/accept       (the invite id is the invited person's id)
 *   PUT/DELETE /api/v1/people/{id}/factory-roles/{role}
 *   PUT /api/v1/people/{id}/teams, PUT /api/v1/people/{id}/oncall, PUT /api/v1/people/{id}/away
 *
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4). Project role grants
 * (PUT/DELETE /projects/{id}/members/{person}/roles/{role}) belong to the projects area.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { command, decide, policyState, refuse, readPeople, readTeams } from "../core/index.js";
import { effectivePermissions } from "../areas/access/simulate.js";
import { AwayBody, CreateTeamBody, InviteBody, OncallBody, TeamGrantBody, TeamsBody, UpdateTeamBody } from "../areas/people/schemas.js";
import { acceptInvite, invitePerson, personVersion, setAway, setFactoryRole, setOncall, setTeams } from "../areas/people/people.js";
import { createTeam, deleteTeam, grantTeamRole, revokeTeamRole, updateTeam } from "../areas/people/teams.js";

const Id = z.object({ id: z.string().min(1).max(100) });
const IdGrant = z.object({ id: z.string().min(1).max(100), grant: z.string().min(1).max(100) });
const IdRole = z.object({ id: z.string().min(1).max(100), role: z.string().min(1).max(100) });

const isSelf = (req: FastifyRequest, id: string): boolean => req.gx.principal?.kind === "person" && req.gx.principal.id === id;

/** Own on-call and away status need no right; changing someone else's needs `action`. The denial of a stranger is still audited by the pipeline. */
async function selfOrAction(req: FastifyRequest, id: string, action: string, scope: { project?: string | null } = {}): Promise<string | null> {
  if (!isSelf(req, id)) return action;
  return (await decide(req, action, scope)).allowed ? action : null;
}

export const peopleRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const requirePerson = (req: FastifyRequest): string => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
    return p.id;
  };

  app.get("/api/v1/people", async (req) => {
    requirePerson(req);
    return readPeople(g.pool, req.gx.orgId);
  });

  app.get("/api/v1/teams", async (req) => {
    requirePerson(req);
    return readTeams(g.pool, req.gx.orgId);
  });

  app.post("/api/v1/teams", async (req) => {
    const body = CreateTeamBody.parse(req.body);
    return command(req, { action: "people.manage", idempotent: true }, (tx, a) => createTeam(tx, a.orgId, body));
  });

  app.patch("/api/v1/teams/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const body = UpdateTeamBody.parse(req.body);
    return command(req, { action: "people.manage" }, (tx, a) => updateTeam(tx, a.orgId, id, body));
  });

  app.delete("/api/v1/teams/:id", async (req) => {
    const { id } = Id.parse(req.params);
    return command(req, { action: "people.manage" }, (tx, a) => deleteTeam(tx, a.orgId, id));
  });

  app.get("/api/v1/teams/:id/roles", async (req) => {
    requirePerson(req);
    const { id } = Id.parse(req.params);
    const t = (await readTeams(g.pool, req.gx.orgId)).find((x) => x.id === id);
    if (!t) throw refuse("not_found", "No such team.");
    return t.roles ?? [];
  });

  // Role grants decide who can restore and who can edit policy, so team grants need a fresh sign-in too (spec 14.4).
  app.post("/api/v1/teams/:id/roles", async (req) => {
    const { id } = Id.parse(req.params);
    const body = TeamGrantBody.parse(req.body);
    return command(req, { action: "people.manage", stepUp: true }, (tx, a) => grantTeamRole(tx, a.orgId, a.id, id, body, a.now.getTime()));
  });

  app.delete("/api/v1/teams/:id/roles/:grant", async (req) => {
    const { id, grant } = IdGrant.parse(req.params);
    return command(req, { action: "people.manage", stepUp: true }, (tx, a) => revokeTeamRole(tx, a.orgId, id, grant));
  });

  app.get("/api/v1/people/:id/effective-permissions", async (req) => {
    const viewer = requirePerson(req);
    const { id } = Id.parse(req.params);
    const { at } = z.object({ at: z.coerce.number().finite().optional() }).parse(req.query);
    const st = await policyState(req);
    if (!st.people.some((p) => p.id === id)) throw refuse("not_found", "No such person.");
    return effectivePermissions(st, viewer, id, at ?? Date.now());
  });

  app.post("/api/v1/invites", async (req) => {
    const body = InviteBody.parse(req.body);
    return command(req, { action: "people.manage", idempotent: true }, (tx, a) => invitePerson(tx, a.orgId, g.config.publicUrl, a.id, body));
  });

  app.post("/api/v1/invites/:id/accept", async (req) => {
    const { id } = Id.parse(req.params);
    return command(req, { action: "people.manage", ifMatch: (tx) => personVersion(tx, g.orgId, id) }, (tx, a) => acceptInvite(tx, a.orgId, id));
  });

  // Role grants decide who can restore and who can edit policy, so they need a fresh sign-in (spec 14.4).
  for (const [method, add] of [["PUT", true], ["DELETE", false]] as const) {
    app.route({
      method,
      url: "/api/v1/people/:id/factory-roles/:role",
      handler: async (req) => {
        const { id, role } = IdRole.parse(req.params);
        return command(req, { action: "people.manage", stepUp: true, ifMatch: (tx) => personVersion(tx, g.orgId, id) }, (tx, a) => setFactoryRole(tx, a.orgId, a.id, id, role, add));
      },
    });
  }

  app.put("/api/v1/people/:id/teams", async (req) => {
    const { id } = Id.parse(req.params);
    const body = TeamsBody.parse(req.body);
    return command(req, { action: "people.manage", ifMatch: (tx) => personVersion(tx, g.orgId, id) }, (tx, a) => setTeams(tx, a.orgId, id, body.teams));
  });

  app.put("/api/v1/people/:id/oncall", async (req) => {
    const { id } = Id.parse(req.params);
    const body = OncallBody.parse(req.body);
    const action = await selfOrAction(req, id, "people.manage");
    return command(req, { action, ifMatch: (tx) => personVersion(tx, g.orgId, id) }, (tx, a) => setOncall(tx, a.orgId, id, body.on));
  });

  app.put("/api/v1/people/:id/away", async (req) => {
    const { id } = Id.parse(req.params);
    const body = AwayBody.parse(req.body);
    const project = body.project ?? null;
    const action = await selfOrAction(req, id, project ? "approvers.edit" : "people.manage", { project });
    return command(req, { action, scope: project ? { project } : {}, ifMatch: (tx) => personVersion(tx, g.orgId, id) }, (tx, a) => setAway(tx, a.orgId, id, body, a.now.getTime()));
  });
};
