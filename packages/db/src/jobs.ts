import type { Queryable } from "./tx.js";

export interface JobInput {
  orgId: string;
  kind: string;
  payload?: unknown;
  queue?: string;
  /** Higher runs first. */
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  /** While a job with this key is queued or running, enqueuing the same key returns that job. */
  dedupeKey?: string;
}

export interface Job {
  id: string;
  orgId: string;
  queue: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  leaseUntil: Date;
  leaseOwner: string;
}

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}
export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 2_000, maxMs: 15 * 60_000 };

interface JobRow {
  id: string;
  org_id: string;
  queue: string;
  kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  lease_until: Date;
  lease_owner: string;
}

const toJob = (r: JobRow): Job => ({
  id: r.id, orgId: r.org_id, queue: r.queue, kind: r.kind, payload: r.payload, attempts: r.attempts,
  maxAttempts: r.max_attempts, leaseUntil: r.lease_until, leaseOwner: r.lease_owner,
});

/** Use the caller's transaction to enqueue atomically with the state change that caused the job. */
export async function enqueue(db: Queryable, j: JobInput): Promise<{ id: string; deduped: boolean }> {
  const ins = await db.query<{ id: string }>(
    `insert into jobs (org_id, queue, kind, payload, priority, run_at, max_attempts, dedupe_key)
     values ($1, $2, $3, $4::jsonb, $5, coalesce($6::timestamptz, now()), $7, $8)
     on conflict (org_id, dedupe_key) where dedupe_key is not null and status in ('queued','running') do nothing
     returning id`,
    [j.orgId, j.queue ?? "default", j.kind, JSON.stringify(j.payload ?? {}), j.priority ?? 0, j.runAt ?? null, j.maxAttempts ?? 5, j.dedupeKey ?? null],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, deduped: false };
  const existing = await db.query<{ id: string }>(
    `select id from jobs where org_id = $1 and dedupe_key = $2 and status in ('queued','running') limit 1`,
    [j.orgId, j.dedupeKey],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, deduped: true };
  // The conflicting job finished between the insert and the lookup: it is no longer a duplicate.
  return enqueue(db, j);
}

export interface ClaimOptions {
  workerId: string;
  leaseMs: number;
  queues?: string[];
  limit?: number;
}

/**
 * Claims due jobs with SELECT ... FOR UPDATE SKIP LOCKED, so concurrent workers never get the same job.
 * A running job whose lease expired is claimable again; one that has used all attempts is marked dead instead.
 */
export async function claim(db: Queryable, o: ClaimOptions): Promise<Job[]> {
  await db.query(
    `update jobs set status = 'dead', lease_owner = null, lease_until = null, last_error = coalesce(last_error, 'lease expired'), completed_at = now()
     where status = 'running' and lease_until < now() and attempts >= max_attempts`,
  );
  const { rows } = await db.query<JobRow>(
    `with picked as (
       select id from jobs
       where ((status = 'queued' and run_at <= now()) or (status = 'running' and lease_until < now() and attempts < max_attempts))
         and ($4::text[] is null or queue = any($4))
       order by priority desc, run_at, created_at
       for update skip locked
       limit $3
     )
     update jobs j set status = 'running', lease_owner = $1, lease_until = now() + ($2::float8 * interval '1 millisecond'),
       attempts = j.attempts + 1, started_at = now()
     from picked where j.id = picked.id
     returning j.id, j.org_id, j.queue, j.kind, j.payload, j.attempts, j.max_attempts, j.lease_until, j.lease_owner`,
    [o.workerId, o.leaseMs, o.limit ?? 1, o.queues ?? null],
  );
  return rows.map(toJob);
}

/** Extends the lease. False when the lease was lost (expired and reclaimed), in which case the worker must stop. */
export async function heartbeat(db: Queryable, id: string, workerId: string, leaseMs: number): Promise<boolean> {
  const r = await db.query(
    `update jobs set lease_until = now() + ($3::float8 * interval '1 millisecond') where id = $1 and lease_owner = $2 and status = 'running'`,
    [id, workerId, leaseMs],
  );
  return r.rowCount === 1;
}

/** False when this worker no longer holds the lease; the result is then not recorded. */
export async function complete(db: Queryable, id: string, workerId: string, result?: unknown): Promise<boolean> {
  const r = await db.query(
    `update jobs set status = 'done', lease_owner = null, lease_until = null, result = $3::jsonb, completed_at = now()
     where id = $1 and lease_owner = $2 and status = 'running'`,
    [id, workerId, result === undefined ? null : JSON.stringify(result)],
  );
  return r.rowCount === 1;
}

export type FailOutcome = { status: "queued"; runAt: Date } | { status: "dead" } | { status: "lost" };

/** Retries with capped exponential backoff and jitter (0.5x..1x), or marks the job dead when attempts are used up or `retry` is false. */
export async function fail(
  db: Queryable,
  id: string,
  workerId: string,
  error: string,
  opts: { retry?: boolean; backoff?: BackoffPolicy } = {},
): Promise<FailOutcome> {
  const b = opts.backoff ?? DEFAULT_BACKOFF;
  const { rows } = await db.query<{ status: "queued" | "dead"; run_at: Date }>(
    `update jobs set
       status = case when $3::boolean and attempts < max_attempts then 'queued' else 'dead' end,
       run_at = case when $3::boolean and attempts < max_attempts
         then now() + (least($4::float8 * power(2, attempts - 1), $5::float8) * (0.5 + random() * 0.5)) * interval '1 millisecond' else run_at end,
       lease_owner = null, lease_until = null, last_error = $6,
       completed_at = case when $3::boolean and attempts < max_attempts then null else now() end
     where id = $1 and lease_owner = $2 and status = 'running'
     returning status, run_at`,
    [id, workerId, opts.retry ?? true, b.baseMs, b.maxMs, error.slice(0, 4000)],
  );
  const r = rows[0];
  if (!r) return { status: "lost" };
  return r.status === "queued" ? { status: "queued", runAt: r.run_at } : { status: "dead" };
}
