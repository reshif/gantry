/**
 * Integrations (spec 8.8, 12.1). Owns:
 *   GET/POST /api/v1/integration-types, DELETE /api/v1/integration-types/{id}, POST /api/v1/integration-types/{type}/test
 *   GET/POST /api/v1/integrations, PATCH/DELETE /api/v1/integrations/{id|channel}, POST .../test
 *   GET/POST/DELETE /api/v1/chat-links (the recorded link step that ties a chat user to one person)
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { visibleProjects } from "@gantry/domain";
import { command, decide, policyState, refuse, type CommandSpec } from "../core/index.js";
import { addInstance, addType, recordDraftTest, recordTest, removeInstance, removeType, resolveInstance, secretsOf, updateInstance } from "../areas/integrations/commands.js";
import { AddInstanceBody, CustomTypeBody, IdParam, PatchInstanceBody, TestBody, TypeIdParam } from "../areas/integrations/schemas.js";
import { ensureBuiltinTypes, instanceFromRow, metaOf, readInstanceRows, readType, readTypes } from "../areas/integrations/store.js";
import { testConnector, type Candidate, type TestResult } from "../areas/integrations/ops.js";
import { opsEnv } from "../areas/integrations/runtime.js";
import { open } from "../areas/integrations/secrets.js";
import { refuseIfFactoryKilled } from "../areas/integrations/stop.js";
import { chatLinkRoutes } from "../areas/integrations/links.js";

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  app.addHook("onReady", async () => {
    await ensureBuiltinTypes(g.pool, g.orgId).catch((err: unknown) => app.log.error({ err }, "could not write the built-in integration types"));
  });

  const spec = (action: "integration.add" | "integration.edit", idem = false): CommandSpec => ({ action, scope: {}, ...(idem ? { idempotent: true } : {}) });
  /** Runs the connection test before the transaction opens, but only for a caller the decision point allows (a denial is then audited by `command`). */
  const testFirst = async (req: FastifyRequest, action: "integration.add" | "integration.edit", run: () => Promise<TestResult>): Promise<TestResult | null> => ((await decide(req, action, {})).allowed ? run() : null);

  app.get("/api/v1/integration-types", async (req) => {
    requirePerson(req);
    await ensureBuiltinTypes(g.pool, g.orgId);
    return readTypes(g.pool, g.orgId);
  });

  app.post("/api/v1/integration-types", async (req) => {
    const b = CustomTypeBody.parse(req.body);
    return command(req, spec("integration.add", true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "the integration catalogue");
      return addType(tx, a, b);
    });
  });

  app.delete("/api/v1/integration-types/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    return command(req, spec("integration.add"), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "the integration catalogue");
      return removeType(tx, a, id);
    });
  });

  /** The connection test of the Add integration dialog: settings that are not saved yet. Audited, changes no row. */
  app.post("/api/v1/integration-types/:type/test", async (req) => {
    const { type } = TypeIdParam.parse(req.params);
    const b = TestBody.parse(req.body);
    const t = await readType(g.pool, g.orgId, type);
    if (!t) throw refuse("not_found", "No such integration type.");
    const secrets = secretsOf(t, b);
    const result = await testFirst(req, "integration.add", async () => {
      if (t.available === false) return { ok: false, ms: 1, lines: [["fail", t.unavailableReason ?? `${t.name} is not available yet.`]] } as TestResult;
      const bad = (await import("../areas/integrations/connectors.js")).validateConfig(t, b.config, secrets, { needSecret: true });
      if (bad) return { ok: false, ms: 1, lines: [["fail", bad]] } as TestResult;
      return testConnector(opsEnv(app), { type: t, config: b.config, secrets });
    });
    return command(req, spec("integration.add"), async (_tx, a) => recordDraftTest(a, t, result!));
  });

  app.get("/api/v1/integrations", async (req) => {
    const who = requirePerson(req);
    const rows = await readInstanceRows(g.pool, g.orgId);
    if ((await decide(req, "integration.edit", {})).allowed) return rows.map(instanceFromRow);
    const st = await policyState(req);
    const mine = new Set(visibleProjects(st, who).map((p) => p.id));
    return rows.filter((r) => { const p = metaOf(r.config).projects; return p === "all" || p.some((x) => mine.has(x)); }).map(instanceFromRow);
  });

  app.post("/api/v1/integrations", async (req) => {
    const b = AddInstanceBody.parse(req.body);
    const t = await readType(g.pool, g.orgId, b.type);
    const secrets = t ? secretsOf(t, b) : {};
    const result = t && t.available !== false && b.enable ? await testFirst(req, "integration.add", () => testConnector(opsEnv(app), { type: t, config: b.config, secrets })) : null;
    return command(req, spec("integration.add", true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "integrations");
      return addInstance(tx, a, g.config.secrets.dataKey, b, result);
    });
  });

  app.patch("/api/v1/integrations/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = PatchInstanceBody.parse(req.body);
    return command(
      req,
      { ...spec("integration.edit"), ifMatch: async (tx) => resolveInstance(tx, g.orgId, id).then((r) => r.version, () => null) },
      async (tx, a) => {
        await refuseIfFactoryKilled(tx, a.orgId, "integrations");
        return updateInstance(tx, a, g.config.secrets.dataKey, id, b);
      },
    );
  });

  app.post("/api/v1/integrations/:id/test", async (req) => {
    const { id } = IdParam.parse(req.params);
    const row = await resolveInstance(g.pool, g.orgId, id).catch(() => null);
    if (!row) throw refuse("not_found", "No such integration.");
    const t = (await readType(g.pool, g.orgId, row.type_id))!;
    const { _meta, ...config } = row.config;
    void _meta;
    const result = await testFirst(req, "integration.edit", async () => {
      let secrets;
      try {
        secrets = open(g.config.secrets.dataKey, row.id, row.secret_enc, t.fields.find((f) => f.type === "secret")?.key ?? "secret");
      } catch (e) {
        return { ok: false, ms: 1, lines: [["fail", (e as Error).message]] } as TestResult;
      }
      const c: Candidate = { type: t, config, secrets };
      return t.available === false ? ({ ok: false, ms: 1, lines: [["fail", t.unavailableReason ?? "Not available."]] } as TestResult) : testConnector(opsEnv(app), c);
    });
    return command(req, spec("integration.edit"), async (tx, a) => recordTest(tx, a, row.id, result!));
  });

  app.delete("/api/v1/integrations/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    return command(req, spec("integration.edit"), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "integrations");
      return removeInstance(tx, a, id);
    });
  });

  await app.register(chatLinkRoutes);
};
