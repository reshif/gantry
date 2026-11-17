/**
 * Notifications (spec 8.8, 12.2). Owns:
 *   GET/POST /api/v1/projects/{id}/routes, PATCH/DELETE .../routes/{rid}, POST .../routes/test
 *   GET /api/v1/deliveries, POST /api/v1/deliveries/{id}/retry
 *   GET/POST /api/v1/card-templates, DELETE .../{id}, POST /api/v1/card-templates/preview
 * The producer that turns committed events into outbox rows is areas/notifications/producer.ts, registered here for the API process.
 */
import { z } from "zod";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { visibleProjects } from "@gantry/domain";
import { command, decide, policyState, refuse, type CommandSpec } from "../core/index.js";
import { actionsFor, emailParts, eventName, factRows, loadSample, slackBlocks, teamsCard, webhookData, builtinTemplate } from "../areas/notifications/cards.js";
import { createRoute, deleteRoute, removeCardTemplate, retryDelivery, saveCardTemplate, sendTest, updateRoute } from "../areas/notifications/commands.js";
import { registerNotificationProducer } from "../areas/notifications/producer.js";
import { CardTemplateBody, DeliveryQuery, PreviewBody, ProjectParam, RouteBody, RouteParam, RoutePatch, TestBody } from "../areas/notifications/schemas.js";
import { readCardTemplates, readDeliveries, readRoutes } from "../areas/notifications/store.js";
import { isMandatoryEvent } from "../areas/notifications/events.js";
import { loadInstances, resolveDest } from "../areas/notifications/routing.js";
import { refuseIfStopped } from "../areas/projects/store.js";
import { IdParam } from "../areas/integrations/schemas.js";

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  registerNotificationProducer({ publicUrl: g.config.publicUrl, onError: (err, e) => app.log.error({ err, event: e.type }, "notification producer failed") });

  const visible = async (req: FastifyRequest, project: string): Promise<void> => {
    const who = requirePerson(req);
    const st = await policyState(req);
    if (!visibleProjects(st, who).some((p) => p.id === project)) throw refuse("not_found", "No such project.");
  };
  const projectSpec = (project: string, action = "notify.edit"): CommandSpec => ({ action, scope: { project } });

  app.get("/api/v1/projects/:id/routes", async (req) => {
    const { id } = ProjectParam.parse(req.params);
    await visible(req, id);
    return readRoutes(g.pool, g.orgId, id);
  });

  /** What an event would really reach: each enabled route destination resolved against the connected integration instances, as the notifier does. */
  app.get("/api/v1/projects/:id/routes/preview", async (req) => {
    const { id } = ProjectParam.parse(req.params);
    const { event } = z.object({ event: z.string().min(1).max(60) }).parse(req.query);
    await visible(req, id);
    const [routes, insts] = await Promise.all([readRoutes(g.pool, g.orgId, id), loadInstances(g.pool, g.orgId)]);
    const mandatory = isMandatoryEvent(event);
    const seen = new Set<string>();
    const items: Array<{ channel: string; target: string; deliverable: boolean; reason: string; integration: string | null }> = [];
    for (const r of routes) {
      if (r.event !== event || (!r.enabled && !mandatory)) continue;
      for (const d of r.dest) {
        const k = `${d.channel}\u0000${d.target}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const res = resolveDest(insts, d, id, mandatory);
        items.push({ channel: d.channel, target: d.target, deliverable: res.ok, reason: res.ok ? "" : res.error, integration: res.inst?.id ?? null });
      }
    }
    return { event, items };
  });

  app.post("/api/v1/projects/:id/routes", async (req) => {
    const { id } = ProjectParam.parse(req.params);
    const b = RouteBody.parse(req.body);
    await visible(req, id);
    return command(req, { ...projectSpec(id), idempotent: true }, async (tx, a) => {
      await refuseIfStopped(req, projectSpec(id), tx, a.orgId, id);
      return createRoute(tx, a, id, b);
    });
  });

  const routeVersion = (project: string, rid: string) => async (tx: import("@gantry/db").Tx): Promise<number | null> =>
    (await tx.query<{ version: number }>(`select version from notification_routes where org_id = $1 and id = $2 and project_id = $3`, [g.orgId, `${project}:${rid}`, project])).rows[0]?.version ?? null;

  app.patch("/api/v1/projects/:id/routes/:rid", async (req) => {
    const { id, rid } = RouteParam.parse(req.params);
    const b = RoutePatch.parse(req.body);
    await visible(req, id);
    return command(req, { ...projectSpec(id), ifMatch: routeVersion(id, rid), ifMatchRequired: true }, async (tx, a) => {
      await refuseIfStopped(req, projectSpec(id), tx, a.orgId, id);
      return updateRoute(tx, a, id, rid, b);
    });
  });

  app.delete("/api/v1/projects/:id/routes/:rid", async (req) => {
    const { id, rid } = RouteParam.parse(req.params);
    await visible(req, id);
    return command(req, { ...projectSpec(id), ifMatch: routeVersion(id, rid), ifMatchRequired: true }, async (tx, a) => {
      await refuseIfStopped(req, projectSpec(id), tx, a.orgId, id);
      return deleteRoute(tx, a, id, rid);
    });
  });

  app.post("/api/v1/projects/:id/routes/test", async (req) => {
    const { id } = ProjectParam.parse(req.params);
    const b = TestBody.parse(req.body);
    await visible(req, id);
    return command(req, projectSpec(id), async (tx, a) => {
      await refuseIfStopped(req, projectSpec(id), tx, a.orgId, id, "light");
      return sendTest(tx, a, g.config.publicUrl, id, b);
    });
  });

  app.get("/api/v1/deliveries", async (req) => {
    const who = requirePerson(req);
    const q = DeliveryQuery.parse(req.query);
    const st = await policyState(req);
    const mine = visibleProjects(st, who).map((p) => p.id);
    const all = (await decide(req, "integration.edit", {})).allowed;
    return readDeliveries(g.pool, g.orgId, { projects: all ? "all" : mine, includeFactory: all, project: q.project, status: q.status, integration: q.integration, event: q.event, cursor: q.cursor, limit: q.limit });
  });

  app.post("/api/v1/deliveries/:id/retry", async (req) => {
    const { id } = IdParam.parse(req.params);
    const d = (await g.pool.query<{ project_id: string | null }>(`select project_id from deliveries where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
    if (!d) throw refuse("not_found", "No such delivery.");
    const spec: CommandSpec = d.project_id ? projectSpec(d.project_id) : { action: "integration.edit", scope: {} };
    return command(req, spec, async (tx, a) => {
      if (d.project_id) await refuseIfStopped(req, spec, tx, a.orgId, d.project_id, "light");
      return retryDelivery(tx, a, g.config.publicUrl, id);
    });
  });

  app.get("/api/v1/card-templates", async (req) => {
    requirePerson(req);
    return readCardTemplates(g.pool, g.orgId);
  });

  /** Card templates are factory-wide. The action is the project-scoped `notify.edit`, checked in the project the editor is working in; without one, the factory right to manage integrations. */
  const cardSpec = (project: string | null | undefined): CommandSpec => (project ? projectSpec(project) : { action: "integration.edit", scope: {} });

  /**
   * A card template belongs to the project it was made in (`body.project`), or to the factory when that is empty. Project-scoped `notify.edit`
   * changes only templates the named project owns; a factory-wide template, or another project's, needs the factory right. An unknown id takes
   * the factory path too, so a refusal never says whether the id exists.
   */
  const editSpec = async (id: string | undefined, project: string | null | undefined): Promise<CommandSpec> => {
    if (!id) return cardSpec(project);
    const row = (await g.pool.query<{ owner: string | null }>(`select body ->> 'project' as owner from card_templates where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
    return project && row && row.owner === project ? projectSpec(project) : { action: "integration.edit", scope: {} };
  };

  app.post("/api/v1/card-templates", async (req) => {
    const b = CardTemplateBody.parse(req.body);
    const spec = await editSpec(b.id, b.project);
    // Only a caller without the factory right is held to "no card other projects use".
    const projectOnly = b.id ? !(await decide(req, "integration.edit", {})).allowed : false;
    return command(req, { ...spec, idempotent: !b.id }, (tx, a) => saveCardTemplate(tx, a, b, { projectOnly }));
  });

  app.delete("/api/v1/card-templates/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const q = (req.query ?? {}) as { project?: string };
    return command(req, await editSpec(id, q.project), (tx, a) => removeCardTemplate(tx, a, id));
  });

  /** Renders a card without saving or sending it: the same builders the producer uses, so the preview is what goes out. */
  app.post("/api/v1/card-templates/preview", async (req) => {
    const b = PreviewBody.parse(req.body);
    await visible(req, b.project);
    // A work order is read only through the project it belongs to: another project's id is the same 404 as an unknown one.
    if (b.wo) {
      const w = (await g.pool.query<{ project_id: string }>(`select project_id from work_orders where org_id = $1 and id = $2`, [g.orgId, b.wo])).rows[0];
      if (!w || w.project_id !== b.project) throw refuse("not_found", "No such work order.");
    }
    const sample = await loadSample(g.pool, { orgId: g.orgId, publicUrl: g.config.publicUrl, event: b.event, projectId: b.project, ...(b.template ? { template: b.template } : {}), ...(b.wo ? { woId: b.wo } : {}) });
    const template = b.template || sample.template;
    const custom = !builtinTemplate(template) ? (await g.pool.query<{ body: { kind?: string; actions?: string[]; fields?: string[] } }>(`select body from card_templates where org_id = $1 and id = $2`, [g.orgId, template])).rows[0]?.body : null;
    const fields = b.fields ?? {};
    const rows = factRows(fields, b.event, template, sample);
    const listed = b.actions ?? custom?.actions ?? builtinTemplate(template)?.actions ?? ["open"];
    const actions = actionsFor(fields, template, { canApprove: true, actions: listed, channel: "slack" }, sample.link);
    return {
      ok: true, event: b.event, eventName: eventName(b.event), template, sample, rows, actions: listed,
      slack: { blocks: slackBlocks(sample, rows, actions) }, teams: teamsCard(sample, rows, actions),
      email: emailParts(sample, rows, actionsFor(fields, template, { canApprove: false, actions: listed, channel: "email" }, sample.link), { showLink: fields.link !== false }),
      webhook: webhookData(sample, fields),
    };
  });
};
