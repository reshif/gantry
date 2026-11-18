/**
 * Stop commands (spec 8.5, 9.7). They run through `stopCommand` and touch only `stops`, `restore_approvals` and the event log, so they work when other subsystems fail.
 * What a stop does to work orders (cancel attempts, release slots, mark killed) is applied afterwards by the worker (`reconcileStop`); the route enqueues that job
 * in a separate step that tolerates failure, and the reaper finds any stop with `enforced_at` still null.
 */
import type { Tx } from "@gantry/db";
import type { Actor, CommandResult } from "../../core/command.js";
import { Refusal, conflict, invalid } from "../../core/errors.js";
import { factoryAdmins } from "@gantry/domain";
import { readPeople, readSecurity } from "../../core/read/index.js";
import { apiStopId, scopeToApi, stopAction, type ScopeType, type StopTarget } from "./targets.js";

type Cmd = CommandResult<Record<string, unknown>>;

export interface StopRow {
  id: string; scope_type: ScopeType; project_id: string | null; repo_id: string | null; wo_id: string | null; mode: "halt" | "kill"; reason: string; in_flight: string | null; set_by: string; set_at: Date; version: number; fencing: string;
}

const COLS = `id, scope_type, project_id, repo_id, wo_id, mode, reason, in_flight, set_by, set_at, version, fencing::text`;

/** The active stop of a scope and mode, locked. */
export async function activeStop(tx: Pick<Tx, "query">, orgId: string, t: Pick<StopTarget, "scope" | "target">, mode: "halt" | "kill", lock = false): Promise<StopRow | null> {
  const col = t.scope === "project" ? "project_id" : t.scope === "repo" ? "repo_id" : t.scope === "wo" ? "wo_id" : null;
  const { rows } = await tx.query<StopRow>(
    `select ${COLS} from stops where org_id = $1 and lifted_at is null and scope_type = $2 and mode = $3 ${col ? `and ${col} = $4` : ""} ${lock ? "for update" : ""}`,
    col ? [orgId, t.scope, mode, t.target] : [orgId, t.scope, mode],
  );
  return rows[0] ?? null;
}

function payload(t: StopTarget, extra: Record<string, unknown>): Record<string, unknown> {
  return { scope: scopeToApi(t.scope), ...(t.repo ? { repo: t.repo } : {}), ...extra };
}

export interface SetInput {
  mode: "halt" | "kill";
  reason: string;
  /** Kill only: `hold` keeps work orders where they are, `cancel` moves them to Killed. A work order kill always cancels. */
  inFlight?: "hold" | "cancel" | null;
  confirmText?: string | null;
}

/** Pull the andon cord (halt) or throw the kill switch. Spec 4.4 step 1: the stop row takes the next fencing number, which supersedes every older attempt in its scope. */
export async function setStop(tx: Tx, a: Actor, t: StopTarget, b: SetInput): Promise<Cmd> {
  const reason = (b.reason ?? "").trim();
  const label = t.scope === "factory" ? "the factory" : t.name;
  if (b.mode === "kill") {
    if (t.scope === "repo") throw invalid("A repo can be halted. Kill a project or a work order.");
    if (reason.length < 5) throw invalid("Give a reason of at least 5 characters.");
    if (t.scope === "factory" && b.confirmText !== "KILL FACTORY") throw invalid("Type KILL FACTORY to confirm.");
    if (t.scope === "project" && b.confirmText !== t.name) throw invalid(`Type the project name exactly: ${t.name}`);
  } else {
    const min = t.scope === "project" && t.regulated ? 20 : 4;
    if (reason.length < min) throw invalid(`Give a reason of at least ${min} characters${min > 4 ? " (regulated project)." : "."}`);
  }
  const inFlight = b.mode === "kill" ? (t.scope === "wo" ? "cancel" : b.inFlight === "cancel" ? "cancel" : "hold") : null;
  // One stop per scope and mode: serialise on the scope so ids and the "already stopped" answer are consistent under concurrency.
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`stop:${a.orgId}:${t.scope}:${t.target ?? ""}`]);
  if (await activeStop(tx, a.orgId, t, b.mode)) throw conflict(`${label} is already ${b.mode === "halt" ? "halted" : "killed"}.`);
  if (b.mode === "halt" && (await activeStop(tx, a.orgId, t, "kill"))) throw conflict(`${label} is already killed.`);
  if (b.mode === "kill" && t.scope === "wo") {
    // The target lookup already read this row; if the table has failed since, the kill still goes ahead (the active-stop check above is the authority).
    await tx.query("savepoint wo_state");
    try {
      const s = (await tx.query<{ state: string }>(`select state from work_orders where org_id = $1 and id = $2`, [a.orgId, t.wo])).rows[0];
      await tx.query("release savepoint wo_state");
      if (s?.state === "killed") throw conflict(`${t.wo} is already killed.`);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      await tx.query("rollback to savepoint wo_state");
    }
  }
  const n = Number((await tx.query(`select count(*)::int + 1 as n from stops where org_id = $1 and starts_with(id, $2)`, [a.orgId, `${t.scope}:${t.target ?? "factory"}:`])).rows[0].n);
  const id = `${t.scope}:${t.target ?? "factory"}:${n}`;
  const ins = await tx.query<{ fencing: string }>(
    `insert into stops (org_id, id, scope_type, project_id, repo_id, wo_id, mode, reason, cause, in_flight, set_by, set_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$11) returning fencing::text`,
    [a.orgId, id, t.scope, t.scope === "project" || t.scope === "repo" || t.scope === "wo" ? t.project : null, t.scope === "repo" || t.scope === "wo" ? t.repo : null, t.scope === "wo" ? t.wo : null, b.mode, reason, inFlight, a.id, a.now],
  );
  const subject = { type: t.scope === "wo" ? "wo" : t.scope, id: t.target ?? "factory" };
  return {
    msg: b.mode === "halt" ? `${label} halted. Agents on ${t.scope === "factory" ? "every project" : "it"} stop at the next turn boundary; slots stay reserved.` : `${label} killed (${inFlight}). Work in scope stops; credentials are revoked.`,
    events: [{ type: b.mode === "halt" ? "halt" : "kill", category: "kill", subject, projectId: t.project, woId: t.wo, occurredAt: a.now, after: payload(t, { mode: inFlight ?? "halt", text: reason, stop: id, apiId: apiStopId(t.scope, t.target), fencing: Number(ins.rows[0]!.fencing) }) }],
    extra: { stop: id, apiId: apiStopId(t.scope, t.target), mode: b.mode, inFlight, fencing: Number(ins.rows[0]!.fencing), scope: scopeToApi(t.scope), target: t.target },
    changes: ["stops", "factory", "projects", "repos", "workOrders", "floor", "home"],
    project: t.project,
  };
}

/** Resume a halted scope (andon release). Lifting an outer stop never lifts an inner one: only this scope's own halt row is lifted. */
export async function resumeStop(tx: Tx, a: Actor, t: StopTarget, o: { reason?: string } = {}): Promise<Cmd> {
  const label = t.scope === "factory" ? "the factory" : t.name;
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`stop:${a.orgId}:${t.scope}:${t.target ?? ""}`]);
  const halt = await activeStop(tx, a.orgId, t, "halt", true);
  if (!halt) {
    if (await activeStop(tx, a.orgId, t, "kill")) throw conflict(`${label} is killed, not halted. Restore it instead.`);
    throw conflict(`${label} is not halted.`);
  }
  await lift(tx, a, halt);
  return {
    msg: `${label} resumed.`,
    events: [{ type: "resume", category: "kill", subject: { type: t.scope === "wo" ? "wo" : t.scope, id: t.target ?? "factory" }, projectId: t.project, woId: t.wo, occurredAt: a.now, before: { stop: halt.id }, after: payload(t, { text: o.reason ?? "", stop: halt.id, apiId: apiStopId(t.scope, t.target) }) }],
    extra: { stop: halt.id, apiId: apiStopId(t.scope, t.target), version: halt.version + 1 },
    changes: ["stops", "factory", "projects", "repos", "workOrders", "floor", "home"],
    project: t.project,
  };
}

async function lift(tx: Tx, a: Actor, s: StopRow): Promise<void> {
  await tx.query(`update stops set lifted_by = $3, lifted_at = $4, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, s.id, a.id, a.now]);
}

/** Restore a killed scope. Restoring the factory needs two different Factory Admins when the setting is on: the first call records an approval and returns `pending`. */
export async function restoreStop(tx: Tx, a: Actor, t: StopTarget, reason: string): Promise<Cmd> {
  const label = t.scope === "factory" ? "the factory" : t.name;
  if ((reason ?? "").trim().length < 5) throw invalid("Give a reason of at least 5 characters.");
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`stop:${a.orgId}:${t.scope}:${t.target ?? ""}`]);
  const kill = await activeStop(tx, a.orgId, t, "kill", true);
  if (!kill) throw conflict(`${label} is not killed.`);
  if (t.scope === "wo") {
    const outer = (
      await tx.query<{ scope_type: string; reason: string }>(
        `select scope_type, reason from stops where org_id = $1 and lifted_at is null and mode = 'kill' and id <> $2 and (scope_type = 'factory' or (scope_type = 'project' and project_id = $3)) limit 1`, [a.orgId, kill.id, t.project],
      )
    ).rows[0];
    if (outer) throw conflict(`${outer.scope_type === "factory" ? "The factory" : "The project"} is killed: ${outer.reason}. Restore that first.`);
  }
  const subject = { type: t.scope === "wo" ? "wo" : t.scope, id: t.target ?? "factory" };
  if (t.scope === "factory") {
    let needsTwo = true;
    try {
      needsTwo = (await readSecurity(tx, a.orgId)).value.restoreFactoryNeedsTwo;
    } catch {
      // Unreadable settings must not weaken the control: keep the strict default.
    }
    // Owner decision 2026-11-19: with only ONE active Factory Admin, nobody can be the second approver, so that admin restores alone with a reason, audited as an override.
    // With two or more, the two-person approval stays exactly as it is.
    const soleAdmin = needsTwo && (await readPeople(tx, a.orgId).then((ps) => { const fa = factoryAdmins(ps); return fa.length === 1 && fa[0]!.id === a.personId; }).catch(() => false));
    if (soleAdmin) {
      await lift(tx, a, kill);
      return {
        msg: "The factory was restored by its only Factory Admin (override, recorded with your reason).",
        events: [{ type: "restore", category: "kill", subject, outcome: "ok", occurredAt: a.now, before: { stop: kill.id }, after: payload(t, { text: reason.trim(), stop: kill.id, apiId: apiStopId(t.scope, t.target), override: true, soleAdmin: true }) }],
        extra: { stop: kill.id, apiId: apiStopId(t.scope, t.target), pending: false, override: true, version: kill.version + 1 },
        changes: ["stops", "factory", "projects", "repos", "workOrders", "floor", "home"],
        project: t.project,
      };
    }
    if (needsTwo) {
      const prior = await tx.query<{ approver: string }>(`select approver from restore_approvals where org_id = $1 and stop_id = $2`, [a.orgId, kill.id]);
      if (prior.rows.some((r) => r.approver === a.id)) throw conflict("You already approved the restore. A second Factory Admin must approve.");
      await tx.query(`insert into restore_approvals (org_id, id, stop_id, approver, at) values ($1,$2,$3,$4,$5)`, [a.orgId, `RA-${kill.id}-${a.id}`, kill.id, a.id, a.now]);
      if (prior.rowCount! + 1 < 2) {
        return {
          msg: "Restore approval recorded (1 of 2). A second Factory Admin must approve.",
          events: [{ type: "restore", category: "kill", subject, outcome: "ok", occurredAt: a.now, after: { scope: "factory", text: reason.trim(), stop: kill.id, pending: true, approvals: prior.rowCount! + 1, needs: 2 } }],
          extra: { pending: true, approvals: prior.rowCount! + 1, needs: 2, stop: kill.id },
          changes: ["stops", "factory", "home"],
        };
      }
    }
  }
  await lift(tx, a, kill);
  return {
    msg: `${label} restored.${t.scope !== "wo" && kill.in_flight === "cancel" ? " The work orders it killed come back from where they were." : ""}`,
    events: [{ type: "restore", category: "kill", subject, projectId: t.project, woId: t.wo, occurredAt: a.now, before: { stop: kill.id }, after: payload(t, { text: reason.trim(), stop: kill.id, apiId: apiStopId(t.scope, t.target) }) }],
    extra: { stop: kill.id, apiId: apiStopId(t.scope, t.target), pending: false, version: kill.version + 1 },
    changes: ["stops", "factory", "projects", "repos", "workOrders", "floor", "home"],
    project: t.project,
  };
}

export { stopAction };
