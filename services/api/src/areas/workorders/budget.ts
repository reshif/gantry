/**
 * A work order's spending cap (owner decision 3, spec 10.4 Budget). A work order that reaches its cap is halted with cause `budget`; a person with the project
 * configuration right sets or raises the cap here. Only a raise that puts spend back under the cap lifts that budget halt, in the same transaction.
 * Manual halts, project and factory halts and the kill state are never touched.
 */
import { appendEvent, enqueue, type EventCategory, type Tx } from "@gantry/db";
import type { Actor, CommandResult } from "../../core/command.js";
import { invalid } from "../../core/errors.js";
import { job } from "../../core/jobs-contract.js";
import { resolveTarget } from "../stops/targets.js";
import { resumeStop } from "../stops/commands.js";
import { lockWo, saveWo } from "./model.js";
import { guardOpen } from "./ctx.js";
import { CAP_NAME, capOfReason, overBudget, overText } from "./budget-state.js";

type Cmd = CommandResult<Record<string, unknown>>;

/** The most a single work order's cap can be set to, in US dollars. */
export const MAX_WO_BUDGET_USD = 100_000;

/**
 * Lifts a budget halt of a work order because the cap that held it was raised (the caller has already saved the new cap and checked that nothing else holds it). One resume,
 * audited with the reason that names the cap, and the enforce job that lets the work order run again.
 */
export async function liftBudgetHalt(tx: Tx, a: Actor, woId: string, reason: string): Promise<{ stop: string; events: NonNullable<Cmd["events"]>; jobs: NonNullable<Cmd["jobs"]> }> {
  const t = await resolveTarget(tx, a.orgId, "workorder", woId);
  const r = await resumeStop(tx, a, t, { reason, budgetChecked: true });
  const stop = String(r.extra?.stop ?? "");
  return { stop, events: r.events, jobs: [job("stop.enforce", { stopId: stop, scope: "wo", targetId: woId, mode: "halt" }, { dedupeKey: `stop.enforce:${stop}:v${Number(r.extra?.version ?? 2)}`, priority: 100 })] };
}

const toMicros = (usd: number): number => Math.round(usd * 1_000_000);
const fmt = (micros: number): string => `$${(micros / 1e6).toFixed(2)}`;
const asMicros = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? toMicros(n) : null;
};

export async function setWoCap(tx: Tx, a: Actor, woId: string, b: { usd: number; reason?: string | undefined }): Promise<Cmd> {
  if (!Number.isFinite(b.usd) || b.usd <= 0) throw invalid("The cap must be more than $0.");
  if (b.usd > MAX_WO_BUDGET_USD) throw invalid(`The cap can be at most $${MAX_WO_BUDGET_USD.toLocaleString("en-US")}.`);
  const w = await lockWo(tx, a.orgId, woId, a.ifMatch);
  guardOpen(w);
  const newMicros = toMicros(b.usd);
  if (newMicros <= 0) throw invalid("The cap must be more than $0.");

  const spent = Number((await tx.query<{ s: string }>(`select coalesce(sum(cost_micros),0)::text as s from run_usage where org_id = $1 and wo_id = $2`, [a.orgId, woId])).rows[0]!.s);
  if (newMicros <= spent) throw invalid(`${woId} has already spent ${fmt(spent)}. Set a cap above that.`);

  // The cap in force before: this work order's own, else the project's per-work-order cap, else the project's config default.
  const own = asMicros(w.data.budgetUsd);
  const proj = (await tx.query<{ w: string | null; extra: Record<string, unknown> | null }>(
    `select b.wo_limit_micros::text as w, p.config->'extra' as extra from projects p left join budgets b on b.org_id = p.org_id and b.project_id = p.id where p.org_id = $1 and p.id = $2`, [a.orgId, w.project],
  )).rows[0];
  const projectCap = proj?.w && Number(proj.w) > 0 ? Number(proj.w) : asMicros(proj?.extra?.woBudgetUsd);
  const prior = own ?? projectCap;
  const raised = prior !== null && newMicros > prior;

  w.data = { ...w.data, budgetUsd: b.usd };
  await saveWo(tx, a.orgId, w);

  const events: Cmd["events"] = [];
  const jobs: NonNullable<Cmd["jobs"]> = [];
  let resumed: string | null = null;
  let note = "";
  const budgetHalt = (
    await tx.query<{ id: string; reason: string }>(
      `select id, reason from stops where org_id = $1 and scope_type = 'wo' and wo_id = $2 and mode = 'halt' and cause = 'budget' and lifted_at is null for update`, [a.orgId, woId],
    )
  ).rows[0];
  if (budgetHalt) {
    const held = capOfReason(budgetHalt.reason);
    const still = await overBudget(tx, a.orgId, woId);
    if (held === "wo" && raised && !still.length) {
      const l = await liftBudgetHalt(tx, a, woId, `Cap raised to $${b.usd}`);
      events.push(...l.events);
      jobs.push(...l.jobs);
      resumed = l.stop;
    } else if (held === "wo" && raised) note = ` The halt stays: ${still.map(overText).join(" and ")} still holds it. Raise that too.`;
    else if (held === "wo") note = " It stays halted until this cap is raised above what it has spent.";
    else note = ` The halt is held by ${held ? CAP_NAME[held] : "another budget"}, not this cap, so it stays.${held === "project" ? " Raise the project's monthly budget to lift it." : ""}`;
  } else if ((await tx.query(`select 1 from stops where org_id = $1 and lifted_at is null and (scope_type = 'factory' or (scope_type = 'project' and project_id = $3) or (scope_type = 'wo' and wo_id = $2))`, [a.orgId, woId, w.project])).rowCount) note = " It is still halted for another reason.";

  events.unshift({
    type: "wo.budget", category: "config", subject: { type: "wo", id: woId }, projectId: w.project, woId, occurredAt: a.now,
    before: { usd: own !== null ? own / 1e6 : null, effectiveUsd: prior !== null ? prior / 1e6 : null },
    after: { usd: b.usd, spentUsd: spent / 1e6, resumed, ...(b.reason?.trim() ? { reason: b.reason.trim() } : {}) },
  });
  return {
    msg: `${woId} may spend up to $${b.usd}.${resumed ? " The budget halt is lifted and work continues." : note}`,
    events,
    jobs,
    extra: { budgetUsd: b.usd, spentUsd: spent / 1e6, resumed: resumed !== null, ...(resumed ? { stop: resumed } : {}) },
    changes: resumed ? ["workOrders", "stops", "floor", "home", "models"] : ["workOrders", "models"],
    project: w.project,
  };
}

export const ZERO_CAP_LIFT_REASON = "cap taken off: $0 now means no cap";

/**
 * A one-off sweep, run at startup and safe to repeat: a project whose monthly budget is 0 has no cap now ($0 used to be a real cap), so a work order still halted by that
 * project cap is resumed, each lift audited with the reason above. A work order that is still over its own cap stays halted. Halts only: nothing is deleted.
 */
export async function sweepZeroCapHalts(tx: Tx, orgId: string, now: Date = new Date()): Promise<string[]> {
  const halts = (await tx.query<{ wo_id: string; reason: string; project_id: string }>(
    `select s.wo_id, s.reason, w.project_id from stops s join work_orders w on w.org_id = s.org_id and w.id = s.wo_id join budgets b on b.org_id = w.org_id and b.project_id = w.project_id
      where s.org_id = $1 and s.scope_type = 'wo' and s.mode = 'halt' and s.cause = 'budget' and s.lifted_at is null and b.monthly_limit_micros = 0 order by s.wo_id`, [orgId],
  )).rows;
  const actor: Actor = {
    orgId, id: "system", kind: "service", personId: null, name: "Gantry", channel: "system", via: null, sessionId: null, ip: null, requestId: `zero-cap-sweep-${now.getTime()}`,
    decision: { allowed: true, reason: "A monthly budget of 0 means no cap, so the halt it held is lifted.", rule: { kind: "service", id: "zero-cap-sweep", name: "Zero cap sweep" }, needs: "" }, ifMatch: null, idempotencyKey: null, now,
  };
  const lifted: string[] = [];
  for (const h of halts) {
    if (capOfReason(h.reason) !== "project") continue;
    if ((await overBudget(tx, orgId, h.wo_id)).length) continue;
    const l = await liftBudgetHalt(tx, actor, h.wo_id, ZERO_CAP_LIFT_REASON);
    for (const e of l.events) {
      await appendEvent(tx, { orgId, type: e.type, category: (e.category ?? "kill") as EventCategory, actor: "system", channel: "system", subject: e.subject ?? null, projectId: e.projectId ?? h.project_id, woId: e.woId ?? h.wo_id, woVersion: e.woVersion ?? null, outcome: e.outcome ?? "ok", before: e.before, after: e.after });
    }
    for (const j of l.jobs) await enqueue(tx, { orgId, ...j });
    lifted.push(h.wo_id);
  }
  return lifted;
}
