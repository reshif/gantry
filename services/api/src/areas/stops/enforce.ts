/**
 * Making a committed stop true for work orders (spec 4.4, 4.5, 9.7). The worker calls `reconcileStop` for a `stop.enforce` job, in its own transaction:
 *   an active stop     cancels the attempts in scope (run tokens revoked), releases slots on a kill, closes open gate instances on a kill,
 *                      and for kill-cancel moves the work orders to Killed with what they were doing remembered for restore
 *   a lifted stop      resume (halt): fresh attempts for work that was running; restore (kill): held work is re-validated and re-queued,
 *                      a killed work order returns to a fresh attempt at its last station
 * It is idempotent (an `enforced_at` / `reconciled_version` marker on the stop row) and a stop whose job was lost is found by `pendingStops`.
 * Not done here, because the database cannot do it: terminating containers (launcher), cancelling queued merges and failing the Gantry check / draft conversion (github broker).
 */
import { gateAfter, type Catalog } from "@gantry/domain";
import type { Queryable, Tx } from "@gantry/db";
import { cancelAttempts, closeEntry, closeInstance, dispatchQueued, enterStation, ev, flushFx, note, openGate, releaseSlot, stationIdOf, type Fx } from "../workorders/engine.js";
import { lockWo, saveWo, toWo, WO_COLS, type Wo } from "../workorders/model.js";
import { readCatalog, readOrg } from "../../core/read/index.js";
import type { ScopeType } from "./targets.js";

export interface ReconcileResult {
  action: "enforced" | "resumed" | "restored" | "noop";
  workOrders: number;
  attemptsCancelled: number;
  stop?: { id: string; scope: ScopeType; mode: "halt" | "kill"; inFlight: string | null };
}

interface StopDb { org_id: string; id: string; scope_type: ScopeType; project_id: string | null; repo_id: string | null; wo_id: string | null; mode: "halt" | "kill"; reason: string; in_flight: string | null; set_by: string; lifted_at: Date | null; lifted_by: string | null; version: number; enforced_at: Date | null; reconciled_version: number }

/** Active stops that were never enforced, and lifted stops never reconciled: the reaper re-enqueues `stop.enforce` for these. */
export async function pendingStops(db: Queryable, o: { olderThanMs?: number; limit?: number } = {}): Promise<Array<{ orgId: string; id: string; scope: ScopeType; target: string | null; mode: "halt" | "kill" }>> {
  const { rows } = await db.query<StopDb>(
    `select * from stops where ((lifted_at is null and enforced_at is null and set_at < now() - make_interval(secs => $1)) or (lifted_at is not null and reconciled_version < version and lifted_at < now() - make_interval(secs => $1))) order by set_at limit $2`,
    [(o.olderThanMs ?? 30_000) / 1000, o.limit ?? 50],
  );
  return rows.map((s) => ({ orgId: s.org_id, id: s.id, scope: s.scope_type, target: s.project_id && s.scope_type === "project" ? s.project_id : s.repo_id && s.scope_type === "repo" ? s.repo_id : s.wo_id, mode: s.mode }));
}

async function scopeWos(tx: Tx, s: StopDb): Promise<string[]> {
  const where = s.scope_type === "factory" ? "true" : s.scope_type === "project" ? "project_id = $2" : s.scope_type === "repo" ? "repo_id = $2" : "(id = $2 or parent_id = $2)";
  const { rows } = await tx.query<{ id: string }>(
    `select id from work_orders where org_id = $1 and ${where} and state not in ('done') and position <> 'declined' order by id`,
    s.scope_type === "factory" ? [s.org_id] : [s.org_id, s.project_id && s.scope_type === "project" ? s.project_id : s.repo_id && s.scope_type === "repo" ? s.repo_id : s.wo_id],
  );
  return rows.map((r) => r.id);
}

const stillCovered = async (tx: Tx, orgId: string, w: Wo, exceptId: string): Promise<boolean> =>
  (await tx.query(
    `select 1 from stops where org_id = $1 and lifted_at is null and id <> $2 and (scope_type = 'factory' or (scope_type = 'project' and project_id = $3) or (scope_type = 'repo' and repo_id = $4) or (scope_type = 'wo' and (wo_id = $5 or wo_id = $6))) limit 1`,
    [orgId, exceptId, w.project, w.repo, w.id, w.parentId],
  )).rowCount! > 0;

export async function reconcileStop(tx: Tx, stopId: string, o: { now?: Date; orgId?: string } = {}): Promise<ReconcileResult> {
  const now = o.now ?? new Date();
  const { rows } = await tx.query<StopDb>(`select * from stops where id = $1 ${o.orgId ? "and org_id = $2" : ""} order by set_at desc limit 1 for update`, o.orgId ? [stopId, o.orgId] : [stopId]);
  const s = rows[0];
  if (!s) return { action: "noop", workOrders: 0, attemptsCancelled: 0 };
  const orgId = s.org_id;
  const active = s.lifted_at === null;
  if (active ? s.enforced_at !== null : s.reconciled_version >= s.version) return { action: "noop", workOrders: 0, attemptsCancelled: 0, stop: { id: s.id, scope: s.scope_type, mode: s.mode, inFlight: s.in_flight } };
  const catalog = await readCatalog(tx, orgId, await readOrg(tx, orgId));
  const actor = active ? s.set_by : (s.lifted_by ?? "system");
  const fx: Fx = { tx, orgId, now, actor, catalog, events: [], jobs: [], changes: new Set(["workOrders", "floor", "home", "stops", "audit"]) };
  let count = 0;
  let cancelled = 0;
  const projects = new Set<string>();
  for (const id of await scopeWos(tx, s)) {
    const w = await lockWo(tx, orgId, id);
    projects.add(w.project);
    if (active) {
      const r = await enforceOn(fx, w, s);
      cancelled += r;
    } else if (!(await stillCovered(tx, orgId, w, s.id))) {
      await restoreOne(fx, w, s, catalog);
    }
    await saveWo(tx, orgId, w);
    count++;
  }
  for (const p of projects) await dispatchQueued(fx, p);
  await flushFx(fx);
  if (active) await tx.query(`update stops set enforced_at = $3 where org_id = $1 and id = $2`, [orgId, s.id, now]);
  else await tx.query(`update stops set reconciled_version = version where org_id = $1 and id = $2`, [orgId, s.id]);
  return { action: active ? "enforced" : s.mode === "halt" ? "resumed" : "restored", workOrders: count, attemptsCancelled: cancelled, stop: { id: s.id, scope: s.scope_type, mode: s.mode, inFlight: s.in_flight } };
}

/** One work order under an active stop. A halt cancels the live attempt and keeps the slot; a kill also releases the slot and closes open gate instances (spec 9.5, 9.7). */
async function enforceOn(fx: Fx, w: Wo, s: StopDb): Promise<number> {
  const cancelled = await cancelAttempts(fx, w, s.mode === "halt" ? "halted" : "killed");
  if (s.mode === "halt") {
    if (cancelled) note(w, fx, fx.actor, `Halted (${s.scope_type}): agents stopped at the turn boundary. Work resumes from the last checkpoint.`);
    return cancelled;
  }
  const closed = (await fx.tx.query<{ id: string; gate_id: string }>(`select id, gate_id from gate_instances where org_id = $1 and wo_id = $2 and status = 'open' for update`, [fx.orgId, w.id])).rows;
  for (const g of closed) await closeInstance(fx, g.id, "kill");
  if (closed.length) w.data.stopClosedGates = closed.map((g) => g.gate_id);
  await releaseSlot(fx, w);
  if (s.in_flight === "cancel" && w.state !== "killed") {
    closeEntry(w, fx, "killed");
    w.data.killed = { by: s.set_by, at: fx.now.getTime(), reason: s.reason, scope: s.scope_type === "wo" ? "workorder" : s.scope_type, prev: { state: w.state, position: w.position, station: stationIdOf(fx.catalog, w), bayFrom: w.data.bayFrom ?? null } };
    const from = w.state;
    w.state = "killed";
    note(w, fx, fx.actor, `Killed (${s.scope_type}): ${s.reason}`);
    ev(fx, w, "wo.state", { from, to: "killed", station: stationIdOf(fx.catalog, w), text: s.reason }, { category: "kill" });
  } else if (s.in_flight !== "cancel") {
    w.data.heldByKill = s.scope_type === "wo" ? "workorder" : s.scope_type;
    note(w, fx, fx.actor, `Held in place by ${s.scope_type} kill: ${s.reason}`);
  }
  return cancelled;
}

/** One work order after its stop was lifted. */
async function restoreOne(fx: Fx, w: Wo, s: StopDb, catalog: Catalog): Promise<void> {
  const killed = w.data.killed as { prev?: { state: string; position: string; station: string; bayFrom: string | null } } | null | undefined;
  const heldThisScope = w.data.heldByKill === (s.scope_type === "wo" ? "workorder" : s.scope_type);
  if (w.state === "killed" && killed && s.scope_type === "wo" && s.mode === "kill") {
    const prev = killed.prev ?? { state: "running", position: w.position, station: w.position, bayFrom: null };
    w.data.restoredFrom = killed;
    delete w.data.killed;
    w.state = (prev.state === "running" || prev.state === "waiting" || prev.state === "parked" ? prev.state : "running") as Wo["state"];
    w.position = prev.position;
    note(w, fx, fx.actor, `Restored after kill: ${s.reason}`);
    await resume(fx, w, prev.station, catalog, true);
    ev(fx, w, "wo.state", { from: "killed", to: w.state, station: prev.station, text: "restored" }, { category: "kill" });
    return;
  }
  if (s.mode === "kill" && heldThisScope) {
    delete w.data.heldByKill;
    note(w, fx, fx.actor, `Released after ${s.scope_type} restore; re-validated.`);
    await resume(fx, w, stationIdOf(catalog, w), catalog, true);
    return;
  }
  if (s.mode === "halt") await resume(fx, w, stationIdOf(catalog, w), catalog, false);
}

/** Back to work: running work gets a fresh attempt at its station, a work order that was waiting at a gate gets its instance reopened, parked work stays in its bay. */
async function resume(fx: Fx, w: Wo, sid: string, catalog: Catalog, afterKill: boolean): Promise<void> {
  if (w.position !== sid && !catalog.bays.some((b) => b.id === w.position)) w.position = sid;
  if (catalog.bays.some((b) => b.id === w.position)) return; // in a bay: the bay's own rules apply (the queue is dispatched by the caller)
  const live = (await fx.tx.query(`select 1 from attempts where org_id = $1 and wo_id = $2 and state in ('queued','running')`, [fx.orgId, w.id])).rowCount;
  if (live) return;
  const g = gateAfter(catalog, sid);
  const reopen = (w.data.stopClosedGates as string[] | undefined) ?? [];
  delete w.data.stopClosedGates;
  if (afterKill && reopen.length && g && reopen.includes(g.id) && w.state === "waiting") {
    await openGate(fx, w, g.id);
    return;
  }
  if (afterKill && reopen.includes("G0G1")) {
    closeEntry(w, fx, "restored");
    await enterStation(fx, w, "intake");
    return;
  }
  if (w.state === "waiting") return;
  if (w.state === "running" || afterKill) {
    closeEntry(w, fx, afterKill ? "restored" : "resumed");
    w.state = "running";
    await enterStation(fx, w, sid);
  }
}

void toWo;
void WO_COLS;
