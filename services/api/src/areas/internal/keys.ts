import { appendEvent, decrypt, encrypt, withTx } from "@gantry/db";
import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireEdge } from "./edge-only.js";
import { notFound, refuse } from "../../core/errors.js";
import { DenialSampler } from "../../core/denial-sampler.js";

/** One audit row per vendor a minute, however often the edge asks; the next row carries how many reads it stands for. */
export const vendorKeyReads = new DenialSampler(1, 1000);

/**
 * Vendor keys entered in the product are stored encrypted (vendors.secret_enc, AES-256-GCM with the data key). The edge holds no
 * database access, so it fetches a key here with its service token just before a call. The value is never logged or returned to browsers.
 * Every read is audited (`vendor.key.read`, sampled to one row per vendor a minute) with a fingerprint of the key, never the key. The envelope is bound
 * to its row with the AAD `vendor:<id>`. An old envelope sealed without it is still read once, then re-sealed bound to its row on the spot, so a ciphertext
 * copied between rows stops working.
 */
export const vendorKeyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/internal/v1/vendors/:id/key", async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
    await requireEdge(req, "vendor.key.read");
    const g = req.server.gantry;
    const key = g.config.secrets.dataKey;
    if (!key) throw refuse("invalid", "No data key is configured.");
    const row = (await g.pool.query<{ secret_enc: string | null }>(`select secret_enc from vendors where org_id = $1 and id = $2`, [g.orgId, id])).rows[0];
    if (!row) throw notFound("No such vendor.");
    if (!row.secret_enc) throw notFound("That vendor has no stored key.");
    const bound = `vendor:${id}`;
    let value: string | null = null;
    let legacy = false;
    const first = decrypt(row.secret_enc, key, bound);
    if (first.ok) value = first.value;
    else {
      const old = decrypt(row.secret_enc, key);
      if (old.ok) {
        value = old.value;
        legacy = true;
      }
    }
    if (value !== null) {
      const sample = vendorKeyReads.sample(`vendor-key:${id}`, "edge");
      await withTx(g.pool, async (tx) => {
        // legacy unbound envelope: bind it to this row now (only if it has not changed since it was read)
        if (legacy) await tx.query(`update vendors set secret_enc = $4 where org_id = $1 and id = $2 and secret_enc = $3`, [g.orgId, id, row.secret_enc, encrypt(value!, key, bound)]);
        if (sample.audit || legacy)
          await appendEvent(tx, {
            orgId: g.orgId, type: "vendor.key.read", category: "integrations", actor: "edge", channel: "system", subject: { type: "vendor", id }, outcome: "ok", rule: "VENDOR-KEY-READ",
            after: { fingerprint: createHash("sha256").update(value!).digest("hex").slice(0, 12), ...(legacy ? { resealed: true } : {}), ...(sample.suppressed ? { readsSinceLastRow: sample.suppressed } : {}) }, requestId: req.gx.requestId,
          });
      });
      return reply.header("cache-control", "no-store").send({ ok: true, key: value });
    }
    throw refuse("invalid", "The stored vendor key could not be decrypted.");
  });
};
