import { createHash } from "node:crypto";
import type { Tx } from "./tx.js";

/** Canonical JSON (object keys sorted), so equal bodies hash equal regardless of key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const hashBody = (body: unknown): string => createHash("sha256").update(canonicalJson(body)).digest("hex");

export interface IdempotencyKey {
  orgId: string;
  /** Namespace: actor plus route, so keys from different callers or endpoints never collide. */
  scope: string;
  key: string;
  body: unknown;
}

export type IdempotencyState =
  | { state: "new" }
  | { state: "replay"; status: number; response: unknown }
  | { state: "conflict" };

/**
 * Call first in the command's transaction. `new`: run the command, then `storeResult` in the same transaction.
 * A concurrent request with the same key blocks on the unique index until the first commits, then sees `replay`
 * (same body) or `conflict` (different body). If the first rolls back the key is released and this one proceeds.
 */
export async function begin(tx: Tx, k: IdempotencyKey): Promise<IdempotencyState> {
  const hash = hashBody(k.body);
  const ins = await tx.query(
    `insert into idempotency_keys (org_id, scope, key, request_hash) values ($1, $2, $3, $4) on conflict (org_id, scope, key) do nothing`,
    [k.orgId, k.scope, k.key, hash],
  );
  if (ins.rowCount === 1) return { state: "new" };
  const { rows } = await tx.query<{ request_hash: string; response_status: number | null; response: unknown; completed_at: Date | null }>(
    `select request_hash, response_status, response, completed_at from idempotency_keys where org_id = $1 and scope = $2 and key = $3`,
    [k.orgId, k.scope, k.key],
  );
  const row = rows[0]!;
  if (row.request_hash !== hash) return { state: "conflict" };
  if (row.completed_at === null) return { state: "new" }; // left unfinished by a committed partial run: take it over
  return { state: "replay", status: row.response_status ?? 200, response: row.response };
}

export async function storeResult(tx: Tx, k: Pick<IdempotencyKey, "orgId" | "scope" | "key">, status: number, response: unknown): Promise<void> {
  await tx.query(
    `update idempotency_keys set response_status = $4, response = $5::jsonb, completed_at = now() where org_id = $1 and scope = $2 and key = $3`,
    [k.orgId, k.scope, k.key, status, JSON.stringify(response ?? null)],
  );
}

/** Convenience wrapper: runs `fn` once per key and body; later calls return the stored result. Must run inside withTx. */
export async function idempotent<T>(
  tx: Tx,
  k: IdempotencyKey,
  fn: () => Promise<{ status: number; response: T }>,
): Promise<{ replayed: false; status: number; response: T } | { replayed: true; status: number; response: unknown } | { conflict: true }> {
  const s = await begin(tx, k);
  if (s.state === "conflict") return { conflict: true };
  if (s.state === "replay") return { replayed: true, status: s.status, response: s.response };
  const r = await fn();
  await storeResult(tx, k, r.status, r.response);
  return { replayed: false, ...r };
}

/** Deletes expired keys (retention). Owner or maintenance use; returns the number removed. */
export async function purgeExpired(tx: Tx): Promise<number> {
  const r = await tx.query(`delete from idempotency_keys where expires_at < now()`);
  return r.rowCount ?? 0;
}
