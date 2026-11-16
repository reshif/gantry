/**
 * The workspace inbox (agent workspace, Phase 4): every conversation a person can read, in one list. A work order's primary thread
 * (`wo:<id>`), a repository's onboarding thread (`repo:<id>`), and chats (`ct-...`): the person's Console chats, side threads about a
 * work order, repository or project with a chosen agent, and chats others shared with them. Nothing here writes; the person's own pins and
 * archive marks are read from thread_prefs.
 */
import { visibleProjects, type PolicyState } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import type { FastifyRequest } from "fastify";
import { decide } from "../../core/index.js";
import { THREAD_COLS, thread, type ThreadDbRow, type ScopeKind } from "../console/threads.js";
import { woSessionRows, type WoSessionRow } from "../../routes/workorder-session.js";
import { chatThreadSpend } from "./spend.js";

/** A closed work order's primary thread is archived for everyone this long after it closed. */
export const AUTO_ARCHIVE_DAYS = 14;

export type ThreadKind = "primary" | "onboarding" | "chat" | "side";
export interface InboxItem {
  key: string;
  kind: ThreadKind;
  scope: { kind: ScopeKind; id: string | null; label: string };
  project: string | null;
  title: string;
  agent: string | null;
  agentName: string | null;
  /** Who the thread waits on, from the person's point of view. */
  waitingOn: "you" | "approver" | "agent" | "person" | "nobody";
  unread: boolean;
  latest: { text: string; at: number; by: string; role: string } | null;
  updatedAt: number;
  /** Archived for this person: `auto` (closed work order), `thread` (the chat's owner archived it), `me` (filed away by this person). */
  archived: "auto" | "thread" | "me" | null;
  pinned: boolean;
  /** The person owns the chat, was invited, or takes part in the work order (requested it). */
  mine: boolean;
  /** Visible to more than its owner: a project thread, or a chat shared with the project or with invited people. */
  shared: boolean;
  owner: string | null;
  visibility: "private" | "project" | null;
  /** What the chat's answers cost; null for work-order and onboarding threads (their spend is the work order's budget, in the operator view). */
  spendUsd: number | null;
  wo?: { cls: string; station: string; stationName: string; state: string; bay: string | null; gate: string | null; closed: boolean };
}

const clip = (s: string, n = 240): string => (s.length > n ? `${s.slice(0, n)}…` : s);

async function prefsOf(db: Queryable, orgId: string, me: string): Promise<Map<string, { pinned: boolean; archived: boolean }>> {
  const { rows } = await db.query<{ thread_key: string; pinned: boolean; archived: boolean }>(`select thread_key, pinned, archived from thread_prefs where org_id = $1 and person_id = $2`, [orgId, me]);
  return new Map(rows.map((r) => [r.thread_key, { pinned: r.pinned, archived: r.archived }]));
}

function primaryItem(w: WoSessionRow, me: string, pref: { pinned: boolean; archived: boolean } | undefined, now: number, approves: Set<string>): InboxItem {
  const auto = w.closed && w.closedAt !== null && now - w.closedAt > AUTO_ARCHIVE_DAYS * 86_400_000;
  return {
    key: `wo:${w.id}`, kind: "primary", scope: { kind: "work_order", id: w.id, label: w.id }, project: w.project, title: w.title, agent: w.agent, agentName: w.agentName,
    // An open gate waits on this person when they may approve gates on the project (the gate's own rules, such as "not the author", still apply).
    waitingOn: w.waitingOn === "approver" && approves.has(w.project) ? "you" : w.waitingOn, unread: w.unread, latest: w.latest ? { ...w.latest, text: clip(w.latest.text) } : null, updatedAt: w.latest?.at ?? w.createdAt,
    archived: pref?.archived ? "me" : auto ? "auto" : null, pinned: !!pref?.pinned, mine: w.requestedBy === me, shared: true, owner: null, visibility: "project", spendUsd: null,
    wo: { cls: w.cls, station: w.station, stationName: w.stationName, state: w.state, bay: w.bay, gate: w.gate, closed: w.closed },
  };
}

async function onboardingItems(db: Queryable, orgId: string, req: FastifyRequest, st: PolicyState, me: string, prefs: Map<string, { pinned: boolean; archived: boolean }>): Promise<InboxItem[]> {
  const projects = visibleProjects(st, me).map((p) => p.id);
  if (!projects.length) return [];
  const { rows } = await db.query<{ repo_id: string; name: string; project_id: string; role: string; author: string; body: string; data: { cards?: Array<{ kind: string; status?: string }> }; created_at: Date; seen_at: Date | null }>(
    `select distinct on (m.repo_id) m.repo_id, r.name, r.project_id, m.role, m.author, m.body, m.data, m.created_at, s.seen_at
       from onboarding_messages m join repos r on r.org_id = m.org_id and r.id = m.repo_id
       left join onboarding_session_seen s on s.org_id = m.org_id and s.repo_id = m.repo_id and s.person_id = $3
      where m.org_id = $1 and r.project_id = any($2) order by m.repo_id, m.created_at desc, m.id desc`,
    [orgId, projects, me],
  );
  const out: InboxItem[] = [];
  for (const r of rows) {
    const pending = r.role === "assistant" && (r.data.cards ?? []).some((c) => (c.kind === "proposal" && c.status === "pending") || c.kind === "question");
    const can = pending ? (await decide(req, "onboarding.manage", { project: r.project_id, repo: r.repo_id })).allowed : false;
    const key = `repo:${r.repo_id}`;
    const pref = prefs.get(key);
    out.push({
      key, kind: "onboarding", scope: { kind: "repo", id: r.repo_id, label: r.name }, project: r.project_id, title: `Onboarding ${r.name}`, agent: "ag-onboard", agentName: "Onboarding agent",
      waitingOn: pending ? (can ? "you" : "person") : r.role === "user" ? "agent" : "nobody", unread: r.role !== "user" && r.created_at.getTime() > (r.seen_at?.getTime() ?? 0),
      latest: { text: clip(r.body), at: r.created_at.getTime(), by: r.author, role: r.role }, updatedAt: r.created_at.getTime(),
      archived: pref?.archived ? "me" : null, pinned: !!pref?.pinned, mine: false, shared: true, owner: null, visibility: "project", spendUsd: null,
    });
  }
  return out;
}

async function chatItems(db: Queryable, orgId: string, st: PolicyState, me: string, prefs: Map<string, { pinned: boolean; archived: boolean }>, now: Date): Promise<InboxItem[]> {
  const projects = visibleProjects(st, me).map((p) => p.id);
  const { rows } = await db.query<ThreadDbRow & { member: boolean; l_role: string | null; l_body: string | null; l_at: Date | null; l_author: string | null; n_members: string }>(
    `select ${THREAD_COLS}, exists (select 1 from thread_members tm where tm.org_id = t.org_id and tm.thread_id = t.id and tm.person_id = $2) as member,
            (select count(*) from thread_members tm where tm.org_id = t.org_id and tm.thread_id = t.id)::text as n_members,
            l.role as l_role, l.body as l_body, l.created_at as l_at, l.author as l_author
       from console_threads t
       left join lateral (select role, body, created_at, author from console_messages m where m.org_id = t.org_id and m.thread_id = t.id order by created_at desc, id desc limit 1) l on true
      where t.org_id = $1 and t.expires_at > $4
        and (t.project_id is null or t.project_id = any($3))
        and (t.person_id = $2 or exists (select 1 from thread_members tm where tm.org_id = t.org_id and tm.thread_id = t.id and tm.person_id = $2) or (t.visibility = 'project' and t.project_id is not null))
      order by coalesce(l.created_at, t.updated_at) desc limit 300`,
    [orgId, me, projects, now],
  );
  const spend = await chatThreadSpend(db, orgId, rows.map((r) => r.id));
  const agents = new Map((await db.query<{ id: string; name: string }>(`select id, name from agents where org_id = $1`, [orgId])).rows.map((a) => [a.id, a.name]));
  const woTitles = new Map<string, string>();
  const woIds = rows.filter((r) => r.scope_kind === "work_order" && r.scope_id).map((r) => r.scope_id!);
  if (woIds.length) for (const w of (await db.query<{ id: string; title: string }>(`select id, title from work_orders where org_id = $1 and id = any($2)`, [orgId, woIds])).rows) woTitles.set(w.id, w.title);
  const repoNames = new Map<string, string>();
  const repoIds = rows.filter((r) => r.scope_kind === "repo" && r.scope_id).map((r) => r.scope_id!);
  if (repoIds.length) for (const r of (await db.query<{ id: string; name: string }>(`select id, name from repos where org_id = $1 and id = any($2)`, [orgId, repoIds])).rows) repoNames.set(r.id, r.name);
  return rows.map((r) => {
    const t = thread(r);
    const side = t.scope.kind !== "factory" || !!t.agentId;
    const pref = prefs.get(t.id);
    const label = t.scope.kind === "work_order" ? `${t.scope.id}` : t.scope.kind === "repo" ? (repoNames.get(t.scope.id!) ?? t.scope.id!) : t.scope.kind === "project" ? (st.projects.find((p) => p.id === t.scope.id)?.name ?? t.scope.id!) : "Factory";
    const owner = t.owner === me;
    return {
      key: t.id, kind: side ? "side" : "chat", scope: { kind: t.scope.kind, id: t.scope.id, label }, project: t.projectId,
      title: t.title || (t.scope.kind === "work_order" ? `About ${t.scope.id}: ${woTitles.get(t.scope.id!) ?? ""}` : "Chat"),
      agent: t.agentId, agentName: t.agentId ? (agents.get(t.agentId) ?? t.agentId) : side ? "Gantry assistant" : "Console",
      waitingOn: r.l_role === "user" ? "agent" : "nobody", unread: false,
      latest: r.l_at ? { text: clip(r.l_body ?? ""), at: r.l_at.getTime(), by: r.l_author ?? (r.l_role === "user" ? t.owner : "gantry"), role: r.l_role ?? "assistant" } : null,
      updatedAt: r.l_at?.getTime() ?? t.updatedAt,
      archived: t.status === "archived" ? "thread" : pref?.archived ? "me" : null, pinned: !!pref?.pinned, mine: owner || r.member,
      shared: t.visibility === "project" || Number(r.n_members) > 0, owner: t.owner, visibility: t.visibility, spendUsd: (spend.get(t.id) ?? 0) / 1e6,
    };
  });
}

/** Every conversation the person can read. `all` also lists work orders closed long ago (the Archived view asks for them). */
export async function inbox(db: Queryable, orgId: string, req: FastifyRequest, st: PolicyState, me: string, o: { all?: boolean } = {}): Promise<InboxItem[]> {
  const now = new Date();
  const prefs = await prefsOf(db, orgId, me);
  const [wos, onb, chats] = await Promise.all([woSessionRows(db, orgId, req, { id: me }, null, o), onboardingItems(db, orgId, req, st, me, prefs), chatItems(db, orgId, st, me, prefs, now)]);
  const approves = new Set<string>();
  for (const p of new Set(wos.filter((w) => w.waitingOn === "approver").map((w) => w.project))) if ((await decide(req, "gate.approve", { project: p })).allowed) approves.add(p);
  const items = [...wos.map((w) => primaryItem(w, me, prefs.get(`wo:${w.id}`), now.getTime(), approves)), ...onb, ...chats];
  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}
