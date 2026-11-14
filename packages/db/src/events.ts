import type { Queryable, Tx } from "./tx.js";
import { err, ok, type Result } from "./result.js";

export const EVENT_CATEGORIES = ["auth", "access", "flow", "onboarding", "approvals", "config", "integrations", "api", "agents", "kill", "trust", "learning"] as const;
export const EVENT_CHANNELS = ["web", "console", "slack", "teams", "api", "github", "schedule", "system"] as const;
export const EVENT_OUTCOMES = ["ok", "denied", "failed", "regression"] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];

/** Typed reference to what the event is about: a work order, project, repo, agent, gate and so on. */
export interface EventSubject {
  type: string;
  id: string;
  [k: string]: unknown;
}

/** Spec 7.2. seq, recorded_at, prev_hash and hash are assigned by the database. Never put secrets in `before`/`after`. */
export interface EventInput {
  orgId: string;
  type: string;
  category: EventCategory;
  actor: string;
  onBehalfOf?: string | null;
  channel: EventChannel;
  subject?: EventSubject | null;
  projectId?: string | null;
  woId?: string | null;
  woVersion?: number | null;
  outcome?: EventOutcome;
  rule?: string | null;
  before?: unknown;
  after?: unknown;
  commandId?: string | null;
  idempotencyKey?: string | null;
  causationId?: string | null;
  sessionId?: string | null;
  sourceIp?: string | null;
  requestId?: string | null;
  occurredAt?: Date;
}

export interface AppendedEvent {
  id: string;
  seq: number;
  hash: string;
  prevHash: string;
  recordedAt: Date;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * Runs in the event's own transaction right after the row is inserted (spec 12.2: every notification is derived from a committed event, so the outbox rows
 * commit or roll back with it). An observer's failure is rolled back to a savepoint and reported to `onObserverError`; it never undoes the event or the transition.
 */
export type EventObserver = (tx: Tx, event: EventInput, appended: AppendedEvent) => Promise<void>;
const observers = new Set<EventObserver>();
let observerError: (e: unknown, event: EventInput) => void = () => undefined;
export function addEventObserver(fn: EventObserver): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}
export function onObserverError(fn: (e: unknown, event: EventInput) => void): void {
  observerError = fn;
}

/** Appends in the caller's transaction, so the event commits or rolls back with the state it describes. */
export async function appendEvent(tx: Tx, e: EventInput): Promise<AppendedEvent> {
  const { rows } = await tx.query<{ id: string; seq: string; hash: string; prev_hash: string; recorded_at: Date }>(
    `insert into events (org_id, occurred_at, type, category, actor, on_behalf_of, channel, subject, project_id, wo_id, wo_version,
        outcome, rule, before, after, command_id, idempotency_key, causation_id, session_id, source_ip, request_id, prev_hash, hash)
     values ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb,
        $16, $17, $18, $19, $20::inet, $21, repeat('0', 64), repeat('0', 64))
     returning id, seq, hash, prev_hash, recorded_at`,
    [
      e.orgId, e.occurredAt ?? null, e.type, e.category, e.actor, e.onBehalfOf ?? null, e.channel, json(e.subject),
      e.projectId ?? null, e.woId ?? null, e.woVersion ?? null, e.outcome ?? "ok", e.rule ?? null, json(e.before), json(e.after),
      e.commandId ?? null, e.idempotencyKey ?? null, e.causationId ?? null, e.sessionId ?? null, e.sourceIp ?? null, e.requestId ?? null,
    ],
  );
  const r = rows[0]!;
  const appended = { id: r.id, seq: Number(r.seq), hash: r.hash, prevHash: r.prev_hash, recordedAt: r.recorded_at };
  for (const ob of observers) {
    await tx.query("savepoint event_observer");
    try {
      await ob(tx, e, appended);
      await tx.query("release savepoint event_observer");
    } catch (err) {
      await tx.query("rollback to savepoint event_observer");
      observerError(err, e);
    }
  }
  return appended;
}

export type ChainBreak =
  | { kind: "seq_gap"; seq: number; expected: number }
  | { kind: "prev_hash_mismatch"; seq: number }
  | { kind: "hash_mismatch"; seq: number }
  | { kind: "tail_mismatch"; seq: number; detail: "counter_ahead_of_log" | "head_hash_differs" };

export interface ChainOk {
  count: number;
  headSeq: number;
  headHash: string;
}

/**
 * Walks the org's chain in order and reports the first break: a gap in seq, a prev_hash that is not the
 * previous row's hash, a hash that does not match the row's fields, or a tail that disagrees with the
 * counter (rows removed from the end). The scan runs inside the database; only the first break comes back.
 */
export async function verifyChain(db: Queryable, orgId: string): Promise<Result<ChainOk, ChainBreak>> {
  const bad = await db.query<{ seq: string; kind: ChainBreak["kind"]; expected: string | null }>(
    `select seq, kind, expected from (
       select e.seq,
         case
           when e.seq <> coalesce(lag(e.seq) over w, 0) + 1 then 'seq_gap'
           when e.prev_hash <> coalesce(lag(e.hash) over w, repeat('0', 64)) then 'prev_hash_mismatch'
           when e.hash <> gantry_event_hash(e) then 'hash_mismatch'
         end as kind,
         coalesce(lag(e.seq) over w, 0) + 1 as expected
       from events e where e.org_id = $1
       window w as (order by e.seq)
     ) s where kind is not null order by seq limit 1`,
    [orgId],
  );
  if (bad.rows[0]) {
    const r = bad.rows[0];
    const seq = Number(r.seq);
    return err(r.kind === "seq_gap" ? { kind: "seq_gap", seq, expected: Number(r.expected) } : ({ kind: r.kind, seq } as ChainBreak));
  }
  const head = await db.query<{ seq: string | null; hash: string | null; count: string; c_seq: string | null; c_hash: string | null }>(
    `select (select max(seq) from events where org_id = $1) as seq,
            (select hash from events where org_id = $1 order by seq desc limit 1) as hash,
            (select count(*) from events where org_id = $1) as count,
            (select last_seq from gantry_event_head($1)) as c_seq,
            (select last_hash from gantry_event_head($1)) as c_hash`,
    [orgId],
  );
  const h = head.rows[0]!;
  const headSeq = Number(h.seq ?? 0);
  // No counter row means no event was ever appended for this org.
  if (h.c_seq !== null) {
    if (Number(h.c_seq) !== headSeq) return err({ kind: "tail_mismatch", seq: headSeq, detail: "counter_ahead_of_log" });
    if (headSeq > 0 && h.c_hash !== h.hash) return err({ kind: "tail_mismatch", seq: headSeq, detail: "head_hash_differs" });
  }
  return ok({ count: Number(h.count), headSeq, headHash: h.hash ?? "0".repeat(64) });
}
