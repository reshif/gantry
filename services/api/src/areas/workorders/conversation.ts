/** Intake conversation persistence: one `conversations` row per work order (state in `data`) and its `messages` (spec 8.4). */
import type { Conversation, ConvMessage } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import { convIdOf } from "./model.js";
import type { Fx } from "./engine.js";

const msgId = (woId: string, idx: number): string => `${woId}:m${String(idx).padStart(5, "0")}`;
/** For callers that append one message after the existing ones. */
export const newMessageId = (woId: string): string => `${woId}:m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const stateOf = (c: Conversation) => ({ qi: c.qi, answers: c.answers, misses: c.misses, decisions: c.decisions, awaiting: c.awaiting, raised: c.raised, questions: c.questions, done: c.done });
/** `open` while the conversation still waits for an answer; `answered` when the brief is complete; `closed` once confirmed or declined. */
export const convStatus = (c: Conversation): "open" | "answered" => (c.done && !c.raised.some((r) => !r.answered) ? "answered" : "open");

const authorKind = (from: string): "person" | "agent" | "system" => (from.startsWith("ag-") ? "agent" : from === "system" ? "system" : "person");

async function insertMessages(tx: Tx, orgId: string, woId: string, msgs: ConvMessage[], from: number): Promise<void> {
  for (let i = from; i < msgs.length; i++) {
    const m = msgs[i]!;
    await tx.query(
      `insert into messages (org_id, id, conversation_id, author, author_kind, kind, body, data) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       on conflict (org_id, id) do nothing`,
      [orgId, msgId(woId, i), convIdOf(woId), m.from, authorKind(m.from), m.qid ? "question" : "text", m.text, JSON.stringify({ at: m.at, ...(m.qid ? { qid: m.qid } : {}), ...(m.chips ? { chips: m.chips } : {}), ...(m.scripted ? { scripted: true } : {}) })],
    );
  }
}

export async function insertConversation(fx: Fx, woId: string, projectId: string, by: string, conv: Conversation): Promise<void> {
  await fx.tx.query(`insert into conversations (org_id, id, wo_id, project_id, kind, status, opened_by, data) values ($1,$2,$3,$4,'intake',$5,$6,$7::jsonb)`, [fx.orgId, convIdOf(woId), woId, projectId, convStatus(conv), by, JSON.stringify(stateOf(conv))]);
  await insertMessages(fx.tx, fx.orgId, woId, conv.messages, 0);
}

/** Stores the conversation after a domain step. `prevCount` is how many messages were stored before; the rest are appended. */
export async function saveConversation(fx: Fx, woId: string, conv: Conversation, prevCount: number, status?: "open" | "answered" | "closed"): Promise<void> {
  await fx.tx.query(`update conversations set status = $3, data = $4::jsonb, updated_at = now() where org_id = $1 and id = $2`, [fx.orgId, convIdOf(woId), status ?? convStatus(conv), JSON.stringify(stateOf(conv))]);
  await insertMessages(fx.tx, fx.orgId, woId, conv.messages, prevCount);
}

/** Replaces the whole conversation (reclassify restarts it). */
export async function replaceConversation(fx: Fx, woId: string, conv: Conversation): Promise<void> {
  await fx.tx.query(`delete from messages where org_id = $1 and conversation_id = $2`, [fx.orgId, convIdOf(woId)]);
  await saveConversation(fx, woId, conv, 0);
}

export async function closeConversation(fx: Fx, woId: string): Promise<void> {
  // Nobody is awaited any more once the brief is confirmed or the request declined.
  await fx.tx.query(`update conversations set status = 'closed', data = jsonb_set(data, '{awaiting}', '"nobody"'::jsonb), updated_at = now() where org_id = $1 and id = $2`, [fx.orgId, convIdOf(woId)]);
}

/** Appends one message after the existing ones (confirm-brief, answers returned to a station). */
export async function appendMessage(fx: Fx, woId: string, from: string, text: string, extra: { qid?: string; chips?: string[] } = {}): Promise<void> {
  await fx.tx.query(
    `insert into messages (org_id, id, conversation_id, author, author_kind, kind, body, data) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [fx.orgId, newMessageId(woId), convIdOf(woId), from, authorKind(from), extra.qid ? "question" : "text", text, JSON.stringify({ at: fx.now.getTime(), ...(extra.qid ? { qid: extra.qid } : {}), ...(extra.chips ? { chips: extra.chips } : {}) })],
  );
}
