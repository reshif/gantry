/**
 * Projects, templates, saved views, project config, flow, approvers, members, archive (spec 8.3). Owns:
 *   GET /api/v1/projects, GET /api/v1/projects/{id}, POST /api/v1/projects
 *   GET/POST/PATCH/DELETE /api/v1/saved-views
 *   GET/POST /api/v1/templates, PATCH /api/v1/templates/{id}
 *   PATCH /api/v1/projects/{id}/config
 *   POST/DELETE/PATCH /api/v1/projects/{id}/flow/{stations|gates|bays|classes}
 *   PUT /api/v1/projects/{id}/approvers/{gate}
 *   PUT/DELETE /api/v1/projects/{id}/members/{person}/roles/{role}
 *   POST /api/v1/projects/{id}/archive, /unarchive
 *
 * `GET /projects` and `GET /projects/{id}` return the legacy Project shape plus `version` and `metrics` (portfolio numbers computed from
 * the tables: work in flight, gates waiting, flow efficiency, trust coverage and the health chip). Every state-changing handler goes
 * through command() (docs/BUILD.md, spec 15.4): decision point and audit on success and denial, state and event in one transaction.
 */
import { visibleProjects, type Project } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { command, policyState, type Actor, type CommandResult, type CommandSpec, readTemplates, readProjects, readRepos, refuse, type PolicyStateLoaded } from "../core/index.js";
import {
  addBayCmd, addClassCmd, addGateCmd, addStationCmd, archiveProject, changeGateMode, createProject, createView, deleteView, listViews, moveStationCmd, putApprovers,
  removeStationCmd, saveTemplate, setConfig, setMemberRole, unarchiveProject, updateClassCmd, updateTemplate, updateView,
} from "../areas/projects/commands.js";
import { actionFor, parseConfigEdit } from "../areas/projects/config.js";
import { approversPreset, routesPreset } from "../areas/projects/presets.js";
import { readCatalog } from "../core/index.js";
import { portfolioMetrics } from "../areas/projects/metrics.js";
import { ArchiveBody, BayBody, ClassBody, ClassPatch, ConfigBody, GateBody, MoveBody, NewProject, RuleBody, StationBody, TemplateCreate, TemplatePatch, ViewCreate, ViewPatch } from "../areas/projects/schemas.js";
import { projectVersion, refuseIfStopped } from "../areas/projects/store.js";

const Id = z.object({ id: z.string().min(1).max(100) });
const IdSub = z.object({ id: z.string().min(1).max(100), sub: z.string().min(1).max(100) });
const Member = z.object({ id: z.string().min(1).max(100), person: z.string().min(1).max(100), role: z.string().min(1).max(100) });
const FlowKind = z.enum(["stations", "gates", "bays", "classes"]);

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const projectRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;

  /**
   * A project command that refuses in a stopped scope (spec 15.4): an archived or killed project (and a killed factory) is read-only
   * for configuration, `light` commands (approvers, members) refuse only in an archived project so access can still be revoked in an incident.
   */
  const inProject = <X extends object>(req: FastifyRequest, spec: CommandSpec, projectId: string, level: "edit" | "light", fn: (tx: import("@gantry/db").Tx, a: Actor) => Promise<CommandResult<X>>) =>
    command(req, spec, async (tx, a) => {
      await refuseIfStopped(req, spec, tx, g.orgId, projectId, level);
      return fn(tx, a);
    });

  /** The projects the viewer may see, with portfolio metrics, in the legacy shape. */
  async function visible(req: FastifyRequest): Promise<{ projects: Array<Project & { metrics: unknown }>; st: PolicyStateLoaded }> {
    const who = requirePerson(req);
    const st = await policyState(req);
    const ids = new Set(visibleProjects(st, who).map((p) => p.id));
    const [all, repos] = await Promise.all([readProjects(g.pool, g.orgId, st.activeStops), readRepos(g.pool, g.orgId, st.activeStops)]);
    const mine = all.filter((p) => ids.has(p.id));
    const halted: Record<string, number> = {};
    for (const r of repos) if (r.halted) halted[r.project] = (halted[r.project] ?? 0) + 1;
    const metrics = await portfolioMetrics(g.pool, g.orgId, mine, !!st.stops?.factory, halted);
    return { projects: mine.map((p) => ({ ...p, metrics: metrics[p.id] })), st };
  }

  app.get("/api/v1/projects", async (req) => (await visible(req)).projects);

  app.get("/api/v1/projects/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const p = (await visible(req)).projects.find((x) => x.id === id);
    if (!p) throw refuse("not_found", "No such project.");
    return p;
  });

  app.post("/api/v1/projects", async (req) => {
    const body = NewProject.parse(req.body);
    return command(req, { action: "project.create", idempotent: true }, (tx, a) => createProject(tx, a, body));
  });

  /* ---------------------------------------------------------------- templates */

  /** The approver and notification presets a template can name, for the new-project wizard's preview. The server owns them: a create sends the choice back as a template id. */
  app.get("/api/v1/project-presets", async (req) => {
    requirePerson(req);
    const catalog = await readCatalog(g.pool, g.orgId);
    const kinds = ["standard", "light", "strict"] as const;
    return {
      approvers: Object.fromEntries(kinds.map((k) => [k, approversPreset(k, catalog)])),
      routes: Object.fromEntries(kinds.map((k) => [k, routesPreset(k)])),
    };
  });

  app.get("/api/v1/templates", async (req) => {
    requirePerson(req);
    return readTemplates(g.pool, g.orgId);
  });

  app.post("/api/v1/templates", async (req) => {
    const body = TemplateCreate.parse(req.body);
    return command(req, { action: "template.edit", idempotent: true }, (tx, a) => saveTemplate(tx, a, body));
  });

  app.patch("/api/v1/templates/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const body = TemplatePatch.parse(req.body);
    return command(
      req,
      { action: "template.edit", ifMatchRequired: true, ifMatch: async (tx) => (await tx.query<{ version: number }>(`select version from templates where org_id = $1 and id = $2`, [g.orgId, id])).rows[0]?.version ?? null },
      (tx, a) => updateTemplate(tx, a, id, body),
    );
  });

  /* -------------------------------------------------------------- saved views */

  app.get("/api/v1/saved-views", async (req) => {
    const who = requirePerson(req);
    const { screen } = z.object({ screen: z.string().max(40).optional() }).parse(req.query);
    return listViews(g.pool, g.orgId, who, screen);
  });

  app.post("/api/v1/saved-views", async (req) => {
    const body = ViewCreate.parse(req.body);
    return command(req, { action: null, idempotent: true }, (tx, a) => createView(tx, a, body));
  });

  const viewVersion = (id: string, who: () => string | null) => async (tx: import("@gantry/db").Tx) =>
    (await tx.query<{ version: number }>(`select version from saved_views where org_id = $1 and id = $2 and person_id = $3`, [g.orgId, id, who()])).rows[0]?.version ?? null;

  app.patch("/api/v1/saved-views/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const body = ViewPatch.parse(req.body);
    return command(req, { action: null, ifMatch: viewVersion(id, () => (req.gx.principal?.kind === "person" ? req.gx.principal.id : null)) }, (tx, a) => updateView(tx, a, id, body));
  });

  app.delete("/api/v1/saved-views/:id", async (req) => {
    const { id } = Id.parse(req.params);
    return command(req, { action: null, ifMatch: viewVersion(id, () => (req.gx.principal?.kind === "person" ? req.gx.principal.id : null)) }, (tx, a) => deleteView(tx, a, id));
  });

  /* ------------------------------------------------------------------- config */

  app.patch("/api/v1/projects/:id/config", async (req) => {
    const { id } = Id.parse(req.params);
    const body = ConfigBody.parse(req.body);
    const scope = { project: id };
    const ifMatch = projectVersion(g.orgId, id);
    if ("gate" in body) return inProject(req, { action: "project.config", scope, ifMatchRequired: true, ifMatch }, id, "edit", (tx, a) => changeGateMode(tx, a, id, body.gate, body.mode));
    const edit = parseConfigEdit(body.path, body.value);
    // Turning a gate off removes a check on future work: it needs a fresh sign-in on top of project.config (spec 14.1).
    const stepUp = edit.kind === "gate-enabled" && !edit.value ? { stepUp: true as const } : {};
    return inProject(req, { action: actionFor(edit), scope, ifMatchRequired: true, ifMatch, ...stepUp }, id, "edit", (tx, a) => setConfig(tx, a, id, edit, body.path));
  });

  /* --------------------------------------------------------------------- flow */

  const flowSpec = (id: string, action: "project.config" | "flow.edit" | "class.edit", idempotent = false) => ({ action, scope: { project: id }, ifMatchRequired: true, ifMatch: projectVersion(g.orgId, id), ...(idempotent ? { idempotent: true } : {}) });

  app.post("/api/v1/projects/:id/flow/:kind", async (req) => {
    const { id } = Id.parse(req.params);
    const { kind } = z.object({ kind: FlowKind }).parse(req.params);
    switch (kind) {
      case "stations": {
        const body = StationBody.parse(req.body);
        return inProject(req, flowSpec(id, "flow.edit", true), id, "edit", (tx, a) => addStationCmd(tx, a, id, body));
      }
      case "gates": {
        const body = GateBody.parse(req.body);
        return inProject(req, flowSpec(id, "flow.edit", true), id, "edit", (tx, a) => addGateCmd(tx, a, id, body));
      }
      case "bays": {
        const body = BayBody.parse(req.body);
        return inProject(req, flowSpec(id, "flow.edit", true), id, "edit", (tx, a) => addBayCmd(tx, a, id, body));
      }
      case "classes": {
        const body = ClassBody.parse(req.body);
        return inProject(req, flowSpec(id, "class.edit", true), id, "edit", (tx, a) => addClassCmd(tx, a, id, body));
      }
    }
  });

  app.delete("/api/v1/projects/:id/flow/:kind/:sub", async (req) => {
    const { id, sub } = IdSub.parse(req.params);
    const { kind } = z.object({ kind: FlowKind }).parse(req.params);
    if (kind !== "stations") throw refuse("invalid", "Only custom stations can be removed from a flow.");
    return inProject(req, flowSpec(id, "flow.edit"), id, "edit", (tx, a) => removeStationCmd(tx, a, id, sub));
  });

  app.patch("/api/v1/projects/:id/flow/:kind/:sub", async (req) => {
    const { id, sub } = IdSub.parse(req.params);
    const { kind } = z.object({ kind: FlowKind }).parse(req.params);
    if (kind === "stations") {
      const body = MoveBody.parse(req.body);
      return inProject(req, flowSpec(id, "flow.edit"), id, "edit", (tx, a) => moveStationCmd(tx, a, id, sub, body));
    }
    if (kind === "classes") {
      const body = ClassPatch.parse(req.body);
      return inProject(req, flowSpec(id, "class.edit"), id, "edit", (tx, a) => updateClassCmd(tx, a, id, sub, body));
    }
    throw refuse("invalid", "Only stations (move) and classes can be edited here.");
  });

  /* ---------------------------------------------------------------- approvers */

  app.put("/api/v1/projects/:id/approvers/:sub", async (req) => {
    const { id, sub } = IdSub.parse(req.params);
    const body = RuleBody.parse(req.body);
    return inProject(req, { action: "approvers.edit", scope: { project: id }, ifMatchRequired: true, ifMatch: projectVersion(g.orgId, id) }, id, "light", (tx, a) => putApprovers(tx, a, id, sub, body.value));
  });

  /* ------------------------------------------------------------------ members */

  const personVersion = (person: string) => async (tx: import("@gantry/db").Tx) => (await tx.query<{ version: number }>(`select version from people where org_id = $1 and id = $2`, [g.orgId, person])).rows[0]?.version ?? null;
  for (const [method, add] of [["PUT", true], ["DELETE", false]] as const) {
    app.route({
      method,
      url: "/api/v1/projects/:id/members/:person/roles/:role",
      handler: async (req) => {
        const { id, person, role } = Member.parse(req.params);
        // Role grants are role operations: a fresh sign-in (spec 14.1), like factory-role grants.
        return inProject(req, { action: "project.members", scope: { project: id }, stepUp: true, ifMatch: personVersion(person) }, id, "light", (tx, a) => setMemberRole(tx, a, id, person, role, add));
      },
    });
  }

  /* ------------------------------------------------------------------ archive */

  app.post("/api/v1/projects/:id/archive", async (req) => {
    const { id } = Id.parse(req.params);
    const body = ArchiveBody.parse(req.body ?? {});
    return command(req, { action: "project.archive", scope: { project: id }, ifMatchRequired: true, ifMatch: projectVersion(g.orgId, id) }, (tx, a) => archiveProject(tx, a, id, body));
  });

  app.post("/api/v1/projects/:id/unarchive", async (req) => {
    const { id } = Id.parse(req.params);
    return command(req, { action: "project.archive", scope: { project: id }, ifMatchRequired: true, ifMatch: projectVersion(g.orgId, id) }, (tx, a) => unarchiveProject(tx, a, id));
  });
};
