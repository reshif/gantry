/**
 * Vendors, models, routing, prices and budgets (spec 8.7 Models, 10.4, 10.5). Owns:
 *   GET/POST /api/v1/vendors, PATCH /api/v1/vendors/{id}, POST /api/v1/vendors/{id}/qualify
 *   GET /api/v1/vendor-templates, POST /api/v1/vendors/from-template, POST /api/v1/vendors/{id}/discover
 *   POST/DELETE /api/v1/models, PATCH /api/v1/models/{id}
 *   GET/PUT /api/v1/routing, GET /api/v1/routing/versions, GET /api/v1/routing/resolve?station=&repo=&project=&class=
 *   GET/POST /api/v1/prices, GET /api/v1/prices/quote
 *   GET /api/v1/budgets, PUT /api/v1/budgets/{project}
 * Every state-changing handler goes through command() (docs/BUILD.md, spec 15.4). Only `model.edit` changes vendors, models, routing and prices.
 */
import { validateTemplateValues, vendorTemplate, VENDOR_TEMPLATES, visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { slug } from "../areas/agents/config.js";
import { command, decide, policyState, refuse } from "../core/index.js";
import { addModel, addVendor, publishPrices, qualifyVendor, removeModel, setModelContext, setModelEnabled, setRouting, setVendor, setWoBudget } from "../areas/models/commands.js";
import { resolveFor } from "../areas/models/facts.js";
import { costMicros, listPriceVersions, priceBookAt } from "../areas/models/prices.js";
import { discoverModels, discoveryHosts, type DiscoverResult } from "../areas/models/discovery.js";
import { addVendorFromTemplate, recordDiscoveryFailure, refreshVendorModels, splitValues, templateOf, valuesOf } from "../areas/models/templates.js";
import { allowDiscoveryHosts } from "../areas/internal/egress.js";
import { opsEnv } from "../areas/integrations/runtime.js";
import { AddModelBody, AddVendorBody, AddVendorFromTemplateBody, DiscoverBody, BudgetBody, IdParam, ModelPatchBody, PricesBody, ProjectParam, QualifyBody, QuoteQuery, ResolveQuery, SetRoutingBody, SetVendorBody } from "../areas/models/schemas.js";
import { loadRouting, readVendors, vendorRows } from "../areas/models/store.js";
import { refuseIfFactoryKilled } from "../areas/integrations/stop.js";

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const modelRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const spec = (idem = false) => ({ action: "model.edit", scope: {}, ...(idem ? { idempotent: true } : {}) });
  const vendorRev = (id: string) => async (tx: import("@gantry/db").Tx): Promise<number | null> => (await vendorRows(tx, g.orgId, id))[0]?.version ?? null;
  const routingRev = async (tx: import("@gantry/db").Tx): Promise<number | null> => (await loadRouting(tx, g.orgId)).version;

  // ------------------------------------------------------------------ reads
  app.get("/api/v1/vendors", async (req) => {
    requirePerson(req);
    return readVendors(g.pool, g.orgId);
  });

  /** The vendor templates: what to enter for each, and whether agents can call the vendor. Nothing secret. */
  app.get("/api/v1/vendor-templates", async (req) => {
    requirePerson(req);
    return VENDOR_TEMPLATES;
  });

  app.get("/api/v1/routing", async (req) => {
    requirePerson(req);
    return loadRouting(g.pool, g.orgId);
  });

  /** Every published routing version, newest first: who published it, when, and the change note. Read-only history. */
  app.get("/api/v1/routing/versions", async (req) => {
    requirePerson(req);
    const { rows } = await g.pool.query<{ version: number; published_at: Date; published_by: string | null; note: string | null }>(
      `select version, published_at, published_by, note from routing_versions where org_id = $1 and published_at is not null order by version desc limit 50`, [g.orgId]);
    return rows.map((r) => ({ version: r.version, publishedAt: r.published_at.toISOString(), publishedBy: r.published_by, note: r.note ?? "" }));
  });

  /** Where would a request go? The same resolver the edge uses at authorize time. */
  app.get("/api/v1/routing/resolve", async (req) => {
    const who = requirePerson(req);
    const q = ResolveQuery.parse(req.query);
    if (q.project) {
      const st = await policyState(req);
      if (!visibleProjects(st, who).some((x) => x.id === q.project)) throw refuse("not_found", "No such project.");
    }
    const r = await resolveFor(g.pool, g.orgId, { station: q.station, woClass: q.class, project: q.project, repoId: q.repo, pinned: q.model });
    return {
      model: r.pick?.model ?? null,
      vendor: r.pick?.vendor ?? null,
      wanted: r.wanted,
      layer: r.layer,
      steps: r.steps,
      rule: r.rule,
      blocked: r.blocked,
      alternates: r.alternates,
      crossModel: r.pick?.crossModel ?? false,
      sameModelFallback: r.pick?.sameModel ?? false,
    };
  });

  app.get("/api/v1/prices", async (req) => {
    requirePerson(req);
    const [versions, book] = await Promise.all([listPriceVersions(g.pool, g.orgId), priceBookAt(g.pool, g.orgId)]);
    return { current: book.version, versions };
  });

  /** Cost of a usage at the price version in force at `at` (default now). */
  app.get("/api/v1/prices/quote", async (req) => {
    requirePerson(req);
    const q = QuoteQuery.parse(req.query);
    const book = await priceBookAt(g.pool, g.orgId, q.at ? new Date(q.at) : new Date());
    const price = book.prices[q.model];
    return { model: q.model, priceVersion: book.version, priced: price !== undefined, costMicros: costMicros(price, { inputTokens: q.input, outputTokens: q.output, cacheReadTokens: q.cacheRead, cacheWriteTokens: q.cacheWrite }) };
  });

  app.get("/api/v1/budgets", async (req) => {
    const who = requirePerson(req);
    const st = await policyState(req);
    const ids = visibleProjects(st, who).map((p) => p.id);
    const { rows } = await g.pool.query<{ project_id: string; monthly: string; alert_at: string; wo: string; version: number; spent: string }>(
      `select b.project_id, b.monthly_limit_micros::text as monthly, b.alert_at::text, b.wo_limit_micros::text as wo, b.version,
              (select coalesce(sum(u.cost_micros),0) from usage_meter u where u.org_id = b.org_id and u.project_id = b.project_id and u.at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')::text as spent
         from budgets b where b.org_id = $1 and b.project_id = any($2) order by b.project_id`,
      [g.orgId, ids],
    );
    return rows.map((r) => ({ project: r.project_id, monthly: Number(r.monthly) / 1e6, alertAt: Number(r.alert_at), perWorkOrder: Number(r.wo) / 1e6, spent: Number(r.spent) / 1e6, version: r.version }));
  });

  // ------------------------------------------------------------------ commands
  app.post("/api/v1/vendors", async (req) => {
    const b = AddVendorBody.parse(req.body);
    return command(req, spec(true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "vendors");
      return addVendor(tx, a, g.config.secrets.dataKey, b);
    });
  });

  app.patch("/api/v1/vendors/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = SetVendorBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: vendorRev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "vendors");
      return setVendor(tx, a, g.config.secrets.dataKey, id, b.patch);
    });
  });

  /**
   * Discovery is a network call, so it runs before the transaction and only for a caller the decision point allows. It goes through the egress
   * proxy (system allow-list) with the credentials in hand; the edge is not involved, because the API already holds the sealed keys and the edge
   * has no way to be handed unsaved ones. A failure is audited and comes back as a 422 with the reason; nothing is stored.
   */
  const discover = async (req: import("fastify").FastifyRequest, t: NonNullable<ReturnType<typeof vendorTemplate>>, values: Record<string, string>): Promise<DiscoverResult | null> => {
    if (!(await decide(req, "model.edit", {})).allowed) return null;
    allowDiscoveryHosts(discoveryHosts(t, values));
    const http = opsEnv(app).http;
    let r = await discoverModels(http, t, values);
    // The edge caches the system allow-list for a few seconds; a host added a moment ago may need one more try.
    if (!r.ok && /allow-list/.test(r.msg)) {
      await new Promise((res) => setTimeout(res, 5_500));
      r = await discoverModels(http, t, values);
    }
    return r;
  };

  app.post("/api/v1/vendors/from-template", async (req) => {
    const b = AddVendorFromTemplateBody.parse(req.body);
    const t = vendorTemplate(b.template);
    if (!t) throw refuse("not_found", "No such vendor template.");
    const bad = validateTemplateValues(t, b.fields);
    if (bad) throw refuse("invalid", bad);
    const { plain, secrets } = splitValues(t, b.fields);
    const vname = b.name?.trim() || t.name;
    if ((await vendorRows(g.pool, g.orgId, slug(vname, 40)))[0]) throw refuse("conflict", `${vname} exists. Open its card to refresh its models, or give this one another name.`);
    const r = await discover(req, t, { ...plain, ...secrets, ...(b.fields.endpoint ? { endpoint: b.fields.endpoint.trim() } : {}) });
    if (r && !r.ok) {
      await command(req, spec(), async (_tx, a) => recordDiscoveryFailure(a, null, b.name?.trim() || t.name, r.msg));
      throw refuse("invalid", r.msg);
    }
    return command(req, spec(true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "vendors");
      return addVendorFromTemplate(tx, a, g.config.secrets.dataKey, b, r?.ok ? r.models : [], r?.ok ? r.warnings : []);
    });
  });

  app.post("/api/v1/vendors/:id/discover", async (req) => {
    const { id } = IdParam.parse(req.params);
    DiscoverBody.parse(req.body ?? {});
    const v = (await vendorRows(g.pool, g.orgId, id))[0];
    if (!v) throw refuse("not_found", "No such vendor.");
    const t = templateOf(v);
    if (!t) throw refuse("invalid", `${v.name} was not added from a template, so its models cannot be listed automatically.`);
    const enc = (await g.pool.query<{ secret_enc: string | null }>(`select secret_enc from vendors where org_id = $1 and id = $2`, [g.orgId, id])).rows[0]?.secret_enc ?? null;
    const values = valuesOf(v, t, enc, g.config.secrets.dataKey);
    if (!values) throw refuse("invalid", `${v.name}'s stored credentials could not be read. Add the vendor again.`);
    const r = await discover(req, t, values);
    if (r && !r.ok) {
      await command(req, spec(), async (_tx, a) => recordDiscoveryFailure(a, { type: "vendor", id }, v.name, r.msg));
      throw refuse("invalid", r.msg);
    }
    return command(req, { ...spec(), ifMatch: vendorRev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "models");
      return refreshVendorModels(tx, a, id, r?.ok ? r.models : [], r?.ok ? r.warnings : []);
    });
  });

  app.post("/api/v1/vendors/:id/qualify", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = QualifyBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: vendorRev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "vendors");
      return qualifyVendor(tx, a, id, b.station);
    });
  });

  app.post("/api/v1/models", async (req) => {
    const b = AddModelBody.parse(req.body);
    return command(req, spec(true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "models");
      return addModel(tx, a, b);
    });
  });

  app.delete("/api/v1/models/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    return command(req, spec(), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "models");
      return removeModel(tx, a, id);
    });
  });

  app.patch("/api/v1/models/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = ModelPatchBody.parse(req.body);
    return command(req, spec(), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "models");
      if (b.context !== undefined) {
        const c = await setModelContext(tx, a, id, b.context);
        if (b.enabled === undefined) return c;
        const e = await setModelEnabled(tx, a, id, b.enabled);
        return { ...e, events: [...c.events, ...e.events], msg: `${c.msg} ${e.msg}` };
      }
      return setModelEnabled(tx, a, id, b.enabled!);
    });
  });

  app.put("/api/v1/routing", async (req) => {
    const b = SetRoutingBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: routingRev, ifMatchRequired: true }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "routing");
      return setRouting(tx, a, b.routing, b.label);
    });
  });

  app.post("/api/v1/prices", async (req) => {
    const b = PricesBody.parse(req.body);
    return command(req, spec(true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "prices");
      return publishPrices(tx, a, b);
    });
  });

  app.put("/api/v1/budgets/:project", async (req) => {
    const { project } = ProjectParam.parse(req.params);
    const b = BudgetBody.parse(req.body);
    return command(req, { action: "project.config", scope: { project } }, async (tx, a) => setWoBudget(tx, a, project, b));
  });
};
