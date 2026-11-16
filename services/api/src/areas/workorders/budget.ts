/**
 * A work order's spending cap (owner decision 3, spec 10.4 Budget). A work order that reaches its cap is halted with cause `budget`; a person with the project
 * configuration right sets or raises the cap here. Only a raise that puts spend back under the cap lifts that budget halt, in the same transaction.
 * Manual halts, project and factory halts and the kill state are never touched.
 */
import type { Tx } from "@gantry/db";
import type { Actor, CommandResult } from "../../core/command.js";
import { invalid } from "../../core/errors.js";
import { job } from "../../core/jobs-contract.js";
import { resolveTarget } from "../stops/targets.js";
import { resumeStop } from "../stops/commands.js";
import { lockWo, saveWo } from "./model.js";
import { guardOpen } from "./ctx.js";

type Cmd = CommandResult<Record<string, unknown>>;

/** The most a single work order's cap can be set to, in US dollars. */
export const MAX_WO_BUDGET_USD = 100_000;

/** The reason the meter writes for a work-order cap breach (see areas/internal/runs.ts); a project or run breach reads differently and a work-order cap raise does not clear it. */
const WO_BREACH = /^Budget reached: the work order /;

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
  if (budgetHalt && raised) {
    if (WO_BREACH.test(budgetHalt.reason)) {
      const t = await resolveTarget(tx, a.orgId, "workorder", woId);
      const r = await resumeStop(tx, a, t, { reason: `Cap raised to $${b.usd}` });
      events.push(...r.events);
      resumed = String(r.extra?.stop ?? budgetHalt.id);
      jobs.push(job("stop.enforce", { stopId: resumed, scope: "wo", targetId: woId, mode: "halt" }, { dedupeKey: `stop.enforce:${resumed}:v${Number(r.extra?.version ?? 2)}`, priority: 100 }));
    } else note = " The halt came from another budget, so it stays.";
  } else if (budgetHalt) note = " It stays halted until the cap is raised.";
  else if ((await tx.query(`select 1 from stops where org_id = $1 and lifted_at is null and (scope_type = 'factory' or (scope_type = 'project' and project_id = $3) or (scope_type = 'wo' and wo_id = $2))`, [a.orgId, woId, w.project])).rowCount) note = " It is still halted for another reason.";

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
