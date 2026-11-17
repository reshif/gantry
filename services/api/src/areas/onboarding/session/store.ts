/** The onboarding session's messages (spec 11.3): one shared conversation per repository, in `onboarding_messages`. */
import { randomUUID } from "node:crypto";
import type { Queryable, Tx } from "@gantry/db";
import type { SessionCard } from "@gantry/domain";

import type { TurnContext } from "../../session/context.js";

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  author: string;
  text: string;
  at: number;
  runId: string | null;
  data: { cards?: SessionCard[]; drafts?: Record<string, unknown>; kind?: string; mode?: "agent" | "rule-based"; model?: string | null; tools?: string[]; costMicros?: number; usage?: unknown; stopped?: boolean; truncated?: boolean; context?: TurnContext };
}

export const newSessionMessageId = (): string => `om-${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const row = (r: { id: string; role: SessionMessage["role"]; author: string; body: string; data: unknown; run_id: string | null; created_at: Date }): SessionMessage => ({
  id: r.id, role: r.role, author: r.author, text: r.body, at: r.created_at.getTime(), runId: r.run_id, data: (r.data && typeof r.data === "object" ? r.data : {}) as SessionMessage["data"],
});

export async function listMessages(db: Queryable, orgId: string, repoId: string, limit = 400): Promise<SessionMessage[]> {
  const { rows } = await db.query(
    `select id, role, author, body, data, run_id, created_at from (select * from onboarding_messages where org_id = $1 and repo_id = $2 order by created_at desc, id desc limit $3) m order by created_at, id`,
    [orgId, repoId, limit],
  );
  return rows.map(row as never);
}

export async function addSessionMessage(tx: Tx, orgId: string, repoId: string, runId: string | null, role: SessionMessage["role"], author: string, text: string, data: SessionMessage["data"], now: Date, id = newSessionMessageId()): Promise<string> {
  await tx.query(`insert into onboarding_messages (org_id, id, repo_id, run_id, role, author, body, data, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)`, [orgId, id, repoId, runId, role, author, text, JSON.stringify(data), now]);
  return id;
}

/** Money spent by the session's model calls on this repo, in micro-dollars (each answer records its own cost). */
export async function sessionSpend(db: Queryable, orgId: string, repoId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`select coalesce(sum((data->>'costMicros')::numeric), 0)::text as n from onboarding_messages where org_id = $1 and repo_id = $2 and role = 'assistant'`, [orgId, repoId]);
  return Number(rows[0]?.n ?? 0);
}

/** A message of this repo, locked for the rest of the transaction. */
export async function lockMessage(tx: Tx, orgId: string, repoId: string, id: string): Promise<SessionMessage | null> {
  const { rows } = await tx.query(`select id, role, author, body, data, run_id, created_at from onboarding_messages where org_id = $1 and repo_id = $2 and id = $3 for update`, [orgId, repoId, id]);
  return rows[0] ? row(rows[0] as never) : null;
}

export async function saveMessageData(tx: Tx, orgId: string, id: string, data: SessionMessage["data"]): Promise<void> {
  await tx.query(`update onboarding_messages set data = $3::jsonb, updated_at = clock_timestamp() where org_id = $1 and id = $2`, [orgId, id, JSON.stringify(data)]);
}

/** Marks every still-pending proposal of the repo as replaced (a newer proposal or the person's reply came). Returns how many. */
export async function supersedePending(tx: Tx, orgId: string, repoId: string, exceptMessage?: string): Promise<number> {
  const { rows } = await tx.query<{ id: string; data: SessionMessage["data"] }>(`select id, data from onboarding_messages where org_id = $1 and repo_id = $2 and role = 'assistant' and jsonb_path_exists(data, '$.cards[*] ? (@.status == "pending")') for update`, [orgId, repoId]);
  let n = 0;
  for (const r of rows) {
    if (r.id === exceptMessage) continue;
    let touched = false;
    for (const c of r.data.cards ?? []) if (c.kind === "proposal" && c.status === "pending") { c.status = "superseded"; touched = true; n++; }
    if (touched) await saveMessageData(tx, orgId, r.id, r.data);
  }
  return n;
}
