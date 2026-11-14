/**
 * Skills (spec 8.7). Owns:
 *   GET/POST /api/v1/skills, PATCH /api/v1/skills/{id}, PUT /api/v1/skills/{id}/projects
 * Every save is a new immutable version. Changes need `skill.edit`; an agent cannot change a skill (I6).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { command, refuse } from "../core/index.js";
import { refuseIfFactoryKilled } from "../areas/integrations/stop.js";
import { createSkill, saveSkill, setSkillProjects } from "../areas/skills/commands.js";
import { CreateSkillBody, ProjectsBody, SaveSkillBody, SkillIdParam } from "../areas/skills/schemas.js";
import { readSkills, skillRows } from "../areas/skills/store.js";

const requirePerson = (req: FastifyRequest): void => {
  if (req.gx.principal?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
};

export const skillRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const spec = (idem = false) => ({ action: "skill.edit", scope: {}, ...(idem ? { idempotent: true } : {}) });
  const rev = (id: string) => async (tx: import("@gantry/db").Tx): Promise<number | null> => (await skillRows(tx, g.orgId, id))[0]?.version ?? null;

  app.get("/api/v1/skills", async (req) => {
    requirePerson(req);
    return readSkills(g.pool, g.orgId);
  });

  app.post("/api/v1/skills", async (req) => {
    const b = CreateSkillBody.parse(req.body);
    return command(req, spec(true), async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "skills");
      return createSkill(tx, a, b);
    });
  });

  app.patch("/api/v1/skills/:id", async (req) => {
    const { id } = SkillIdParam.parse(req.params);
    const b = SaveSkillBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: rev(id), ifMatchRequired: true }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "skills");
      return saveSkill(tx, a, id, b.patch, b.note);
    });
  });

  app.put("/api/v1/skills/:id/projects", async (req) => {
    const { id } = SkillIdParam.parse(req.params);
    const b = ProjectsBody.parse(req.body);
    return command(req, { ...spec(), ifMatch: rev(id) }, async (tx, a) => {
      await refuseIfFactoryKilled(tx, a.orgId, "skills");
      return setSkillProjects(tx, a, id, b.projects);
    });
  });
};
