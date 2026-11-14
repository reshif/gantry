import { enqueue } from "./jobs.js";
import type { Queryable, Tx } from "./tx.js";

export interface TimerInput {
  orgId: string;
  kind: string;
  fireAt: Date;
  subject?: string;
  payload?: unknown;
  /** One pending timer per key; scheduling the same key again returns the existing timer. */
  dedupeKey?: string;
}

export async function schedule(db: Queryable, t: TimerInput): Promise<{ id: string; created: boolean }> {
  const ins = await db.query<{ id: string }>(
    `insert into timers (org_id, kind, subject, fire_at, payload, dedupe_key) values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (org_id, dedupe_key) where dedupe_key is not null and status = 'pending' do nothing returning id`,
    [t.orgId, t.kind, t.subject ?? null, t.fireAt, JSON.stringify(t.payload ?? {}), t.dedupeKey ?? null],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const { rows } = await db.query<{ id: string }>(
    `select id from timers where org_id = $1 and dedupe_key = $2 and status = 'pending'`,
    [t.orgId, t.dedupeKey],
  );
  if (rows[0]) return { id: rows[0].id, created: false };
  return schedule(db, t); // fired or cancelled in between
}

export type TimerSelector = { id: string } | { orgId: string; dedupeKey: string } | { orgId: string; subject: string; kind?: string };

/** Cancels pending timers matching the selector; returns how many were cancelled. */
export async function cancel(db: Queryable, s: TimerSelector): Promise<number> {
  const r =
    "id" in s
      ? await db.query(`update timers set status = 'cancelled' where id = $1 and status = 'pending'`, [s.id])
      : "dedupeKey" in s
        ? await db.query(`update timers set status = 'cancelled' where org_id = $1 and dedupe_key = $2 and status = 'pending'`, [s.orgId, s.dedupeKey])
        : await db.query(
            `update timers set status = 'cancelled' where org_id = $1 and subject = $2 and ($3::text is null or kind = $3) and status = 'pending'`,
            [s.orgId, s.subject, s.kind ?? null],
          );
  return r.rowCount ?? 0;
}

/**
 * Turns due timers into jobs (queue `timers`, job kind = timer kind) in one transaction, so a timer fires exactly once
 * even with several workers (FOR UPDATE SKIP LOCKED). Returns the number fired.
 */
export async function fireDue(tx: Tx, limit = 100): Promise<number> {
  const { rows } = await tx.query<{ id: string; org_id: string; kind: string; subject: string | null; payload: unknown }>(
    `select id, org_id, kind, subject, payload from timers where status = 'pending' and fire_at <= now()
     order by fire_at for update skip locked limit $1`,
    [limit],
  );
  for (const t of rows) {
    const job = await enqueue(tx, { orgId: t.org_id, queue: "timers", kind: t.kind, payload: { timerId: t.id, subject: t.subject, ...(t.payload as object) } });
    await tx.query(`update timers set status = 'fired', fired_at = now(), job_id = $2 where id = $1`, [t.id, job.id]);
  }
  return rows.length;
}

/** When the next pending timer is due, so a worker can sleep exactly that long. Null when none. */
export async function nextFireAt(db: Queryable): Promise<Date | null> {
  const { rows } = await db.query<{ fire_at: Date | null }>(`select min(fire_at) as fire_at from timers where status = 'pending'`);
  return rows[0]?.fire_at ?? null;
}
