import { appendEvent, type EventCategory, type EventInput, type Queryable, type Tx } from "@gantry/db";

export interface AlertInput {
  orgId: string;
  type: string;
  category: EventCategory;
  subject?: { type: string; id: string } | null;
  projectId?: string | null;
  woId?: string | null;
  after?: unknown;
  /** One alert per key: raising it again is a no-op (a sweep that runs every minute must not flood the ledger). */
  key?: string;
  outcome?: "failed" | "regression" | "ok";
}

/** A system event for something a person should look at (spec 4.4 step 4, 7.2). Returns false when the key already raised it. */
export async function raiseAlert(tx: Tx, a: AlertInput): Promise<boolean> {
  if (a.key) {
    const dup = await (tx as Queryable).query(`select 1 from events where org_id = $1 and idempotency_key = $2 limit 1`, [a.orgId, a.key]);
    if (dup.rowCount) return false;
  }
  const e: EventInput = {
    orgId: a.orgId, type: a.type, category: a.category, actor: "system", channel: "system", outcome: a.outcome ?? "failed",
    subject: a.subject ?? null, projectId: a.projectId ?? null, woId: a.woId ?? null, after: a.after ?? null, idempotencyKey: a.key ?? null,
  };
  await appendEvent(tx, e);
  return true;
}

/** An ordinary system event written by the worker (outcome ok unless stated). */
export async function recordEvent(tx: Tx, e: Omit<EventInput, "actor" | "channel"> & { actor?: string }): Promise<void> {
  if (e.idempotencyKey) {
    const dup = await (tx as Queryable).query(`select 1 from events where org_id = $1 and idempotency_key = $2 limit 1`, [e.orgId, e.idempotencyKey]);
    if (dup.rowCount) return;
  }
  await appendEvent(tx, { ...e, actor: e.actor ?? "system", channel: "system" });
}
