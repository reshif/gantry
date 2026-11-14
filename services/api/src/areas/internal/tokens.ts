import { createHash, randomBytes } from "node:crypto";
import type { Queryable, Tx } from "@gantry/db";

/** Default lifetime of a run token. Longer than any wall-clock limit; the token is revoked on stop and when the run ends. */
export const RUN_TOKEN_TTL_SECONDS = 6 * 3600;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const hashRunToken = (token: string): string => sha256(token);

/**
 * Token shape: `grt.<base64url(run id)>.<base64url(32 random bytes)>`. The run id is only a routing hint (the model gateway
 * gets nothing but the token from the harness); trust comes from the stored hash, which binds the token to the run and fencing.
 * The alphabet matches the launcher's run-token pattern.
 */
export function formatRunToken(runId: string, secret: string = randomBytes(32).toString("base64url")): string {
  return `grt.${Buffer.from(runId, "utf8").toString("base64url")}.${secret}`;
}

/** The run id named in a token, or null when it is malformed. Not proof of anything. */
export function runIdOfToken(token: string): string | null {
  const m = /^grt\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{20,128})$/.exec(token);
  if (!m) return null;
  const id = Buffer.from(m[1]!, "base64url").toString("utf8");
  return id.length > 0 ? id : null;
}

export interface IssuedRunToken {
  /** The token for the runner's environment. Returned once; only its hash is stored. */
  token: string;
  id: string;
  expiresAt: Date;
}

/**
 * Issues the per-run token (spec 4.3 step 3, 5.3). Call inside the dispatch transaction after the attempt and run rows exist.
 * Throws when the run or attempt is unknown or the fencing number is not the attempt's (a bug in the caller, not a runtime outcome).
 */
export async function issueRunToken(tx: Tx, runId: string, attemptId: string, fencing: number | string | bigint, opts: { orgId?: string; ttlSeconds?: number } = {}): Promise<IssuedRunToken> {
  const { rows } = await tx.query<{ org_id: string; fencing: string }>(
    `select r.org_id, a.fencing::text as fencing from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id
      where r.id = $1 and r.attempt_id = $2 and ($3::uuid is null or r.org_id = $3::uuid)`,
    [runId, attemptId, opts.orgId ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error(`issueRunToken: no run ${runId} for attempt ${attemptId}`);
  if (row.fencing !== String(fencing)) throw new Error(`issueRunToken: fencing ${String(fencing)} is not attempt ${attemptId}'s (${row.fencing})`);
  const token = formatRunToken(runId);
  const id = `rt-${randomBytes(9).toString("hex")}`;
  const ttl = opts.ttlSeconds ?? RUN_TOKEN_TTL_SECONDS;
  const { rows: ins } = await tx.query<{ expires_at: Date }>(
    `insert into run_tokens (org_id, id, run_id, attempt_id, fencing, token_hash, expires_at)
     values ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7)) returning expires_at`,
    [row.org_id, id, runId, attemptId, String(fencing), hashRunToken(token), ttl],
  );
  return { token, id, expiresAt: ins[0]!.expires_at };
}

export interface RevokeTarget {
  orgId: string;
  /** Revoke the tokens of these runs. */
  runIds?: string[];
  /** Or every run of a work order, of a project, or all (factory kill). */
  woId?: string;
  projectId?: string;
  all?: boolean;
  reason: string;
}

/** Revokes live run tokens (spec 5.3: revoked on stop). Returns the number revoked. Call it from the stop transaction. */
export async function revokeRunTokens(db: Queryable, t: RevokeTarget): Promise<number> {
  const { rowCount } = await db.query(
    `update run_tokens t set revoked_at = now(), revoked_reason = $2
      where t.org_id = $1 and t.revoked_at is null
        and ($3::text[] is not null and t.run_id = any($3)
          or $4::text is not null and exists (select 1 from runs r where r.org_id = t.org_id and r.id = t.run_id and r.wo_id = $4)
          or $5::text is not null and exists (select 1 from runs r join work_orders w on w.org_id = r.org_id and w.id = r.wo_id where r.org_id = t.org_id and r.id = t.run_id and w.project_id = $5)
          or $6::boolean)`,
    [t.orgId, t.reason, t.runIds ?? null, t.woId ?? null, t.projectId ?? null, t.all ?? false],
  );
  return rowCount ?? 0;
}

export interface TokenRow {
  id: string;
  run_id: string;
  attempt_id: string;
  fencing: string;
  expired: boolean;
  revoked: boolean;
  revoked_reason: string | null;
}

/** The stored token bound to this run id, or null (unknown token, or a token issued for another run). */
export async function findRunToken(db: Queryable, orgId: string, runId: string, token: string): Promise<TokenRow | null> {
  const { rows } = await db.query<TokenRow>(
    `select id, run_id, attempt_id, fencing::text as fencing, expires_at <= now() as expired, revoked_at is not null as revoked, revoked_reason
       from run_tokens where org_id = $1 and token_hash = $2 and run_id = $3`,
    [orgId, hashRunToken(token), runId],
  );
  return rows[0] ?? null;
}
