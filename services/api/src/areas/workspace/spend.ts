/** What chats cost (agent workspace, Phase 4): each answer records its cost and the person who asked, so spend is counted per thread and per person. */
import type { Queryable } from "@gantry/db";

/** What one person's chat questions cost since `since`, in micro-dollars (the Console and side threads alike). */
export async function chatSpendMicros(db: Queryable, orgId: string, person: string, since: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select coalesce(sum((data->>'costMicros')::numeric), 0)::text as n from console_messages where org_id = $1 and role = 'assistant' and data->>'askedBy' = $2 and created_at >= $3`,
    [orgId, person, since],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Spend per chat, in micro-dollars. */
export async function chatThreadSpend(db: Queryable, orgId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<{ thread_id: string; n: string }>(
    `select thread_id, coalesce(sum((data->>'costMicros')::numeric), 0)::text as n from console_messages where org_id = $1 and role = 'assistant' and thread_id = any($2) group by thread_id`,
    [orgId, ids],
  );
  return new Map(rows.map((r) => [r.thread_id, Number(r.n)]));
}

/** What each person's chats cost since `since`, in micro-dollars, highest first (the operator view). */
export async function chatSpendByPerson(db: Queryable, orgId: string, since: Date): Promise<Array<{ person: string; micros: number; answers: number }>> {
  const { rows } = await db.query<{ person: string; n: string; c: string }>(
    `select data->>'askedBy' as person, coalesce(sum((data->>'costMicros')::numeric), 0)::text as n, count(*)::text as c from console_messages
      where org_id = $1 and role = 'assistant' and data ? 'askedBy' and created_at >= $2 group by 1 order by coalesce(sum((data->>'costMicros')::numeric), 0) desc limit 50`,
    [orgId, since],
  );
  return rows.map((r) => ({ person: r.person, micros: Number(r.n), answers: Number(r.c) }));
}
