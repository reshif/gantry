/** Console threads and messages (spec 7.3, 7.4): per person, 90 days of retention counted from the last message. */
import { randomUUID } from "node:crypto";
import type { Queryable, Tx } from "@gantry/db";

export interface ThreadRow { id: string; title: string; pinned: string[]; createdAt: number; updatedAt: number; expiresAt: number; retentionDays: number; count?: number }
export interface MessageRow { id: string; threadId: string; role: "user" | "assistant" | "system"; text: string; at: number; data: Record<string, unknown> }

const newId = (p: string): string => `${p}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const newThreadId = (): string => newId("ct");
export const newMessageId = (): string => newId("cm");

const thread = (r: { id: string; title: string; pinned: unknown; created_at: Date; updated_at: Date; expires_at: Date; retention_days: number; n?: string }): ThreadRow => ({
  id: r.id, title: r.title, pinned: Array.isArray(r.pinned) ? r.pinned.filter((x): x is string => typeof x === "string") : [], createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(),
  expiresAt: r.expires_at.getTime(), retentionDays: r.retention_days, ...(r.n !== undefined ? { count: Number(r.n) } : {}),
});
const message = (r: { id: string; thread_id: string; role: "user" | "assistant" | "system"; body: string; data: unknown; created_at: Date }): MessageRow => ({
  id: r.id, threadId: r.thread_id, role: r.role, text: r.body, at: r.created_at.getTime(), data: (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>,
});

/** Deletes the threads whose retention has run out (messages follow by cascade). Run opportunistically on reads and by any janitor. */
export async function purgeExpired(db: Queryable, orgId: string, now = new Date()): Promise<number> {
  const r = await db.query(`delete from console_threads where org_id = $1 and expires_at <= $2`, [orgId, now]);
  return r.rowCount ?? 0;
}

export async function listThreads(db: Queryable, orgId: string, person: string, now = new Date()): Promise<ThreadRow[]> {
  const { rows } = await db.query(
    `select t.id, t.title, t.pinned, t.created_at, t.updated_at, t.expires_at, t.retention_days, (select count(*) from console_messages m where m.org_id = t.org_id and m.thread_id = t.id)::text as n
       from console_threads t where t.org_id = $1 and t.person_id = $2 and t.expires_at > $3 order by t.updated_at desc limit 100`,
    [orgId, person, now],
  );
  return rows.map(thread);
}

/** A thread of this person only (another person's thread reads as missing). */
export async function getThread(db: Queryable, orgId: string, person: string, id: string, now = new Date()): Promise<(ThreadRow & { messages: MessageRow[] }) | null> {
  const t = (await db.query(`select id, title, pinned, created_at, updated_at, expires_at, retention_days from console_threads where org_id = $1 and person_id = $2 and id = $3 and expires_at > $4`, [orgId, person, id, now])).rows[0];
  if (!t) return null;
  const { rows } = await db.query(`select id, thread_id, role, body, data, created_at from console_messages where org_id = $1 and thread_id = $2 order by created_at, id`, [orgId, id]);
  return { ...thread(t), messages: rows.map(message) };
}

export async function ensureThread(tx: Tx, orgId: string, person: string, id: string | null, title: string, now: Date): Promise<{ id: string; created: boolean } | null> {
  if (id) {
    const r = await tx.query(`select 1 from console_threads where org_id = $1 and person_id = $2 and id = $3 and expires_at > $4 for update`, [orgId, person, id, now]);
    return r.rowCount ? { id, created: false } : null;
  }
  const tid = newThreadId();
  await tx.query(`insert into console_threads (org_id, id, person_id, title, created_at, updated_at, expires_at) values ($1,$2,$3,$4,$5,$5, $5::timestamptz + interval '90 days')`, [orgId, tid, person, title.slice(0, 120), now]);
  return { id: tid, created: true };
}

export async function addMessage(tx: Tx, orgId: string, threadId: string, role: MessageRow["role"], text: string, data: Record<string, unknown>, now: Date, id = newMessageId()): Promise<string> {
  await tx.query(`insert into console_messages (org_id, id, thread_id, role, body, data, created_at, updated_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)`, [orgId, id, threadId, role, text, JSON.stringify(data), now]);
  await tx.query(`update console_threads set updated_at = $3, expires_at = $3::timestamptz + make_interval(days => retention_days) where org_id = $1 and id = $2`, [orgId, threadId, now]);
  return id;
}

export async function deleteThread(tx: Tx, orgId: string, person: string, id: string): Promise<boolean> {
  const r = await tx.query(`delete from console_threads where org_id = $1 and person_id = $2 and id = $3`, [orgId, person, id]);
  return (r.rowCount ?? 0) > 0;
}

/** Rename one of the person's own threads. */
export async function renameThread(tx: Tx, orgId: string, person: string, id: string, title: string): Promise<boolean> {
  const r = await tx.query(`update console_threads set title = $4, updated_at = clock_timestamp() where org_id = $1 and person_id = $2 and id = $3`, [orgId, person, id, title.slice(0, 120)]);
  return (r.rowCount ?? 0) > 0;
}

export async function setPinned(tx: Tx, orgId: string, person: string, id: string, pinned: string[]): Promise<boolean> {
  const r = await tx.query(`update console_threads set pinned = $4::jsonb, updated_at = clock_timestamp() where org_id = $1 and person_id = $2 and id = $3`, [orgId, person, id, JSON.stringify(pinned)]);
  return (r.rowCount ?? 0) > 0;
}

/** Records how a confirm card ended (done, failed, dismissed) on the assistant message that carried it. The thread must be the person's. */
export async function setProposalStatus(tx: Tx, orgId: string, person: string, messageId: string, proposalId: string, status: "done" | "failed" | "dismissed", result: string): Promise<boolean> {
  const r = await tx.query<{ data: { proposals?: Array<Record<string, unknown>> } }>(
    `select m.data from console_messages m join console_threads t on t.org_id = m.org_id and t.id = m.thread_id where m.org_id = $1 and m.id = $2 and t.person_id = $3 and m.role = 'assistant' for update of m`,
    [orgId, messageId, person],
  );
  const row = r.rows[0];
  if (!row) return false;
  const proposals = row.data.proposals ?? [];
  const p = proposals.find((x) => x.id === proposalId);
  if (!p) return false;
  p.status = status;
  p.result = result.slice(0, 500);
  await tx.query(`update console_messages set data = $3::jsonb, updated_at = clock_timestamp() where org_id = $1 and id = $2`, [orgId, messageId, JSON.stringify({ ...row.data, proposals })]);
  return true;
}
