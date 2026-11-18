/** The work-order session's messages (spec 8.4): one shared conversation per work order, in `workorder_messages`; the scripted intake questionnaire's rows are read as history. */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable, Tx } from "@gantry/db";
import type { WoCard } from "@gantry/domain";
import { publishChange } from "../../../core/changes.js";
import { convIdOf } from "../model.js";

import type { TurnContext } from "../../session/context.js";

export interface WoMessage {
  id: string;
  role: "user" | "assistant" | "system";
  author: string;
  text: string;
  at: number;
  data: {
    cards?: WoCard[]; drafts?: Record<string, unknown>; kind?: string; mode?: "agent" | "rule-based" | "legacy"; model?: string | null; agent?: string; version?: number; station?: string; tools?: string[];
    scripted?: boolean; mentions?: Array<{ id: string; name: string; access: boolean }>; costMicros?: number; usage?: unknown; stopped?: boolean; truncated?: boolean; followUp?: string; event?: string; chips?: string[];
    /** What the turn was composed from: agent version, skill versions, instruction and prompt hashes, tuple. */
    context?: TurnContext;
  };
}

export const newWoMessageId = (): string => `wm-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
/** A deterministic id for an update that must be posted once per observed transition. */
export const updateId = (orgId: string, woId: string, key: string): string => `wm-ev-${createHash("sha1").update(`${orgId}:${woId}:${key}`).digest("hex").slice(0, 20)}`;

const row = (r: { id: string; role: WoMessage["role"]; author: string; body: string; data: unknown; created_at: Date }): WoMessage => ({
  id: r.id, role: r.role, author: r.author, text: r.body, at: r.created_at.getTime(), data: (r.data && typeof r.data === "object" ? r.data : {}) as WoMessage["data"],
});

export async function listWoMessages(db: Queryable, orgId: string, woId: string, limit = 400): Promise<WoMessage[]> {
  const { rows } = await db.query(
    `select id, role, author, body, data, created_at from (select * from workorder_messages where org_id = $1 and wo_id = $2 order by created_at desc, id desc limit $3) m order by created_at, id`,
    [orgId, woId, limit],
  );
  return rows.map(row as never);
}

/** The scripted questionnaire's messages, as session history (read only). Its questions and the answers to them show exactly as they were said. */
export async function legacyMessages(db: Queryable, orgId: string, woId: string, o: { withScripted?: boolean } = {}): Promise<WoMessage[]> {
  const { rows } = await db.query<{ id: string; author: string; author_kind: string; body: string; data: Record<string, unknown>; created_at: Date }>(
    `select id, author, author_kind, body, data, created_at from messages where org_id = $1 and conversation_id = $2 order by created_at, id`, [orgId, convIdOf(woId)],
  );
  // When an agent talks, Gantry's scripted questions and notes stay out of its history and the page: they were never an agent's words.
  return rows.filter((r) => o.withScripted !== false || r.data?.scripted !== true).map((r) => ({
    id: r.id, role: r.author_kind === "person" ? "user" : r.author_kind === "agent" ? "assistant" : "system", author: r.author, text: r.body,
    at: typeof r.data?.at === "number" ? (r.data.at as number) : r.created_at.getTime(),
    data: { kind: "legacy", mode: "legacy", ...(r.data?.scripted === true ? { scripted: true } : {}), ...(Array.isArray(r.data?.chips) ? { chips: (r.data.chips as unknown[]).map(String) } : {}) },
  }));
}

/** Tells the live channel the session changed (a message, a card's status). Only people who can see the work order's project receive it. */
export async function announceWoSession(tx: Tx, orgId: string, woId: string): Promise<void> {
  const { rows } = await tx.query<{ project_id: string }>(`select project_id from work_orders where org_id = $1 and id = $2`, [orgId, woId]);
  const project = rows[0]?.project_id;
  if (project) await publishChange(tx, { org: orgId, keys: ["conversations"], project });
}

export async function addWoMessage(tx: Tx, orgId: string, woId: string, role: WoMessage["role"], author: string, text: string, data: WoMessage["data"], now: Date, id = newWoMessageId()): Promise<string> {
  await tx.query(`insert into workorder_messages (org_id, id, wo_id, role, author, body, data, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)`, [orgId, id, woId, role, author, text, JSON.stringify(data), now]);
  await announceWoSession(tx, orgId, woId);
  return id;
}

/** Money spent by the session's model calls on this work order, in micro-dollars. */
export async function woSessionSpend(db: Queryable, orgId: string, woId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`select coalesce(sum((data->>'costMicros')::numeric), 0)::text as n from workorder_messages where org_id = $1 and wo_id = $2 and role = 'assistant'`, [orgId, woId]);
  return Number(rows[0]?.n ?? 0);
}

export async function lockWoMessage(tx: Tx, orgId: string, woId: string, id: string): Promise<WoMessage | null> {
  const { rows } = await tx.query(`select id, role, author, body, data, created_at from workorder_messages where org_id = $1 and wo_id = $2 and id = $3 for update`, [orgId, woId, id]);
  return rows[0] ? row(rows[0] as never) : null;
}

export async function saveWoMessageData(tx: Tx, orgId: string, id: string, data: WoMessage["data"]): Promise<void> {
  await tx.query(`update workorder_messages set data = $3::jsonb, updated_at = clock_timestamp() where org_id = $1 and id = $2`, [orgId, id, JSON.stringify(data)]);
}

/** A newer proposal replaces older pending ones of the same kind (only the newest can be approved). */
export async function supersedeWoPending(tx: Tx, orgId: string, woId: string, exceptMessage: string, kinds: string[]): Promise<void> {
  const { rows } = await tx.query<{ id: string; data: WoMessage["data"] }>(
    `select id, data from workorder_messages where org_id = $1 and wo_id = $2 and id <> $3 and jsonb_path_exists(data, '$.cards[*] ? (@.kind == "proposal" && @.status == "pending")') for update`,
    [orgId, woId, exceptMessage],
  );
  for (const m of rows) {
    let changed = false;
    for (const c of m.data.cards ?? []) if (c.kind === "proposal" && c.status === "pending" && kinds.includes(c.what)) { c.status = "superseded"; changed = true; }
    if (changed) await saveWoMessageData(tx, orgId, m.id, m.data);
  }
}

export async function markWoSeen(tx: Tx, orgId: string, woId: string, person: string): Promise<void> {
  await tx.query(
    `insert into workorder_session_seen (org_id, wo_id, person_id, seen_at) values ($1,$2,$3,clock_timestamp()) on conflict (org_id, wo_id, person_id) do update set seen_at = clock_timestamp()`,
    [orgId, woId, person],
  );
}
