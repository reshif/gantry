import type { AuditEntry, EventEntry } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import { ms } from "../../core/read/rows.js";

/**
 * Read side of the ledger (spec 8.9). The `events` table is the one source: an audit entry is an event row seen through the
 * legacy `AuditEntry` shape (`before`/`after` as text, `target` as a sentence, `via` = channel). Nothing is invented: a field the
 * row does not hold is null.
 */

/** Which rows a viewer may read. `all` = audit.view (factory-wide); otherwise entries of the listed projects plus the viewer's own actions. */
export interface Visibility {
  all: boolean;
  projects: string[];
  actor: string | null;
}

/** Round-three topics cut across the base categories (legacy audit.js TOPICS). The same tests, as SQL on `type`. */
export const TOPICS = [
  { id: "trust", name: "Trust", sql: `(e.type ~ '^trust\\.' or e.type = 'gate.trust')` },
  { id: "learning", name: "Learning", sql: `(e.type ~ '^learning\\.' or e.type = 'eval.case')` },
  {
    id: "catalogue", name: "Catalogue",
    sql: `(e.type ~ '^(station|class|bay|vendor)\\.' or e.type ~ '^role\\.(add|edit|remove)$' or e.type in ('gate.add','flow.gate','flow.override','integration.type','integration.add','integration.remove','model.add','model.remove','card.template'))`,
  },
  { id: "record", name: "Records", sql: `(e.type ~ '^(record|outcome)\\.')` },
] as const;

export interface AuditFiltersIn {
  category?: string;
  topic?: string;
  project?: string;
  actor?: string;
  outcome?: string;
  channel?: string;
  q?: string;
  changes?: boolean;
}

export interface AuditRow extends AuditEntry {
  /** Same as `id`: the position in the org's hash chain. */
  seq: number;
  actorKind: "human" | "agent" | "system";
  actorName: string;
  channel: string;
  digest: string;
  prev: string;
}

export interface AuditDetail extends AuditRow {
  rule: string | null;
  onBehalfOf: string | null;
  topic: string | null;
  workOrder: string | null;
  session: { id: string; method: string | null; ip: string | null; userAgent: string | null; startedAt: number | null } | null;
  request: { id: string | null; command: string | null; idempotencyKey: string | null };
  sourceIp: string | null;
  diff: Array<{ field: string; before: unknown; after: unknown; changed: boolean }> | null;
  history: AuditRow[];
}

const COLS = `e.seq, e.occurred_at, e.type, e.category, e.actor, e.on_behalf_of, e.channel, e.subject, e.project_id, e.wo_id, e.outcome, e.rule,
  e.before, e.after, e.session_id, host(e.source_ip) as ip, e.request_id, e.command_id, e.idempotency_key, e.hash, e.prev_hash,
  case when p.id is not null then 'human' when a.id is not null then 'agent' else 'system' end as actor_kind,
  coalesce(p.name, a.name, e.actor) as actor_name,
  case e.subject->>'type'
    when 'person' then (select sp.name from people sp where sp.org_id = e.org_id and sp.id = e.subject->>'id')
    when 'team' then (select st.name from teams st where st.org_id = e.org_id and st.id = e.subject->>'id')
    when 'agent' then (select sa.name from agents sa where sa.org_id = e.org_id and sa.id = e.subject->>'id')
  end as subject_name`;
const FROM = `events e left join people p on p.org_id = e.org_id and p.id = e.actor left join agents a on a.org_id = e.org_id and a.id = e.actor`;

/** jsonb -> the legacy text form: strings as they are, everything else as JSON. */
const text = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

interface Raw {
  seq: string; occurred_at: Date; type: string; category: string; actor: string; on_behalf_of: string | null; channel: string; subject: unknown; project_id: string | null;
  wo_id: string | null; outcome: string; rule: string | null; before: unknown; after: unknown; session_id: string | null; ip: string | null; request_id: string | null;
  command_id: string | null; idempotency_key: string | null; hash: string; prev_hash: string; actor_kind: "human" | "agent" | "system"; actor_name: string;
  /** The person, team or agent the event is about, by name (null for other subjects or a name since removed). */
  subject_name?: string | null;
}

/** The legacy topic tests, in JS (the detail view shows the topic chip). Mirrors TOPICS.sql. */
export function topicFor(a: string): string | null {
  if (/^trust\./.test(a) || a === "gate.trust") return "trust";
  if (/^learning\./.test(a) || a === "eval.case") return "learning";
  if (/^(station|class|bay|vendor)\./.test(a) || /^role\.(add|edit|remove)$/.test(a) || ["gate.add", "flow.gate", "flow.override", "integration.type", "integration.add", "integration.remove", "model.add", "model.remove", "card.template"].includes(a)) return "catalogue";
  if (/^(record|outcome)\./.test(a)) return "record";
  return null;
}

export function toAudit(r: Raw): AuditRow {
  const subject = isObj(r.subject) ? r.subject : null;
  const sid = subject && typeof subject.id === "string" ? subject.id : null;
  const stype = subject && typeof subject.type === "string" ? subject.type : null;
  const named = subject && (typeof subject.target === "string" ? subject.target : typeof subject.name === "string" ? subject.name : null);
  // a person, team or agent reads by name first; the id stays in the text so a search for it still finds the row
  const target = named ?? (r.subject_name && sid ? `${r.subject_name} · ${stype} ${sid}` : stype ? `${stype}${sid ? ` ${sid}` : ""}` : r.type);
  const seq = Number(r.seq);
  return {
    id: seq, seq, at: ms(r.occurred_at) ?? 0, actor: r.actor, action: r.type, target, where: r.project_id ?? "factory", project: r.project_id, category: r.category,
    outcome: r.outcome as AuditEntry["outcome"], via: r.channel, before: text(r.before), after: text(r.after), entity: stype && sid && stype !== "action" ? { type: stype, id: sid } : null,
    actorKind: r.actor_kind, actorName: r.actor_name, channel: r.channel, digest: r.hash, prev: r.prev_hash,
  };
}

interface Where {
  sql: string;
  params: unknown[];
}

/** orgs and visibility first, then each filter. `skip` leaves one filter out (for the per-category counts). */
function where(orgId: string, vis: Visibility, f: AuditFiltersIn, skip?: "category"): Where {
  const params: unknown[] = [orgId];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const w: string[] = ["e.org_id = $1"];
  if (!vis.all) {
    const own = vis.actor ? ` or e.actor = ${p(vis.actor)}` : "";
    w.push(`(e.project_id = any(${p(vis.projects)}::text[])${own})`);
  }
  if (f.project) w.push(f.project === "factory" ? "e.project_id is null" : `e.project_id = ${p(f.project)}`);
  if (f.category && skip !== "category") w.push(`e.category = ${p(f.category)}`);
  if (f.topic) {
    const t = TOPICS.find((x) => x.id === f.topic);
    w.push(t ? t.sql : "false");
  }
  if (f.actor) {
    if (f.actor === "human" || f.actor === "agent" || f.actor === "system") w.push(`(case when p.id is not null then 'human' when a.id is not null then 'agent' else 'system' end) = ${p(f.actor)}`);
    else w.push(`e.actor = ${p(f.actor)}`);
  }
  if (f.outcome) w.push(`e.outcome = ${p(f.outcome)}`);
  if (f.channel) w.push(`e.channel = ${p(f.channel)}`);
  if (f.changes) w.push("(e.before is not null or e.after is not null)");
  const q = f.q?.trim();
  if (q) {
    const like = p(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    w.push(`(coalesce(p.name, a.name, e.actor) ilike ${like} or e.actor ilike ${like} or e.type ilike ${like} or coalesce(e.project_id, '') ilike ${like} or e.channel ilike ${like}
      or coalesce(e.subject::text, '') ilike ${like} or coalesce(e.before::text, '') ilike ${like} or coalesce(e.after::text, '') ilike ${like})`);
  }
  return { sql: w.join(" and "), params };
}

export interface AuditPage {
  items: AuditRow[];
  next: string | null;
  /** Rows matching every filter. */
  total: number;
  summary: {
    /** Visible entries before any filter, denials among them, and entries that carry a before/after. */
    entries: number;
    denied: number;
    changes: number;
    /** Hash of the newest entry in the org's chain, for readers of the whole ledger only; "" otherwise (it moves with activity in projects the caller can't see). */
    head: string;
    /** Per category, over the other filters. */
    categories: Record<string, number>;
    topics: Record<string, number>;
    facets: { outcomes: string[]; channels: string[]; actors: Array<{ id: string; name: string }> };
  };
}

export async function listAudit(db: Queryable, orgId: string, vis: Visibility, f: AuditFiltersIn, o: { cursor?: number; limit: number }): Promise<AuditPage> {
  const main = where(orgId, vis, f);
  const withCursor = o.cursor ? { sql: `${main.sql} and e.seq < $${main.params.length + 1}`, params: [...main.params, o.cursor] } : main;
  const base = where(orgId, vis, {});
  const nocat = where(orgId, vis, f, "category");
  const [rows, total, cats, topics, tot, facets, people, head] = await Promise.all([
    db.query<Raw>(`select ${COLS} from ${FROM} where ${withCursor.sql} order by e.seq desc limit ${o.limit + 1}`, withCursor.params),
    db.query<{ n: string }>(`select count(*) as n from ${FROM} where ${main.sql}`, main.params),
    db.query<{ category: string; n: string }>(`select e.category, count(*) as n from ${FROM} where ${nocat.sql} group by e.category`, nocat.params),
    db.query<Record<string, string>>(`select ${TOPICS.map((t) => `count(*) filter (where ${t.sql}) as ${t.id}`).join(", ")} from ${FROM} where ${base.sql}`, base.params),
    db.query<{ n: string; denied: string; changes: string }>(
      `select count(*) as n, count(*) filter (where e.outcome = 'denied') as denied, count(*) filter (where e.before is not null or e.after is not null) as changes from ${FROM} where ${base.sql}`, base.params),
    db.query<{ outcomes: string[]; channels: string[] }>(
      `select coalesce(array_agg(distinct e.outcome), '{}') as outcomes, coalesce(array_agg(distinct e.channel), '{}') as channels from ${FROM} where ${base.sql}`, base.params),
    db.query<{ id: string; name: string }>(`select distinct e.actor as id, p.name from ${FROM} where ${base.sql} and p.id is not null order by p.name`, base.params),
    vis.all ? db.query<{ hash: string }>(`select last_hash as hash from gantry_event_head($1)`, [orgId]) : Promise.resolve({ rows: [{ hash: "" }] }),
  ]);
  const page = rows.rows.slice(0, o.limit).map(toAudit);
  const more = rows.rows.length > o.limit;
  const fx = facets.rows[0];
  return {
    items: page,
    next: more && page.length ? String(page[page.length - 1]!.seq) : null,
    total: Number(total.rows[0]?.n ?? 0),
    summary: {
      entries: Number(tot.rows[0]?.n ?? 0), denied: Number(tot.rows[0]?.denied ?? 0), changes: Number(tot.rows[0]?.changes ?? 0), head: head.rows[0]?.hash ?? (vis.all ? "0".repeat(64) : ""),
      categories: Object.fromEntries(cats.rows.map((r) => [r.category, Number(r.n)])),
      topics: Object.fromEntries(TOPICS.map((t) => [t.id, Number(topics.rows[0]?.[t.id] ?? 0)])),
      facets: { outcomes: [...(fx?.outcomes ?? [])].sort(), channels: [...(fx?.channels ?? [])].sort(), actors: people.rows },
    },
  };
}

/** Field-by-field comparison when both sides are JSON objects; null otherwise (the UI then shows the two sides). */
export function diffOf(before: string | null, after: string | null): AuditDetail["diff"] {
  const parse = (v: string | null): Record<string, unknown> | null => {
    if (v === null) return null;
    try {
      const x: unknown = JSON.parse(v);
      return isObj(x) ? x : null;
    } catch {
      return null;
    }
  };
  const b = parse(before);
  const a = parse(after);
  if (!b || !a) return null;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  return keys.map((field) => ({ field, before: b[field] ?? null, after: a[field] ?? null, changed: JSON.stringify(b[field]) !== JSON.stringify(a[field]) }));
}

export async function getAudit(db: Queryable, orgId: string, vis: Visibility, seq: number): Promise<AuditDetail | null> {
  const w = where(orgId, vis, {});
  const { rows } = await db.query<Raw>(`select ${COLS} from ${FROM} where ${w.sql} and e.seq = $${w.params.length + 1}`, [...w.params, seq]);
  const r = rows[0];
  if (!r) return null;
  const row = toAudit(r);
  const sess = r.session_id
    ? (await db.query<{ id: string; method: string | null; ip: string | null; user_agent: string | null; created_at: Date }>(`select id, method, host(ip) as ip, user_agent, created_at from sessions where org_id = $1 and id = $2`, [orgId, r.session_id])).rows[0]
    : undefined;
  const history = row.entity
    ? (
        await db.query<Raw>(
          `select ${COLS} from ${FROM} where ${w.sql} and e.seq <> $${w.params.length + 1} and e.subject->>'type' = $${w.params.length + 2} and e.subject->>'id' = $${w.params.length + 3} order by e.seq desc limit 12`,
          [...w.params, seq, row.entity.type, row.entity.id],
        )
      ).rows.map(toAudit)
    : [];
  return {
    ...row, rule: r.rule, onBehalfOf: r.on_behalf_of, topic: topicFor(r.type), workOrder: r.wo_id,
    session: r.session_id ? { id: r.session_id, method: sess?.method ?? null, ip: sess?.ip ?? null, userAgent: sess?.user_agent ?? null, startedAt: sess ? ms(sess.created_at) ?? null : null } : null,
    request: { id: r.request_id, command: r.command_id, idempotencyKey: r.idempotency_key }, sourceIp: r.ip, diff: diffOf(row.before, row.after), history,
  };
}

/** Keys of the legacy `EventEntry` that a flow event may carry in its subject or `after` payload. */
const EVENT_KEYS = ["repo", "station", "gate", "bay", "scope", "mode", "trust", "from", "to", "cell", "text"] as const;

/** An event row as the legacy `G.store.events` entry the floor replay reads. Payload fields come from `subject`, then `after` (objects only). */
export function toEvent(r: Pick<Raw, "seq" | "occurred_at" | "type" | "actor" | "project_id" | "wo_id" | "subject" | "after">): EventEntry {
  const out: Record<string, unknown> = { id: Number(r.seq), at: ms(r.occurred_at) ?? 0, type: r.type };
  if (r.project_id) out.project = r.project_id;
  if (r.wo_id) out.wo = r.wo_id;
  out.by = r.actor;
  for (const src of [r.subject, r.after]) {
    if (!isObj(src)) continue;
    for (const k of EVENT_KEYS) if (src[k] !== undefined) out[k] = src[k];
  }
  return out as unknown as EventEntry;
}

export async function projectEvents(db: Queryable, orgId: string, projectId: string, q: { from?: number; to?: number; kinds?: string[]; limit: number }): Promise<EventEntry[]> {
  const params: unknown[] = [orgId, projectId];
  const w = ["e.org_id = $1", "e.project_id = $2", "e.outcome <> 'denied'"];
  if (q.from !== undefined) w.push(`e.occurred_at >= to_timestamp($${params.push(q.from)}::double precision / 1000)`);
  if (q.to !== undefined) w.push(`e.occurred_at <= to_timestamp($${params.push(q.to)}::double precision / 1000)`);
  if (q.kinds?.length) w.push(`e.type = any($${params.push(q.kinds)}::text[])`);
  const { rows } = await db.query<Raw>(
    `select e.seq, e.occurred_at, e.type, e.actor, e.project_id, e.wo_id, e.subject, e.after from events e where ${w.join(" and ")} order by e.occurred_at, e.seq limit ${q.limit}`,
    params,
  );
  return rows.map(toEvent);
}

/** The newest entries the viewer may see, without the counts and facets (home "Live activity"). */
export async function latestAudit(db: Queryable, orgId: string, vis: Visibility, f: AuditFiltersIn, limit: number): Promise<{ items: AuditRow[]; next: string | null }> {
  const w = where(orgId, vis, f);
  const { rows } = await db.query<Raw>(`select ${COLS} from ${FROM} where ${w.sql} order by e.seq desc limit ${limit + 1}`, w.params);
  const items = rows.slice(0, limit).map(toAudit);
  return { items, next: rows.length > limit && items.length ? String(items[items.length - 1]!.seq) : null };
}
