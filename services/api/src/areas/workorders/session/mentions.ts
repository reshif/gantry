/**
 * @mentioning a person in a work order's session. A mention is a notification, never a grant: the person gets it in their inbox and on the project's routes for the
 * "mention" event; if they cannot read the project, nothing about the work order opens to them and an access request is put in front of the project's admins instead
 * (who decide in the people screen, with step-up like any role change). Whoever writes the mention must already be allowed to talk on the work order.
 */
import { randomUUID } from "node:crypto";
import { can } from "@gantry/domain";
import type { Queryable, Tx } from "@gantry/db";
import type { EventSpec, PolicyStateLoaded } from "../../../core/index.js";

/** Most people one message may mention. */
export const MAX_MENTIONS = 5;

export interface MentionCandidate { id: string; name: string; title: string; /** Whether the person can already read the project: when false, a mention asks the admins instead. */ access: boolean }

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Active people whose name starts a word with the typed text, for the composer's autocomplete. */
export async function searchMentionable(db: Queryable, orgId: string, st: PolicyStateLoaded, project: string, q: string, self: string, limit = 6): Promise<MentionCandidate[]> {
  const like = escapeLike(q.trim().toLowerCase());
  const { rows } = await db.query<{ id: string; name: string; title: string }>(
    `select id, name, title from people where org_id = $1 and status = 'active' and id <> $2 and (lower(name) like $3 || '%' or lower(name) like '% ' || $3 || '%') order by name limit $4`,
    [orgId, self, like, limit],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, title: r.title, access: can(st, r.id, "project.view", { project }).allowed }));
}

export interface MentionInput { woId: string; project: string; messageId: string; by: string; byName: string; text: string; ids: string[]; now: Date }
export interface Mentioned { id: string; name: string; access: boolean; requested: boolean }

/**
 * Records the mentions of one saved message and returns the audit events (`wo.mention`, which the notification producer turns into deliveries, and
 * `access.request` for a person without read access). Unknown, inactive and duplicate ids and the author themselves are skipped.
 */
export async function recordMentions(tx: Tx, orgId: string, st: PolicyStateLoaded, m: MentionInput): Promise<{ events: EventSpec[]; mentioned: Mentioned[] }> {
  const ids = [...new Set(m.ids)].filter((x) => x !== m.by).slice(0, MAX_MENTIONS);
  const events: EventSpec[] = [];
  const mentioned: Mentioned[] = [];
  if (!ids.length) return { events, mentioned };
  const { rows } = await tx.query<{ id: string; name: string }>(`select id, name from people where org_id = $1 and status = 'active' and id = any($2)`, [orgId, ids]);
  for (const p of rows) {
    const access = can(st, p.id, "project.view", { project: m.project }).allowed;
    const ins = await tx.query(
      `insert into workorder_mentions (org_id, id, wo_id, message_id, project_id, person_id, by_person, has_access, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (org_id, message_id, person_id) do nothing`,
      [orgId, `mn-${randomUUID().replace(/-/g, "").slice(0, 16)}`, m.woId, m.messageId, m.project, p.id, m.by, access, m.now],
    );
    if (!ins.rowCount) continue;
    // The snippet goes into the event only for someone who may read the project; a person without access gets a notice that names nothing.
    events.push({ type: "wo.mention", category: "flow", subject: { type: "person", id: p.id }, projectId: m.project, woId: m.woId, after: { person: p.id, personName: p.name, message: m.messageId, access, by: m.by, byName: m.byName, ...(access ? { text: m.text.slice(0, 200) } : {}) } });
    let requested = false;
    if (!access) {
      const r = await tx.query(
        `insert into access_requests (org_id, id, project_id, person_id, wo_id, message_id, requested_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, project_id, person_id) where status = 'open' do nothing`,
        [orgId, `ar-${randomUUID().replace(/-/g, "").slice(0, 16)}`, m.project, p.id, m.woId, m.messageId, m.by, m.now],
      );
      requested = !!r.rowCount;
      if (requested) events.push({ type: "access.request", category: "access", subject: { type: "person", id: p.id }, projectId: m.project, woId: m.woId, after: { person: p.id, project: m.project, requestedBy: m.by, via: "mention" } });
    }
    mentioned.push({ id: p.id, name: p.name, access, requested });
  }
  return { events, mentioned };
}

export interface AccessRequestRow { id: string; project: string; person: string; personName: string; wo: string | null; by: string; byName: string; at: number; message: string }

/** Open requests for the given projects. A person who has since been given access drops out. */
export async function openAccessRequests(db: Queryable, orgId: string, st: PolicyStateLoaded, projects: string[]): Promise<AccessRequestRow[]> {
  if (!projects.length) return [];
  const { rows } = await db.query<{ id: string; project_id: string; person_id: string; pname: string | null; wo_id: string | null; requested_by: string; bname: string | null; created_at: Date; body: string | null }>(
    `select r.id, r.project_id, r.person_id, p.name as pname, r.wo_id, r.requested_by, b.name as bname, r.created_at, m.body
       from access_requests r left join people p on p.org_id = r.org_id and p.id = r.person_id left join people b on b.org_id = r.org_id and b.id = r.requested_by
       left join workorder_messages m on m.org_id = r.org_id and m.id = r.message_id
      where r.org_id = $1 and r.status = 'open' and r.project_id = any($2) order by r.created_at desc limit 100`,
    [orgId, projects],
  );
  return rows
    .filter((r) => !can(st, r.person_id, "project.view", { project: r.project_id }).allowed)
    .map((r) => ({ id: r.id, project: r.project_id, person: r.person_id, personName: r.pname ?? r.person_id, wo: r.wo_id, by: r.requested_by, byName: r.bname ?? r.requested_by, at: r.created_at.getTime(), message: (r.body ?? "").slice(0, 200) }));
}
