/**
 * Full-text search in the workspace (agent workspace, Phase 4): messages in every conversation, station documents, research sources and the
 * questions agents asked, limited to what the person may read (projects they see; chats they own, were invited to, or that were shared with a
 * project they see). Postgres full text with the english configuration; each query matches the expression of its index (migration 0038).
 */
import type { Queryable } from "@gantry/db";

export type HitKind = "message" | "document" | "source" | "question";
export interface Hit {
  kind: HitKind;
  /** The conversation to open: `wo:<id>`, `repo:<id>` or a chat id. */
  key: string;
  /** Where in it: the message id, the document version id, the source ref, the question id. */
  ref: string;
  title: string;
  /** The matching text with each match between ⟦ and ⟧ (the page highlights them; the text is shown as plain text). */
  snippet: string;
  at: number;
  rank: number;
  project: string | null;
  by: string | null;
}

const HL = `'StartSel=⟦, StopSel=⟧, MaxWords=28, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "'`;

export async function search(db: Queryable, orgId: string, o: { q: string; me: string; projects: string[]; kinds?: HitKind[]; project?: string | null; limit?: number }): Promise<Hit[]> {
  const q = o.q.trim().slice(0, 200);
  if (!q) return [];
  const projects = o.project ? o.projects.filter((p) => p === o.project) : o.projects;
  const per = Math.min(o.limit ?? 20, 50);
  const want = (k: HitKind): boolean => !o.kinds?.length || o.kinds.includes(k);
  const tsq = `websearch_to_tsquery('english', $2)`;
  const jobs: Array<Promise<Hit[]>> = [];
  const run = (sql: string, args: unknown[], map: (r: Record<string, unknown>) => Hit): Promise<Hit[]> => db.query(sql, args).then((r) => r.rows.map((x) => map(x as Record<string, unknown>)));
  const at = (v: unknown): number => (v instanceof Date ? v.getTime() : 0);

  if (want("message")) {
    jobs.push(run(
      `select m.id, m.wo_id, w.title, w.project_id, m.author, m.created_at, ts_rank(to_tsvector('english', m.body), ${tsq}) as rank, ts_headline('english', m.body, ${tsq}, ${HL}) as snip
         from workorder_messages m join work_orders w on w.org_id = m.org_id and w.id = m.wo_id
        where m.org_id = $1 and to_tsvector('english', m.body) @@ ${tsq} and w.project_id = any($3) and w.source not in ('eval', 'onboarding')
        order by rank desc, m.created_at desc limit $4`,
      [orgId, q, projects, per],
      (r) => ({ kind: "message", key: `wo:${r.wo_id}`, ref: String(r.id), title: `${r.wo_id} · ${r.title}`, snippet: String(r.snip), at: at(r.created_at), rank: Number(r.rank), project: String(r.project_id), by: (r.author as string) ?? null }),
    ));
    jobs.push(run(
      `select m.id, m.repo_id, r.name, r.project_id, m.author, m.created_at, ts_rank(to_tsvector('english', m.body), ${tsq}) as rank, ts_headline('english', m.body, ${tsq}, ${HL}) as snip
         from onboarding_messages m join repos r on r.org_id = m.org_id and r.id = m.repo_id
        where m.org_id = $1 and to_tsvector('english', m.body) @@ ${tsq} and r.project_id = any($3)
        order by rank desc, m.created_at desc limit $4`,
      [orgId, q, projects, per],
      (r) => ({ kind: "message", key: `repo:${r.repo_id}`, ref: String(r.id), title: `Onboarding ${r.name}`, snippet: String(r.snip), at: at(r.created_at), rank: Number(r.rank), project: String(r.project_id), by: (r.author as string) ?? null }),
    ));
    jobs.push(run(
      `select m.id, m.thread_id, t.title, t.project_id, coalesce(m.author, case when m.role = 'user' then t.person_id else null end) as author, m.created_at,
              ts_rank(to_tsvector('english', m.body), ${tsq}) as rank, ts_headline('english', m.body, ${tsq}, ${HL}) as snip
         from console_messages m join console_threads t on t.org_id = m.org_id and t.id = m.thread_id
        where m.org_id = $1 and to_tsvector('english', m.body) @@ ${tsq} and t.expires_at > now()
          and (t.project_id is null or t.project_id = any($3)) and ($6::text is null or t.project_id = $6)
          and (t.person_id = $5 or exists (select 1 from thread_members tm where tm.org_id = t.org_id and tm.thread_id = t.id and tm.person_id = $5) or (t.visibility = 'project' and t.project_id is not null))
        order by rank desc, m.created_at desc limit $4`,
      [orgId, q, o.projects, per, o.me, o.project ?? null],
      (r) => ({ kind: "message", key: String(r.thread_id), ref: String(r.id), title: String(r.title || "Chat"), snippet: String(r.snip), at: at(r.created_at), rank: Number(r.rank), project: (r.project_id as string) ?? null, by: (r.author as string) ?? null }),
    ));
  }
  if (want("document")) {
    jobs.push(run(
      // The newest matching version of each document (older versions that match too are the same hit, said again).
      `select * from (
         select distinct on (a.wo_id, a.doc) a.id, a.wo_id, a.doc, a.version, w.project_id, a.author_id, a.created_at, ts_rank(to_tsvector('english', coalesce(a.body, '')), ${tsq}) as rank,
                ts_headline('english', coalesce(a.body, ''), ${tsq}, ${HL}) as snip
           from artefacts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id
          where a.org_id = $1 and a.doc is not null and to_tsvector('english', coalesce(a.body, '')) @@ ${tsq} and w.project_id = any($3)
          order by a.wo_id, a.doc, a.version desc) d
        order by rank desc limit $4`,
      [orgId, q, projects, per],
      (r) => ({ kind: "document", key: `wo:${r.wo_id}`, ref: String(r.id), title: `${r.wo_id} · ${r.doc} v${r.version}`, snippet: String(r.snip), at: at(r.created_at), rank: Number(r.rank), project: String(r.project_id), by: (r.author_id as string) ?? null }),
    ));
  }
  if (want("source")) {
    jobs.push(run(
      `select s.ref, s.wo_id, s.title, s.url, w.project_id, s.fetched_by, s.fetched_at, ts_rank(to_tsvector('english', s.title || ' ' || s.excerpt), ${tsq}) as rank,
              ts_headline('english', s.title || ' ' || s.excerpt, ${tsq}, ${HL}) as snip
         from research_sources s join work_orders w on w.org_id = s.org_id and w.id = s.wo_id
        where s.org_id = $1 and to_tsvector('english', s.title || ' ' || s.excerpt) @@ ${tsq} and w.project_id = any($3)
        order by rank desc, s.fetched_at desc limit $4`,
      [orgId, q, projects, per],
      (r) => ({ kind: "source", key: `wo:${r.wo_id}`, ref: String(r.ref), title: `${r.wo_id} · [${r.ref}] ${r.title || r.url}`, snippet: String(r.snip), at: at(r.fetched_at), rank: Number(r.rank), project: String(r.project_id), by: (r.fetched_by as string) ?? null }),
    ));
  }
  if (want("question")) {
    jobs.push(run(
      `select qn.id, qn.wo_id, qn.station, qn.asked_by, w.project_id, qn.created_at, ts_rank(to_tsvector('english', qn.question || ' ' || coalesce(qn.answer, '')), ${tsq}) as rank,
              ts_headline('english', qn.question || ' ' || coalesce(qn.answer, ''), ${tsq}, ${HL}) as snip
         from wo_questions qn join work_orders w on w.org_id = qn.org_id and w.id = qn.wo_id
        where qn.org_id = $1 and to_tsvector('english', qn.question || ' ' || coalesce(qn.answer, '')) @@ ${tsq} and w.project_id = any($3)
        order by rank desc, qn.created_at desc limit $4`,
      [orgId, q, projects, per],
      (r) => ({ kind: "question", key: `wo:${r.wo_id}`, ref: String(r.id), title: `${r.wo_id} · question at ${r.station}`, snippet: String(r.snip), at: at(r.created_at), rank: Number(r.rank), project: String(r.project_id), by: (r.asked_by as string) ?? null }),
    ));
  }
  const all = (await Promise.all(jobs)).flat();
  return all.sort((a, b) => b.rank - a.rank || b.at - a.at).slice(0, per * 2);
}
