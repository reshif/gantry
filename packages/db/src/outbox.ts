import { DEFAULT_BACKOFF, type BackoffPolicy } from "./jobs.js";
import type { Queryable } from "./tx.js";

export interface OutboxInput {
  orgId: string;
  eventId: string;
  destination: string;
  payload?: unknown;
  maxAttempts?: number;
}

export interface OutboxItem {
  id: string;
  orgId: string;
  eventId: string;
  destination: string;
  payload: unknown;
  attempts: number;
}

/** One delivery per (event, destination): repeating the call returns the existing row. Call in the event's transaction. */
export async function enqueueOutbox(db: Queryable, o: OutboxInput): Promise<{ id: string; created: boolean }> {
  const ins = await db.query<{ id: string }>(
    `insert into outbox (org_id, event_id, destination, payload, max_attempts) values ($1, $2, $3, $4::jsonb, $5)
     on conflict (event_id, destination) do nothing returning id`,
    [o.orgId, o.eventId, o.destination, JSON.stringify(o.payload ?? {}), o.maxAttempts ?? 8],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const { rows } = await db.query<{ id: string }>(`select id from outbox where event_id = $1 and destination = $2`, [o.eventId, o.destination]);
  return { id: rows[0]!.id, created: false };
}

interface OutboxRow {
  id: string; org_id: string; event_id: string; destination: string; payload: unknown; attempts: number;
}

export async function claimOutbox(
  db: Queryable,
  o: { workerId: string; leaseMs: number; destinations?: string[]; limit?: number },
): Promise<OutboxItem[]> {
  await db.query(
    `update outbox set status = 'dead', lease_owner = null, lease_until = null, last_error = coalesce(last_error, 'lease expired')
     where status = 'sending' and lease_until < now() and attempts >= max_attempts`,
  );
  const { rows } = await db.query<OutboxRow>(
    `with picked as (
       select id from outbox
       where ((status = 'pending' and next_attempt_at <= now()) or (status = 'sending' and lease_until < now() and attempts < max_attempts))
         and ($4::text[] is null or destination = any($4))
       order by next_attempt_at
       for update skip locked
       limit $3
     )
     update outbox x set status = 'sending', lease_owner = $1, lease_until = now() + ($2::float8 * interval '1 millisecond'), attempts = x.attempts + 1
     from picked where x.id = picked.id
     returning x.id, x.org_id, x.event_id, x.destination, x.payload, x.attempts`,
    [o.workerId, o.leaseMs, o.limit ?? 10, o.destinations ?? null],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, eventId: r.event_id, destination: r.destination, payload: r.payload, attempts: r.attempts }));
}

export async function markDelivered(db: Queryable, id: string, workerId: string): Promise<boolean> {
  const r = await db.query(
    `update outbox set status = 'delivered', delivered_at = now(), lease_owner = null, lease_until = null
     where id = $1 and lease_owner = $2 and status = 'sending'`,
    [id, workerId],
  );
  return r.rowCount === 1;
}

/** Back to pending with backoff, or dead once attempts are used up. */
export async function markFailed(
  db: Queryable,
  id: string,
  workerId: string,
  error: string,
  backoff: BackoffPolicy = DEFAULT_BACKOFF,
): Promise<"pending" | "dead" | "lost"> {
  const { rows } = await db.query<{ status: "pending" | "dead" }>(
    `update outbox set
       status = case when attempts < max_attempts then 'pending' else 'dead' end,
       next_attempt_at = case when attempts < max_attempts
         then now() + (least($3::float8 * power(2, attempts - 1), $4::float8) * (0.5 + random() * 0.5)) * interval '1 millisecond' else next_attempt_at end,
       lease_owner = null, lease_until = null, last_error = $5
     where id = $1 and lease_owner = $2 and status = 'sending'
     returning status`,
    [id, workerId, backoff.baseMs, backoff.maxMs, error.slice(0, 4000)],
  );
  return rows[0]?.status ?? "lost";
}
