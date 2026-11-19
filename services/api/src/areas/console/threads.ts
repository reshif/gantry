/** Console threads and messages (spec 7.3, 7.4): per person, 90 days of retention counted from the last message. */
import { randomUUID } from "node:crypto";
import type { Queryable, Tx } from "@gantry/db";

export type ScopeKind = "factory" | "project" | "work_order" | "repo";
export interface ThreadRow {
  id: string; title: string; pinned: string[]; createdAt: number; updatedAt: number; expiresAt: number; retentionDays: number; count?: number;
  owner: string; scope: { kind: ScopeKind; id: string | null }; projectId: string | null; agentId: string | null; visibility: "private" | "project"; status: "active" | "archived"; archivedAt: number | null; archivedBy: string | null;
}
export interface MessageRow { id: string; threadId: string; role: "user" | "assistant" | "system"; text: string; at: number; data: Record<string, unknown>; author: string | null }

const newId = (p: string): string => `${p}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const newThreadId = (): string => newId("ct");
export const newMessageId = (): string => newId("cm");

/** The columns every thread read selects. */
export const THREAD_COLS = `t.id, t.title, t.pinned, t.created_at, t.updated_at, t.expires_at, t.retention_days, t.person_id, t.scope_kind, t.scope_id, t.project_id, t.agent_id, t.visibility, t.status, t.archived_at, t.archived_by`;
export interface ThreadDbRow {
  id: string; title: string; pinned: unknown; created_at: Date; updated_at: Date; expires_at: Date; retention_days: number; n?: string;
  person_id: string; scope_kind: ScopeKind; scope_id: string | null; project_id: string | null; agent_id: string | null; visibility: "private" | "project"; status: "active" | "archived"; archived_at: Date | null; archived_by: string | null;
}
export const thread = (r: ThreadDbRow): ThreadRow => ({
  id: r.id, title: r.title, pinned: Array.isArray(r.pinned) ? r.pinned.filter((x): x is string => typeof x === "string") : [], createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(),
  expiresAt: r.expires_at.getTime(), retentionDays: r.retention_days, ...(r.n !== undefined ? { count: Number(r.n) } : {}),
  owner: r.person_id, scope: { kind: r.scope_kind, id: r.scope_id }, projectId: r.project_id, agentId: r.agent_id, visibility: r.visibility, status: r.status,
  archivedAt: r.archived_at?.getTime() ?? null, archivedBy: r.archived_by,
});
const message = (r: { id: string; thread_id: string; role: "user" | "assistant" | "system"; body: string; data: unknown; created_at: Date; author: string | null }): MessageRow => ({
  id: r.id, threadId: r.thread_id, role: r.role, text: r.body, at: r.created_at.getTime(), data: (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>, author: r.author,
});

/** Deletes the threads whose retention has run out (messages follow by cascade). Run opportunistically on reads and by any janitor. */
export async function purgeExpired(db: Queryable, orgId: string, now = new Date()): Promise<number> {
  const r = await db.query(`delete from console_threads where org_id = $1 and expires_at <= $2`, [orgId, now]);
  return r.rowCount ?? 0;
}

/** The person's own factory-scope chats (the Console's chat list); side threads and shared chats are listed by the workspace inbox. */
export async function listThreads(db: Queryable, orgId: string, person: string, now = new Date()): Promise<ThreadRow[]> {
  const { rows } = await db.query<ThreadDbRow>(
    `select ${THREAD_COLS}, (select count(*) from console_messages m where m.org_id = t.org_id and m.thread_id = t.id)::text as n
       from console_threads t where t.org_id = $1 and t.person_id = $2 and t.expires_at > $3 and t.scope_kind = 'factory' order by t.updated_at desc limit 100`,
    [orgId, person, now],
  );
  return rows.map(thread);
}

/** One chat with its people (no access check: the caller decides with chatAccess). */
export async function readChat(db: Queryable, orgId: string, id: string, now = new Date()): Promise<(ThreadRow & { members: string[] }) | null> {
  const t = (await db.query<ThreadDbRow>(`select ${THREAD_COLS} from console_threads t where t.org_id = $1 and t.id = $2 and t.expires_at > $3`, [orgId, id, now])).rows[0];
  if (!t) return null;
  const { rows } = await db.query<{ person_id: string }>(`select person_id from thread_members where org_id = $1 and thread_id = $2 order by added_at`, [orgId, id]);
  return { ...thread(t), members: rows.map((r) => r.person_id) };
}

/**
 * Who a live change about one chat may reach, by the same rule as reading it (chatAccess): a private chat only its owner and members
 * (plus `also`, for example a person just removed, who must refetch), a chat shared with its project anyone who sees that project.
 * A chat that does not exist reaches only `also`.
 */
export async function chatReach(db: Queryable, orgId: string, id: string, also: string[] = []): Promise<{ project: string | null; audience?: string[] }> {
  const t = await readChat(db, orgId, id, new Date(0));
  if (!t) return { project: null, audience: [...also] };
  if (t.visibility === "project" && t.projectId) return { project: t.projectId };
  return { project: t.projectId, audience: [...new Set([t.owner, ...t.members, ...also])] };
}

/**
 * What a person may do with a chat. Reading needs the chat's project to be visible to them (sharing never widens what someone can see) and either
 * ownership, an invitation, or the chat shared with the project. Posting needs ownership or an invitation, and an active chat.
 */
export function chatAccess(t: { owner: string; members: string[]; projectId: string | null; visibility: "private" | "project"; status: "active" | "archived" }, me: string, seesProject: (p: string) => boolean): { read: boolean; post: boolean; owner: boolean; member: boolean } {
  const owner = t.owner === me;
  const member = t.members.includes(me);
  const inScope = t.projectId ? seesProject(t.projectId) : true;
  const read = inScope && (owner || member || (t.visibility === "project" && !!t.projectId));
  return { read, post: read && (owner || member) && t.status === "active", owner, member };
}

export async function listMessages(db: Queryable, orgId: string, id: string): Promise<MessageRow[]> {
  const { rows } = await db.query(`select id, thread_id, role, body, data, created_at, author from console_messages where org_id = $1 and thread_id = $2 order by created_at, id`, [orgId, id]);
  return rows.map(message as never);
}

/** A thread of this person only (another person's thread reads as missing). */
export async function getThread(db: Queryable, orgId: string, person: string, id: string, now = new Date()): Promise<(ThreadRow & { messages: MessageRow[] }) | null> {
  const t = (await db.query<ThreadDbRow>(`select ${THREAD_COLS} from console_threads t where t.org_id = $1 and t.person_id = $2 and t.id = $3 and t.expires_at > $4`, [orgId, person, id, now])).rows[0];
  if (!t) return null;
  return { ...thread(t), messages: await listMessages(db, orgId, id) };
}

/**
 * The chat a message goes to: an existing one the person may post in (the caller checked access and passes `allowed`), or a new factory-scope chat
 * of theirs.
 */
export async function ensureThread(tx: Tx, orgId: string, person: string, id: string | null, title: string, now: Date, allowed?: (t: ThreadRow & { members: string[] }) => boolean): Promise<{ id: string; created: boolean } | null> {
  if (id) {
    const r = await tx.query(`select 1 from console_threads where org_id = $1 and id = $2 and expires_at > $3 for update`, [orgId, id, now]);
    if (!r.rowCount) return null;
    const t = await readChat(tx, orgId, id, now);
    if (!t) return null;
    if (allowed ? !allowed(t) : t.owner !== person) return null;
    return { id, created: false };
  }
  const tid = newThreadId();
  await tx.query(`insert into console_threads (org_id, id, person_id, title, created_at, updated_at, expires_at) values ($1,$2,$3,$4,$5,$5, $5::timestamptz + interval '90 days')`, [orgId, tid, person, title.slice(0, 120), now]);
  return { id: tid, created: true };
}

/** A new chat about something (a work order, a repository, a project), optionally with a chosen agent. Nothing is said in it yet. */
export async function createScopedThread(tx: Tx, orgId: string, o: { person: string; title: string; scope: { kind: ScopeKind; id: string | null }; projectId: string | null; agentId: string | null; visibility: "private" | "project"; now: Date }): Promise<string> {
  const tid = newThreadId();
  await tx.query(
    `insert into console_threads (org_id, id, person_id, title, scope_kind, scope_id, project_id, agent_id, visibility, created_at, updated_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10, $10::timestamptz + interval '90 days')`,
    [orgId, tid, o.person, o.title.slice(0, 120), o.scope.kind, o.scope.id, o.projectId, o.agentId, o.visibility, o.now],
  );
  return tid;
}

export async function addMessage(tx: Tx, orgId: string, threadId: string, role: MessageRow["role"], text: string, data: Record<string, unknown>, now: Date, id = newMessageId(), author: string | null = null): Promise<string> {
  await tx.query(`insert into console_messages (org_id, id, thread_id, role, body, data, created_at, updated_at, author) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$7,$8)`, [orgId, id, threadId, role, text, JSON.stringify(data), now, author]);
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
    `select m.data from console_messages m join console_threads t on t.org_id = m.org_id and t.id = m.thread_id where m.org_id = $1 and m.id = $2 and m.role = 'assistant'
        and (t.person_id = $3 or exists (select 1 from thread_members tm where tm.org_id = t.org_id and tm.thread_id = t.id and tm.person_id = $3)) for update of m`,
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

/** The stored card of a message the person may act on (their own thread, or one shared with them), or null. */
export async function readProposal(db: Pick<Tx, "query">, orgId: string, person: string, messageId: string, proposalId: string): Promise<Record<string, unknown> | null> {
  const r = await db.query<{ data: { proposals?: Array<Record<string, unknown>> } }>(
    `select m.data from console_messages m join console_threads t on t.org_id = m.org_id and t.id = m.thread_id where m.org_id = $1 and m.id = $2 and m.role = 'assistant'
        and (t.person_id = $3 or exists (select 1 from thread_members tm where tm.org_id = t.org_id and tm.thread_id = t.id and tm.person_id = $3))`,
    [orgId, messageId, person],
  );
  return (r.rows[0]?.data.proposals ?? []).find((x) => x.id === proposalId) ?? null;
}

/** Writes what the server learned from running a card: its outcome, the result text, and what a refusal still needs. Never taken from the browser. */
export async function recordProposalOutcome(tx: Tx, orgId: string, person: string, messageId: string, proposalId: string, o: { status: "done" | "failed"; result: string; needs?: string; refusal?: { code: number; rule?: unknown; overrideKind?: string } }): Promise<boolean> {
  const ok = await setProposalStatus(tx, orgId, person, messageId, proposalId, o.status, o.result);
  if (!ok) return false;
  const row = (await tx.query<{ data: { proposals?: Array<Record<string, unknown>> } }>(`select data from console_messages where org_id = $1 and id = $2 for update`, [orgId, messageId])).rows[0]!;
  const p = (row.data.proposals ?? []).find((x) => x.id === proposalId)!;
  if (o.needs) p.needs = o.needs.slice(0, 300); else delete p.needs;
  if (o.refusal) p.refusal = o.refusal; else delete p.refusal;
  await tx.query(`update console_messages set data = $3::jsonb where org_id = $1 and id = $2`, [orgId, messageId, JSON.stringify(row.data)]);
  return true;
}
