import { decrypt } from "@gantry/db";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { notFound, refuse } from "../../core/errors.js";

/**
 * Vendor keys entered in the product are stored encrypted (vendors.secret_enc, AES-256-GCM with the data key). The edge holds no
 * database access, so it fetches a key here with its service token just before a call. The value is never logged or returned to browsers.
 * The envelope is tried with the AAD `vendor:<id>` and without one.
 */
export const vendorKeyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/internal/v1/vendors/:id/key", async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
    if (req.gx.principal?.kind !== "service" || req.gx.principal.id !== "edge") throw refuse("denied", "Only the edge reads vendor keys.");
    const g = req.server.gantry;
    const key = g.config.secrets.dataKey;
    if (!key) throw refuse("invalid", "No data key is configured.");
    const row = (await g.pool.query<{ secret_enc: string | null }>(`select secret_enc from vendors where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
    if (!row) throw notFound("No such vendor.");
    if (!row.secret_enc) throw notFound("That vendor has no stored key.");
    for (const aad of [`vendor:${id}`, undefined]) {
      const r = decrypt(row.secret_enc, key, aad);
      if (r.ok) return reply.header("cache-control", "no-store").send({ ok: true, key: r.value });
    }
    throw refuse("invalid", "The stored vendor key could not be decrypted.");
  });
};
