import { randomBytes } from "node:crypto";
import type { Queryable } from "@gantry/db";
import { sha256Hex } from "../crypto.js";

/** API keys look like `gk_<8 hex prefix>_<secret>`. Only the SHA-256 of the whole key is stored; the prefix is shown in lists. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex");
  const key = `gk_${prefix}_${randomBytes(24).toString("base64url")}`;
  return { key, prefix, hash: sha256Hex(key) };
}
export const hashApiKey = (key: string): string => sha256Hex(key);

export interface ApiKeyPrincipal {
  id: string;
  name: string;
  projectId: string | null;
  scopes: string[];
}

/** Resolves a bearer key: not revoked, not expired. Last-use is recorded at most once a minute. */
export async function authenticateApiKey(db: Queryable, orgId: string, key: string): Promise<ApiKeyPrincipal | null> {
  if (!key.startsWith("gk_") || key.length > 200) return null;
  const { rows } = await db.query(
    `update api_keys set last_used_at = now() where org_id = $1 and key_hash = $2 and revoked_at is null and (expires_at is null or expires_at > now())
       and (last_used_at is null or last_used_at < now() - interval '1 minute') returning id, name, project_id, scopes`,
    [orgId, hashApiKey(key)],
  );
  const r =
    rows[0] ??
    (
      await db.query(`select id, name, project_id, scopes from api_keys where org_id = $1 and key_hash = $2 and revoked_at is null and (expires_at is null or expires_at > now())`, [orgId, hashApiKey(key)])
    ).rows[0];
  if (!r) return null;
  return { id: r.id, name: r.name, projectId: r.project_id, scopes: Array.isArray(r.scopes) ? r.scopes.filter((s: unknown): s is string => typeof s === "string") : [] };
}
