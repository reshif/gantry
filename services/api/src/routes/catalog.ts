/**
 * Catalogue as data. Owns:
 *   GET /api/v1/catalog   { stations, gates, bays, classes, roles, actions }, built-in plus custom, in stable order
 * WorkOrder.station is an index into `stations`, so the order is part of the contract.
 */
import type { FastifyPluginAsync } from "fastify";
import { readCatalog } from "../core/read/index.js";

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/v1/catalog", async (req) => {
    const c = await readCatalog(app.gantry.pool, req.gx.orgId);
    return { stations: c.stations, gates: c.gates, bays: c.bays, classes: c.classes, roles: c.roles, actions: c.actions };
  });
};
