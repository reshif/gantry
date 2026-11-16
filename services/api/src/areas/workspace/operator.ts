/**
 * The operator view of the workspace (agent workspace, Phase 4): what needs someone who runs the floor. Observed facts only, computed from the
 * rows; nothing here decides or changes anything.
 *   stuck   a run whose lease ran out, a run with no sign of life for a while, a work order that failed, or one at a station with nothing running
 *   waiting work parked for a person, open gates and blocking questions, with how long they have waited and on whom
 *   budget  work orders that used most of their budget (or all of it), and research plans near their own cap
 *   chats   what each person's chats cost over 24 hours against the per-person cap, and the most expensive chats this week
 * Lists are limited to projects where the person may park work (wo.park), which is who can act on them.
 */
import type { Queryable } from "@gantry/db";
import { askOfLabel } from "../workorders/asked.js";
import { planOf } from "../workorders/research.js";
import { chatSpendByPerson } from "./spend.js";

/** No sign of life from a run for this long counts as stuck. */
export const QUIET_MIN = 15;
/** A work order at this share of its budget is listed. */
export const BUDGET_WARN = 0.8;

export interface OpItem { wo: string; project: string; title: string; station: string; since: number; why: string; who?: string; key: string; costUsd?: number; limitUsd?: number | null }

export async function operatorView(db: Queryable, orgId: string, o: { projects: string[]; bays: string[]; canSeePeople: boolean; capUsd: number | null }): Promise<{ stuck: OpItem[]; waiting: OpItem[]; budget: OpItem[]; chats: { people: Array<{ person: string; usd: number; answers: number; capUsd: number | null }>; threads: Array<{ key: string; title: string; owner: string; usd: number; agent: string | null; scope: string }> } }> {
  const now = Date.now();
  const P = o.projects;
  if (!P.length) return { stuck: [], waiting: [], budget: [], chats: { people: [], threads: [] } };
  const open = `w.state not in ('done','killed','declined') and w.position <> 'declined' and w.source not in ('eval','onboarding')`;

  const [leaseRows, quietRows, failedRows, idleRows, bayRows, gateRows, askRows, spendRows] = await Promise.all([
    db.query<{ wo_id: string; project_id: string; title: string; station: string; lease_until: Date }>(
      `select a.wo_id, w.project_id, w.title, a.station, a.lease_until from attempts a join work_orders w on w.org_id = a.org_id and w.id = a.wo_id
        where a.org_id = $1 and a.state = 'running' and a.lease_until < now() and w.project_id = any($2) and ${open} order by a.lease_until limit 50`, [orgId, P]),
    db.query<{ wo_id: string; project_id: string; title: string; station: string; last: Date }>(
      `select r.wo_id, w.project_id, w.title, a.station, greatest(r.started_at, coalesce((select max(c.created_at) from checkpoints c where c.org_id = r.org_id and c.run_id = r.id), r.started_at),
              coalesce((select max(u.at) from run_usage u where u.org_id = r.org_id and u.run_id = r.id), r.started_at)) as last
         from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id join work_orders w on w.org_id = r.org_id and w.id = r.wo_id
        where r.org_id = $1 and r.state in ('starting','running') and w.project_id = any($2) and ${open}`, [orgId, P]),
    db.query<{ id: string; project_id: string; title: string; position: string; updated_at: Date }>(
      `select w.id, w.project_id, w.title, w.position, w.updated_at from work_orders w where w.org_id = $1 and w.project_id = any($2) and w.state in ('failed','blocked') and ${open} order by w.updated_at limit 50`, [orgId, P]),
    db.query<{ id: string; project_id: string; title: string; position: string; last: Date | null; updated_at: Date }>(
      `select w.id, w.project_id, w.title, w.position, w.updated_at, (select max(coalesce(a.ended_at, a.updated_at)) from attempts a where a.org_id = w.org_id and a.wo_id = w.id) as last
         from work_orders w
        where w.org_id = $1 and w.project_id = any($2) and w.state = 'running' and ${open} and not (w.position = any($3))
          and not exists (select 1 from attempts a where a.org_id = w.org_id and a.wo_id = w.id and a.state in ('queued','running'))
          and not exists (select 1 from gate_instances gi where gi.org_id = w.org_id and gi.wo_id = w.id and gi.status = 'open')
          and w.updated_at < now() - make_interval(mins => $4::int) limit 50`, [orgId, P, o.bays, QUIET_MIN]),
    db.query<{ id: string; project_id: string; title: string; position: string; data: Record<string, unknown>; updated_at: Date }>(
      `select w.id, w.project_id, w.title, w.position, w.data, w.updated_at from work_orders w where w.org_id = $1 and w.project_id = any($2) and w.position = any($3) and ${open} order by w.updated_at limit 100`, [orgId, P, o.bays]),
    db.query<{ wo_id: string; project_id: string; title: string; gate_id: string; station: string | null; opened_at: Date }>(
      `select gi.wo_id, w.project_id, w.title, gi.gate_id, gi.station, gi.opened_at from gate_instances gi join work_orders w on w.org_id = gi.org_id and w.id = gi.wo_id
        where gi.org_id = $1 and gi.status = 'open' and w.project_id = any($2) and ${open} order by gi.opened_at limit 100`, [orgId, P]),
    db.query<{ wo_id: string; project_id: string; title: string; station: string; ask_of: string; question: string; created_at: Date }>(
      `select q.wo_id, w.project_id, w.title, q.station, q.ask_of, q.question, q.created_at from wo_questions q join work_orders w on w.org_id = q.org_id and w.id = q.wo_id
        where q.org_id = $1 and q.status = 'open' and q.blocking and w.project_id = any($2) and ${open} order by q.created_at limit 100`, [orgId, P]),
    db.query<{ id: string; project_id: string; title: string; position: string; data: Record<string, unknown>; spent: string; wo_limit: string | null }>(
      `select w.id, w.project_id, w.title, w.position, w.data, (select coalesce(sum(u.cost_micros), 0) from run_usage u where u.org_id = w.org_id and u.wo_id = w.id)::text as spent,
              (select nullif(b.wo_limit_micros, 0)::text from budgets b where b.org_id = w.org_id and b.project_id = w.project_id) as wo_limit
         from work_orders w where w.org_id = $1 and w.project_id = any($2) and ${open}
          and exists (select 1 from run_usage u where u.org_id = w.org_id and u.wo_id = w.id)`, [orgId, P]),
  ]);

  const stuck: OpItem[] = [];
  for (const r of leaseRows.rows) stuck.push({ wo: r.wo_id, project: r.project_id, title: r.title, station: r.station, since: r.lease_until.getTime(), why: "The run's lease ran out and nobody reclaimed it.", key: `wo:${r.wo_id}` });
  for (const r of quietRows.rows) {
    if (now - r.last.getTime() < QUIET_MIN * 60_000 || stuck.some((s) => s.wo === r.wo_id)) continue;
    stuck.push({ wo: r.wo_id, project: r.project_id, title: r.title, station: r.station, since: r.last.getTime(), why: `The run has shown no step or model call for ${Math.round((now - r.last.getTime()) / 60_000)} minutes.`, key: `wo:${r.wo_id}` });
  }
  for (const r of failedRows.rows) stuck.push({ wo: r.id, project: r.project_id, title: r.title, station: r.position, since: r.updated_at.getTime(), why: "The work order failed or is blocked.", key: `wo:${r.id}` });
  for (const r of idleRows.rows) stuck.push({ wo: r.id, project: r.project_id, title: r.title, station: r.position, since: (r.last ?? r.updated_at).getTime(), why: "Nothing is running at its station and no gate is open.", key: `wo:${r.id}` });

  const waiting: OpItem[] = [];
  for (const r of bayRows.rows) {
    const w = (r.data.waitingOn ?? null) as { station?: string; questions?: number; plan?: boolean; since?: number } | null;
    const why = r.position === "person" ? (w?.plan ? "Waiting for a research plan to be decided." : w?.questions ? `Waiting for ${w.questions} answer${w.questions === 1 ? "" : "s"}.` : "Waiting for a person to answer or take over.")
      : r.position === "queue" ? "Waiting for a free coding slot." : `Parked in the ${r.position} bay.`;
    waiting.push({ wo: r.id, project: r.project_id, title: r.title, station: String(w?.station ?? r.data.bayFrom ?? r.position), since: w?.since ?? r.updated_at.getTime(), why, key: `wo:${r.id}` });
  }
  for (const r of gateRows.rows) waiting.push({ wo: r.wo_id, project: r.project_id, title: r.title, station: r.station ?? r.gate_id, since: r.opened_at.getTime(), why: `Gate ${r.gate_id} is waiting for an approver.`, key: `wo:${r.wo_id}` });
  for (const r of askRows.rows) waiting.push({ wo: r.wo_id, project: r.project_id, title: r.title, station: r.station, since: r.created_at.getTime(), why: `Blocking question: ${r.question.slice(0, 160)}`, who: askOfLabel(r.ask_of), key: `wo:${r.wo_id}` });
  waiting.sort((a, b) => a.since - b.since);

  const budget: OpItem[] = [];
  for (const r of spendRows.rows) {
    const spent = Number(r.spent);
    const own = Number(r.data.budgetUsd);
    const limit = own > 0 ? Math.round(own * 1e6) : r.wo_limit ? Number(r.wo_limit) : null;
    const plan = planOf(r.data);
    if (limit && spent >= limit * BUDGET_WARN) {
      budget.push({ wo: r.id, project: r.project_id, title: r.title, station: r.position, since: now, why: spent >= limit ? "It has used all of its budget: the next model call is refused." : `It has used ${Math.round((spent / limit) * 100)}% of its budget.`, key: `wo:${r.id}`, costUsd: spent / 1e6, limitUsd: limit / 1e6 });
    } else if (plan?.status === "approved" && plan.budgetUsd && plan.decidedAt) {
      const used = Number((await db.query<{ n: string }>(`select coalesce(sum(u.cost_micros),0)::text as n from run_usage u join attempts a on a.org_id = u.org_id and a.id = u.attempt_id where u.org_id = $1 and u.wo_id = $2 and a.station = $3 and u.at >= $4`, [orgId, r.id, plan.station, new Date(plan.decidedAt)])).rows[0]!.n);
      if (used >= plan.budgetUsd * 1e6 * BUDGET_WARN) budget.push({ wo: r.id, project: r.project_id, title: r.title, station: plan.station, since: plan.decidedAt, why: `Its research plan has used ${Math.round((used / (plan.budgetUsd * 1e6)) * 100)}% of the ${plan.budgetUsd.toFixed(2)} USD approved for it.`, key: `wo:${r.id}`, costUsd: used / 1e6, limitUsd: plan.budgetUsd });
    }
  }
  budget.sort((a, b) => (b.costUsd ?? 0) / (b.limitUsd || 1) - (a.costUsd ?? 0) / (a.limitUsd || 1));

  const people = o.canSeePeople ? (await chatSpendByPerson(db, orgId, new Date(now - 86_400_000))).map((p) => ({ person: p.person, usd: p.micros / 1e6, answers: p.answers, capUsd: o.capUsd })) : [];
  const { rows: tRows } = await db.query<{ id: string; title: string; person_id: string; agent_id: string | null; scope_kind: string; scope_id: string | null; visibility: string; n: string }>(
    `select t.id, t.title, t.visibility, t.person_id, t.agent_id, t.scope_kind, t.scope_id, sum((m.data->>'costMicros')::numeric)::text as n
       from console_messages m join console_threads t on t.org_id = m.org_id and t.id = m.thread_id
      where m.org_id = $1 and m.role = 'assistant' and m.created_at > now() - interval '7 days' and m.data ? 'costMicros' and (t.project_id is null or t.project_id = any($2)) and ($3 or t.project_id is not null)
      group by t.org_id, t.id order by sum((m.data->>'costMicros')::numeric) desc limit 10`,
    [orgId, P, o.canSeePeople],
  );
  // A private chat's title is its owner's: the operator sees who spent what, not what they asked.
  const threads = tRows.filter((r) => Number(r.n) > 0).map((r) => ({ key: r.id, title: r.visibility === "project" ? r.title || "Chat" : "Private chat", owner: r.person_id, usd: Number(r.n) / 1e6, agent: r.agent_id, scope: r.scope_id ?? "factory" }));
  return { stuck: stuck.slice(0, 50), waiting: waiting.slice(0, 100), budget: budget.slice(0, 50), chats: { people, threads } };
}
