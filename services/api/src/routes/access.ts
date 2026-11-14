/**
 * Access: role matrix, roles, policies, freezes and the simulator (spec 8.9, 14.4). Owns:
 *   GET /api/v1/access/matrix                      { matrix, roles, actions, version }
 *   PUT /api/v1/access/matrix/{role}/{action}      { on }, If-Match: matrix version, step-up
 *   POST /api/v1/roles, PATCH/DELETE /api/v1/roles/{id}
 *   GET/POST /api/v1/policies, PATCH/DELETE /api/v1/policies/{id}
 *   GET/POST /api/v1/freezes, POST /api/v1/freezes/{id}/end
 *   POST /api/v1/access/simulate
 *
 * The simulator calls the same `can()` as every enforcement point (domain simulate()). Matrix, role, policy and freeze
 * changes change who can restore and who can edit policy, so they need a fresh sign-in (spec 14.4).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { command, decide, policyState, readCatalog, readFreezes, readMatrix, readPolicies, refuse } from "../core/index.js";
import { createFreeze, endFreeze, freezeVersion } from "../areas/access/freezes.js";
import { matrixVersion, setMatrixCell } from "../areas/access/matrix.js";
import { createPolicy, deletePolicy, policyVersion, setPolicyEnabled, updatePolicy } from "../areas/access/policies.js";
import { addRole, removeRole, roleVersion, updateRole } from "../areas/access/roles.js";
import { FreezeBody, MatrixBody, PolicyBody, PolicyPatch, RoleCreate, RolePatch, SimulateBody } from "../areas/access/schemas.js";
import { runSimulation } from "../areas/access/simulate.js";

const Id = z.object({ id: z.string().min(1).max(100) });
const STEP_UP = true as const;

export const accessRoutes: FastifyPluginAsync = async (app) => {
  const g = app.gantry;
  const requirePerson = (req: FastifyRequest): string => {
    const p = req.gx.principal;
    if (p?.kind !== "person") throw refuse("denied", "This view is for signed-in people.");
    return p.id;
  };

  app.get("/api/v1/access/matrix", async (req) => {
    requirePerson(req);
    const catalog = await readCatalog(g.pool, req.gx.orgId);
    const m = await readMatrix(g.pool, req.gx.orgId, catalog.actions);
    return { matrix: m.value, roles: catalog.roles, actions: catalog.actions, version: m.version };
  });

  app.put("/api/v1/access/matrix/:role/:action", async (req) => {
    const { role, action } = z.object({ role: z.string().min(1).max(100), action: z.string().min(1).max(100) }).parse(req.params);
    const { on } = MatrixBody.parse(req.body);
    return command(req, { action: "policy.edit", stepUp: STEP_UP, ifMatchRequired: true, ifMatch: (tx) => matrixVersion(tx, g.orgId) }, (tx, a) => setMatrixCell(tx, a.orgId, a.id, role, action, on));
  });

  /* ---- roles ---- */

  app.post("/api/v1/roles", async (req) => {
    const body = RoleCreate.parse(req.body);
    return command(req, { action: "role.edit", stepUp: STEP_UP, idempotent: true }, (tx, a) => addRole(tx, a.orgId, a.id, body));
  });
  app.patch("/api/v1/roles/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const body = RolePatch.parse(req.body);
    return command(req, { action: "role.edit", stepUp: STEP_UP, ifMatchRequired: true, ifMatch: (tx) => roleVersion(tx, g.orgId, id) }, (tx, a) => updateRole(tx, a.orgId, id, body));
  });
  app.delete("/api/v1/roles/:id", async (req) => {
    const { id } = Id.parse(req.params);
    return command(req, { action: "role.edit", stepUp: STEP_UP, ifMatchRequired: true, ifMatch: (tx) => roleVersion(tx, g.orgId, id) }, (tx, a) => removeRole(tx, a.orgId, a.id, id));
  });

  /* ---- policies ---- */

  app.get("/api/v1/policies", async (req) => {
    requirePerson(req);
    return readPolicies(g.pool, req.gx.orgId);
  });
  app.post("/api/v1/policies", async (req) => {
    const body = PolicyBody.parse(req.body);
    return command(req, { action: "policy.edit", stepUp: STEP_UP, idempotent: true }, (tx, a) => createPolicy(tx, a.orgId, a.id, body));
  });
  app.patch("/api/v1/policies/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const body = PolicyPatch.parse(req.body);
    return command(req, { action: "policy.edit", stepUp: STEP_UP, ifMatchRequired: true, ifMatch: (tx) => policyVersion(tx, g.orgId, id) }, (tx, a) =>
      "name" in body ? updatePolicy(tx, a.orgId, a.id, id, body) : setPolicyEnabled(tx, a.orgId, a.id, id, body.enabled),
    );
  });
  app.delete("/api/v1/policies/:id", async (req) => {
    const { id } = Id.parse(req.params);
    return command(req, { action: "policy.edit", stepUp: STEP_UP, ifMatchRequired: true, ifMatch: (tx) => policyVersion(tx, g.orgId, id) }, (tx, a) => deletePolicy(tx, a.orgId, id));
  });

  /* ---- freezes ---- */

  app.get("/api/v1/freezes", async (req) => {
    requirePerson(req);
    return readFreezes(g.pool, req.gx.orgId);
  });
  app.post("/api/v1/freezes", async (req) => {
    const body = FreezeBody.parse(req.body);
    return command(req, { action: "policy.edit", stepUp: STEP_UP, idempotent: true }, (tx, a) => createFreeze(tx, a.orgId, a.id, body));
  });
  app.post("/api/v1/freezes/:id/end", async (req) => {
    const { id } = Id.parse(req.params);
    return command(req, { action: "policy.edit", stepUp: STEP_UP, ifMatchRequired: true, ifMatch: (tx) => freezeVersion(tx, g.orgId, id) }, (tx, a) => endFreeze(tx, a.orgId, id));
  });

  /* ---- simulator ---- */

  app.post("/api/v1/access/simulate", async (req) => {
    const viewer = requirePerson(req);
    const q = SimulateBody.parse(req.body);
    // Anyone may ask about themselves; asking about others needs a right that already shows the permission structure.
    if (q.person !== viewer) {
      const seen = await Promise.all(["policy.edit", "role.edit", "people.manage", "audit.view"].map((a) => decide(req, a)));
      if (!seen.some((d) => d.allowed)) throw refuse("denied", "Simulating another person's access needs the right to manage people, roles, policies or the audit.", { needs: "people.manage or audit.view" });
    }
    const out = runSimulation(await policyState(req), q, Date.now());
    if ("error" in out) throw refuse("invalid", out.error);
    return { ok: true, ...out };
  });
};
