/**
 * Agents (spec 8.7). Owns:
 *   GET/POST /api/v1/agents, PATCH /api/v1/agents/{id}, POST .../versions, .../versions/{v}/promote, .../rollback
 *   PUT/DELETE /api/v1/agents/{id}/skills/{skill}, GET /api/v1/agents/{id}/effective?project=&repo=
 *   GET/PUT /api/v1/instructions/base, GET /api/v1/agents/suites
 * Every change goes through command(). Only people with `agent.edit` change an agent, its versions or the factory base; an agent has no route here (I6).
 */
import { visibleProjects } from "@gantry/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { command, policyState, refuse } from "../core/index.js";
import { attachSkill, baseInstructions, createAgent, newAgentVersion, promoteAgent, rollbackAgent, saveAgent, saveInstructions } from "../areas/agents/commands.js";
import { effectiveFor } from "../areas/agents/effective.js";
import { CreateBody, EffectiveQuery, IdParam, InstructionsBody, NewVersionBody, RollbackBody, SaveBody, SkillParam, VersionParam } from "../areas/agents/schemas.js";
import { agentRows, readAgents } from "../areas/agents/store.js";
import { refuseIfFactoryKilled } from "../areas/integrations/stop.js";
import { directoryAgents, directoryScope } from "../core/directory.js";

const requirePerson = (req: FastifyRequest): string => {
  const p = req.gx.principal;
  if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
  return p.id;
};

export const agentRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const spec = (idem = false) => ({ action: "agent.edit", scope: {}, ...(idem ? { idempotent: true } : {}) });
  const rev = (id: string) => async (tx: import("@gantry/db").Tx): Promise<number | null> => (await agentRows(tx, g.orgId, id))[0]?.version ?? null;
  const baseRev = async (tx: import("@gantry/db").Tx): Promise<number | null> => (await baseInstructions(tx, g.orgId)).baseVersion;

  app.get("/api/v1/agents", async (req) => {
    requirePerson(req);
    const mine = await directoryScope(req);
    const agents = await readAgents(g.pool, g.orgId);
    return mine ? directoryAgents(agents, mine) : agents;
  });

  /** The eval suites an agent may be gated on (the promotion gate picker). */
  app.get("/api/v1/agents/suites", async (req) => {
    requirePerson(req);
    const { rows } = await g.pool.query<{ id: string; name: string; station: string | null; agent_id: string | null; threshold: string | null }>(`select id, name, station, agent_id, data->>'threshold' as threshold from suites where org_id = $1 order by id`, [g.orgId]);
    return rows.map((r) => ({ id: r.id, name: r.name, station: r.station, agent: r.agent_id, threshold: r.threshold !== null && !Number.isNaN(Number(r.threshold)) ? Number(r.threshold) : 0.85 }));
  });

  app.get("/api/v1/instructions/base", async (req) => {
    requirePerson(req);
    return baseInstructions(g.pool, g.orgId);
  });

  app.get("/api/v1/agents/:id/effective", async (req) => {
    const who = requirePerson(req);
    const { id } = IdParam.parse(req.params);
    const q = EffectiveQuery.parse(req.query);
    if (q.project) {
      const st = await policyState(req);
      if (!visibleProjects(st, who).some((x) => x.id === q.project)) throw refuse("not_found", "No such project.");
    }
    return effectiveFor(g.pool, g.orgId, id, q);
  });

  app.post("/api/v1/agents", async (req) => {
    const b = CreateBody.parse(req.body);
    return command(req, spec(true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "agents");
      return createAgent(tx, a, b);
    });
  });

  app.patch("/api/v1/agents/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = SaveBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: rev(id), ifMatchRequired: true }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "agents");
      return saveAgent(tx, a, id, b.patch, b.note);
    });
  });

  app.post("/api/v1/agents/:id/versions", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = NewVersionBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: rev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "agents");
      return newAgentVersion(tx, a, id, b.label, b.note);
    });
  });

  app.post("/api/v1/agents/:id/versions/:v/promote", async (req) => {
    const { id, v } = VersionParam.parse(req.params);
    return command(req, { ...spec(), ifMatch: rev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "agents");
      return promoteAgent(tx, a, id, v);
    });
  });

  app.post("/api/v1/agents/:id/rollback", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = RollbackBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: rev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "agents");
      return rollbackAgent(tx, a, id, b.version);
    });
  });

  for (const method of ["put", "delete"] as const) {
    app[method]("/api/v1/agents/:id/skills/:skill", async (req) => {
      const { id, skill } = SkillParam.parse(req.params);
      return command(req, spec(), async (tx, a) => {
        await refuseIfFactoryKilled(tx, a.orgId, "agents");
        return attachSkill(tx, a, id, skill, method === "put");
      });
    });
  }

  app.put("/api/v1/instructions/base", async (req) => {
    const b = InstructionsBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: baseRev, ifMatchRequired: true }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "the factory base instructions");
      return saveInstructions(tx, a, b.text);
    });
  });
};
