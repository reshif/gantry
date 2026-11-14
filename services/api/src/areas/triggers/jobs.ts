/** The worker's side of triggers: evaluating an offered event, and firing schedules that came due (spec 11.7). Both run in the caller's transaction. */
import { enqueue, type Queryable, type Tx } from "@gantry/db";
import { job, type JobPayload } from "../../core/jobs-contract.js";
import { channelFor, evaluateTrigger, resolveRepo, type RunCtx, type TriggerInput } from "./run.js";
import { nextRun, parseSchedule } from "./schedule.js";
import { COLS, settingsOf, type TriggerRow } from "./store.js";

export interface EvalSummary { triggers: number; outcomes: Record<string, number> }

/** `trigger.evaluate`: the event is offered to every enabled trigger of its kind on the repository's project whose source connection is on. */
export async function evaluateEvent(tx: Tx, orgId: string, p: JobPayload<"trigger.evaluate">, o: { now?: Date; requestId?: string } = {}): Promise<EvalSummary> {
  const out: EvalSummary = { triggers: 0, outcomes: {} };
  const repo = await resolveRepo(tx, orgId, p.repo);
  if (!repo) return out;
  const { rows } = await tx.query<TriggerRow>(
    `select ${COLS.split(", ").map((c) => `t.${c}`).join(", ")} from triggers t where t.org_id = $1 and t.project_id = $2 and t.kind = $3 and t.enabled
        and exists (select 1 from integration_instances i where i.org_id = t.org_id and i.id = t.config ->> 'source' and i.enabled) order by t.created_at, t.id`,
    [orgId, repo.project_id, p.kind],
  );
  const input: TriggerInput = {
    kind: p.kind, repo: repo.id, title: p.title, body: p.body, labels: p.labels, author: p.author, comment: p.comment, ref: p.ref, url: p.url, check: p.check, dedupeKey: p.dedupeKey,
  };
  const now = o.now ?? new Date();
  const ctx: RunCtx = { orgId, now, requestId: o.requestId ?? `trigger-${p.dedupeKey}`.slice(0, 100), ip: null, channel: channelFor(p.kind) };
  for (const row of rows) {
    out.triggers++;
    const r = await evaluateTrigger(tx, ctx, row, input);
    out.outcomes[r.outcome] = (out.outcomes[r.outcome] ?? 0) + 1;
  }
  return out;
}

/** `trigger.tick`: one scheduled run. The run is identified by the instant it was due, so a retried or duplicated tick makes nothing new. */
export async function evaluateTick(tx: Tx, orgId: string, p: JobPayload<"trigger.tick">, o: { now?: Date } = {}): Promise<{ outcome: string }> {
  const row = (await tx.query<TriggerRow>(`select ${COLS} from triggers where org_id = $1 and id = $2 and kind = 'schedule'`, [orgId, p.triggerId])).rows[0];
  if (!row) return { outcome: "missing" };
  const input: TriggerInput = { kind: "schedule", title: settingsOf(row).title || undefined, ref: `${row.name} ${p.due.slice(0, 16)}Z`, dedupeKey: `sched:${row.id}:${p.due}` };
  const now = o.now ?? new Date();
  const r = await evaluateTrigger(tx, { orgId, now, requestId: `tick-${row.id}-${p.due}`.slice(0, 100), ip: null, channel: "schedule" }, row, input);
  return { outcome: r.outcome };
}

/** Moves every due schedule forward to its next run and enqueues one tick for the instant it was due. The rows are locked while they are moved, so any number of workers produce one tick per run. */
export async function enqueueDueSchedules(db: Queryable, orgId: string, now: Date): Promise<number> {
  const due = await db.query<TriggerRow>(`select ${COLS} from triggers where org_id = $1 and kind = 'schedule' and enabled and next_run_at is not null and next_run_at <= $2 order by next_run_at limit 100 for update skip locked`, [orgId, now]);
  let n = 0;
  for (const row of due.rows) {
    const sched = parseSchedule(settingsOf(row).schedule);
    const next = sched.ok ? nextRun(sched.value, now) : null;
    // The row is locked (for update skip locked), so no other worker takes this run; the new time commits with the tick job.
    await db.query(`update triggers set next_run_at = $3 where org_id = $1 and id = $2`, [orgId, row.id, next]);
    const dueAt = row.next_run_at!.toISOString();
    const j = job("trigger.tick", { triggerId: row.id, due: dueAt }, { dedupeKey: `trigger.tick:${row.id}:${dueAt}`, maxAttempts: 3 });
    await enqueue(db as Tx, { orgId, ...j });
    n++;
  }
  return n;
}
