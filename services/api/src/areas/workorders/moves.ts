/** Board and traveler moves: move (one step along the route), send back, park, unpark, reassign, retry and the record summary (spec 9.4, 9.6). */
import { OVERRIDE_REASON_MIN, bayDef, can, gateForWO, moveCheck, nextStationId, route, routeGates, stationDef, type MoveCheck, type Project } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor } from "../../core/command.js";
import { conflict, invalid, refuse } from "../../core/errors.js";
import {
  acquireSlot, arriveAtGate, bayOf, cancelAttempts, closeEntry, closeOpenInstances, closeOpenQuestions, coveringStop, dispatchQueued, enterStation, ev, leaveBay, note, openEntry, openGate, pinned, advance, projectOf, resetGatesFrom, stationIdOf, type Fx, overrideWip, wipHoldCheck
} from "./engine.js";
import { begin, done, flowFor, person, type CmdResult } from "./ctx.js";
import { approveInner } from "./gates.js";
import { declineInner, parkInto, resumeAt } from "./intake.js";
import { saveWo, type Wo } from "./model.js";
import { limitInRange, limitRangeText, loadRunLimits } from "../agents/run-limits.js";
import { liftBudgetHalt } from "./budget.js";
import { capOfReason, overBudget, overText } from "./budget-state.js";

/** The dry run of a move for the board (spec 9.4): `moveCheck` against the live state, for whoever asks. No state changes, so no command pipeline. */
export async function dryRunMove(db: Tx | import("pg").Pool, orgId: string, principalId: string | null, woId: string, to: string, now = Date.now()): Promise<MoveCheck & { allowed: boolean }> {
  const { loadFlow, readWoRow, stateWithPinned } = await import("./model.js");
  const row = await readWoRow(db, orgId, woId);
  if (!row) throw refuse("not_found", "No such work order.");
  const loaded = await loadFlow(db, orgId, { ids: [woId] });
  const st = await stateWithPinned(db, orgId, loaded, row);
  const wo = st.workOrders[0];
  if (!wo) throw refuse("not_found", "No such work order.");
  const m = moveCheck(st, principalId, wo, to, now);
  if (m.allowed) {
    const { coveringStop } = await import("./engine.js");
    const s = await coveringStop(db, orgId, row);
    if (s) return { allowed: false, reason: `${s.reason || "Stopped"} (${s.scope} ${s.mode === "halt" ? "halted" : "killed"})` };
  }
  return m;
}

/** A move executes the step `moveCheck` allows, through the same handlers as the dedicated endpoints (F10: board drag, console and API all call one handler). */
export async function moveWO(tx: Tx, actor: Actor, woId: string, to: string, reason?: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.move");
  const by = person(actor, "Moves are");
  const { st, wo } = await flowFor(fx, w);
  const check = moveCheck(st, by, wo, to, fx.now.getTime());
  if (!check.allowed) throw refuse("conflict", check.reason);
  if (check.kind === "park") return to === "declined" ? declineInner(fx, actor, w, reason ?? "Moved on the board", undefined) : parkInner(fx, actor, w, to, reason ?? "Moved on the board");
  if (check.kind === "unpark") return unparkInner(fx, actor, w, reason);
  if (check.kind === "back") return sendBackInner(fx, actor, w, to, reason ?? "");
  if (check.kind === "approve") {
    const gate = gateForWO(fx.catalog, st.projects.find((p) => p.id === w.project), wo);
    if (!gate) throw conflict(`${w.id} is not waiting at a gate.`);
    return approveInner(fx, actor, w, gate.id, null);
  }
  throw refuse("conflict", "Not a valid move.");
}

export async function sendBack(tx: Tx, actor: Actor, woId: string, to: string, noteText: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.sendback");
  return sendBackInner(fx, actor, w, to, noteText);
}

async function sendBackInner(fx: Fx, actor: Actor, w: Wo, to: string, noteText: string): Promise<CmdResult> {
  const by = person(actor, "Send-backs are");
  const project = await projectOf(fx, w.project);
  if (bayOf(fx.catalog, w)) throw conflict(`${w.id} is parked in a bay; return it to the belt first.`);
  const r = route(fx.catalog, project, w.cls);
  const cur = stationIdOf(fx.catalog, w);
  // A person may send the work order back to the station it is at (a "redo"): the station runs again from a clean attempt, with the person's note.
  if (!r.includes(to) || r.indexOf(to) > r.indexOf(cur)) throw invalid("Pick this station or an earlier one on this work order's route.");
  if (to === cur && noteText.trim().length < 3) throw invalid("Say what the station should do differently (a note of at least 3 characters) when you send it back to the station it is at.");
  await sendBackCore(fx, w, project, cur, to, noteText, by);
  return done(fx, to === cur ? `${w.id} sent back to redo ${stationDef(fx.catalog, to)?.name ?? to}.` : `${w.id} sent back to ${stationDef(fx.catalog, to)?.name ?? to}.`, w.project, { version: w.version, redo: to === cur });
}

/** The send-back itself, shared by a person's send-back and the system's enforcement of a Review verdict (`by` is the person or "system"). Saves the work order. */
export async function sendBackCore(fx: Fx, w: Wo, project: Project, cur: string, to: string, noteText: string, by: string, extra: Record<string, unknown> = {}): Promise<void> {
  const redo = to === cur;
  closeEntry(w, fx, redo ? "redo" : "sent back", noteText);
  w.data.sendbacks = [...(Array.isArray(w.data.sendbacks) ? (w.data.sendbacks as unknown[]) : []), { from: cur, to, note: noteText, at: fx.now.getTime(), by, ...(redo ? { redo: true } : {}), ...extra }];
  await cancelAttempts(fx, w, redo ? "redo" : "sent back");
  await closeOpenQuestions(fx, w.id, redo ? "The station was redone; it asks again if it still needs to." : `The work order was sent back to ${to}; the station asks again if it still needs to.`);
  await closeOpenInstances(fx, w.id, "send_back");
  await resetGatesFrom(fx, w, project, to);
  // The station it goes back to may be full: the order then waits where it is until a place frees (a send-back is let in before work going forward).
  if (!(await wipHoldCheck(fx, w, to, "back", { by }))) await enterStation(fx, w, to, { project, noWip: true });
  note(w, fx, by, redo ? `Redo ${stationDef(fx.catalog, to)?.name ?? to}${noteText ? `: ${noteText}` : "."}` : `Sent back from ${stationDef(fx.catalog, cur)?.name ?? cur} to ${stationDef(fx.catalog, to)?.name ?? to}${noteText ? `: ${noteText}` : "."}`);
  ev(fx, w, "wo.sendback", { text: noteText, from: cur, to, station: to, ...(redo ? { redo: true } : {}), ...(by === "system" ? { by: "system" } : {}) });
  await saveWo(fx.tx, fx.orgId, w);
  await dispatchQueued(fx, w.project);
}

export async function park(tx: Tx, actor: Actor, woId: string, bay: string, reason: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.park");
  if (bay === "declined") {
    if (!actor.personId) throw refuse("denied", "Declining is for signed-in people.");
    return declineInner(fx, actor, w, reason);
  }
  return parkInner(fx, actor, w, bay, reason);
}

async function parkInner(fx: Fx, actor: Actor, w: Wo, bay: string, reason: string): Promise<CmdResult> {
  const by = person(actor, "Parking is");
  const project = await projectOf(fx, w.project);
  const b = bayDef(fx.catalog, bay);
  if (!b || (project.flow.bays && !project.flow.bays.includes(bay))) throw invalid(`No bay ${bay} in ${project.name}.`);
  if (!reason || reason.trim().length < 3) throw invalid("Give a reason.");
  if (w.position === bay) throw conflict(`Already in ${b.name}.`);
  const wasStation = stationIdOf(fx.catalog, w);
  if (bay === "queue" && wasStation !== "build" && nextStationId(fx.catalog, project, { cls: w.cls, station: fx.catalog.stations.findIndex((s) => s.id === wasStation) }) !== "build") throw invalid("Only work about to build can wait in the Queue.");
  const heldSlot = await parkInto(fx, w, bay, reason.trim());
  void heldSlot;
  if (bay === "person") {
    const { flowFor: ff } = await import("./ctx.js");
    const { saveConversation } = await import("./conversation.js");
    const { wo } = await ff(fx, w);
    const conv = structuredClone(wo.conv);
    conv.raised.push({ station: wasStation, text: reason.trim(), at: fx.now.getTime(), answered: false });
    conv.messages.push({ from: by, at: fx.now.getTime(), text: reason.trim() });
    await saveConversation(fx, w.id, conv, wo.conv.messages.length, "open");
  }
  note(w, fx, by, `Moved to ${b.name}: ${reason.trim()}`);
  await saveWo(fx.tx, fx.orgId, w);
  await dispatchQueued(fx, w.project);
  return done(fx, `${w.id} moved to ${b.name}.`, w.project, { version: w.version });
}

export async function unpark(tx: Tx, actor: Actor, woId: string, reason?: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.park");
  return unparkInner(fx, actor, w, reason);
}

async function unparkInner(fx: Fx, actor: Actor, w: Wo, reason?: string): Promise<CmdResult> {
  const by = person(actor, "Returning work to the belt is");
  const from = bayOf(fx.catalog, w);
  if (!from) throw invalid(`${w.id} is not in a bay.`);
  const { st } = await flowFor(fx, w);
  if (from === "sechold" && !can(st, by, "gate.approve", { project: w.project, time: fx.now.getTime() }).allowed) throw refuse("denied", "Security hold can only be released by someone who may approve gates in this project.", { rule: { kind: "matrix", id: "gate.approve", name: "Approve gates" } });
  const back = from === "queue" ? "build" : String(w.data.bayFrom ?? "intake");
  // The station it returns to may be full: the order then stays in its bay until a place frees (the Queue already counts at Build, so it is never held here).
  if (await wipHoldCheck(fx, w, back, "unpark", { by, ...(reason ? { reason } : {}) })) {
    await saveWo(fx.tx, fx.orgId, w);
    await dispatchQueued(fx, w.project); // the limit may have moved since the count: a place that is free now is used now
    const live = w.data.wipWait as { live: number; limit: number };
    return done(fx, `${w.id} waits in ${bayDef(fx.catalog, from)?.name ?? from}: ${stationDef(fx.catalog, back)?.name ?? back} is full (${live.live}/${live.limit}).`, w.project, { version: w.version, waiting: true });
  }
  fx.wipAdmit = w.id;
  await unparkCore(fx, w, by, reason);
  return done(fx, `${w.id} is back at ${stationDef(fx.catalog, stationIdOf(fx.catalog, w))?.name ?? back}.`, w.project, { version: w.version });
}

/** The return from a bay itself (the place at the station is already settled): the station runs again or the gate reopens. Saves the order. */
export async function unparkCore(fx: Fx, w: Wo, by: string, reason?: string): Promise<void> {
  const from = bayOf(fx.catalog, w);
  if (!from) throw invalid(`${w.id} is not in a bay.`);
  const project = await projectOf(fx, w.project);
  const back = from === "queue" ? "build" : String(w.data.bayFrom ?? "intake");
  // Returning a blocked merge to the belt gives up that approval: the station runs again and the gate opens afresh on whatever head it ends with.
  if (w.data.bayCause === "merge") delete w.data.merging;
  await leaveBay(fx, w);
  if (from === "queue") {
    const n = await acquireSlot(fx, w, project);
    if (n === null) throw conflict("No free coding slot yet.");
    delete w.data.bayReason;
    delete w.data.bayFrom;
    delete w.data.bayAt;
    w.position = "build";
    w.state = "running";
    await enterStation(fx, w, "build", { project, noWip: true });
  } else if (from === "sechold" && !routeGates(fx.catalog, await pinned(fx, w), w.cls).includes("G3G3s")) {
    // Plan and security was switched off (a Factory Admin override) after the hold began: there is no gate left to reopen, so the work order goes on to the next station.
    delete w.data.bayReason;
    delete w.data.bayFrom;
    delete w.data.bayAt;
    w.position = back;
    note(w, fx, by, "The plan and security gate is off, so the work order goes on past it.");
    await advance(fx, w, by);
  } else if (from === "sechold" && w.data.gateChecks && (w.data.gateChecks as Record<string, unknown>).G3G3s) {
    const checks = ((w.data.gateChecks as Record<string, Array<{ name: string; ok: boolean }>>).G3G3s ?? []).map((c) => ({ ...c, ok: true }));
    delete w.data.bayReason;
    delete w.data.bayFrom;
    delete w.data.bayAt;
    w.position = back;
    await openGate(fx, w, "G3G3s", { project, checks, evidence: "person" });
  } else {
    await resumeAt(fx, w, back);
  }
  note(w, fx, by, `Returned from ${bayDef(fx.catalog, from)?.name ?? from}${reason ? `: ${reason}` : ""}.`);
  ev(fx, w, "wo.unpark", { text: reason ?? "", bay: null, from, station: back });
  await saveWo(fx.tx, fx.orgId, w);
}


export async function reassign(tx: Tx, actor: Actor, woId: string, agentId: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.reassign");
  const by = person(actor, "Reassigning is");
  const ag = (await tx.query<{ name: string }>(`select name from agents where org_id = $1 and id = $2`, [fx.orgId, agentId])).rows[0];
  if (!ag) throw invalid("Pick an agent.");
  const sid = stationIdOf(fx.catalog, w);
  const hist = Array.isArray(w.data.history) ? (w.data.history as Array<{ station: string; agent: string; model: string; endedAt: number | null }>) : [];
  const open = hist.slice().reverse().find((h) => !h.endedAt) ?? hist[hist.length - 1];
  const old = open?.agent ?? stationDef(fx.catalog, sid)?.agent ?? "";
  const { modelFor } = await import("./engine.js");
  if (open) {
    open.agent = agentId;
    open.model = await modelFor(tx, fx.orgId, agentId);
  }
  w.data.agentOverride = { ...(typeof w.data.agentOverride === "object" && w.data.agentOverride ? (w.data.agentOverride as object) : {}), [sid]: agentId };
  await tx.query(`update attempts set data = data || $4::jsonb, updated_at = now() where org_id = $1 and wo_id = $2 and station = $3 and state = 'queued'`, [fx.orgId, w.id, sid, JSON.stringify({ agent: agentId })]);
  note(w, fx, by, `Reassigned ${stationDef(fx.catalog, sid)?.name ?? sid} from ${old} to ${ag.name}.`);
  ev(fx, w, "wo.reassign", { station: sid, text: ag.name }, { before: { agent: old } });
  await saveWo(fx.tx, fx.orgId, w);
  return done(fx, `${w.id} now staffed by ${ag.name}. It applies from the next run of the station.`, w.project, { version: w.version, agent: agentId });
}

export interface LimitRaiseIn { limits: Record<string, unknown>; reason?: string | undefined }

/**
 * Retry with a higher limit: the same retry, and the next attempt (only) runs with the raised limits. The raise is recorded on that attempt (attempts.data.limitRaise) and in
 * the audit with who, why and the numbers before and after; the agent and the project are not changed. The caller holds the right to change limits (project.config),
 * decided by the route; a Factory Admin's reason is passed through the pipeline's override and kept in the audit.
 */
export async function retryWithLimits(tx: Tx, actor: Actor, woId: string, raise: LimitRaiseIn): Promise<CmdResult> {
  // A run that reached its cost limit was stopped by the budget halt (cause budget, the run's cap): the raise is recorded for the next attempt and the halt is lifted, which runs the station again.
  const halt = (await tx.query<{ reason: string }>(`select reason from stops where org_id = $1 and scope_type = 'wo' and wo_id = $2 and mode = 'halt' and cause = 'budget' and lifted_at is null`, [actor.orgId, woId])).rows[0];
  if (!halt || capOfReason(halt.reason) !== "run") return retry(tx, actor, woId, raise);
  const { fx, w } = await begin(tx, actor, woId, "wo.sendback", { skipStop: true });
  const by = person(actor, "Retrying is");
  const sid = stationIdOf(fx.catalog, w);
  const prior = await resolvedFor(fx, w, sid);
  const checked = checkRaise(raise.limits, undefined, prior);
  if (checked.costUsd === undefined) throw invalid("This run stopped on its cost limit: raise the cost per run for the next attempt.");
  if (checked.costUsd <= (prior.costUsd ?? 0)) throw invalid(`The run stopped at $${(prior.costUsd ?? 0).toFixed(2)}; ask for more than that.`);
  w.data.limitRaise = { station: sid, limits: checked, by, at: fx.now.getTime(), ...(raise.reason ? { reason: raise.reason } : {}), stoppedOn: "cost" };
  note(w, fx, by, `Raised the cost limit for the next attempt at ${stationDef(fx.catalog, sid)?.name ?? sid} only (${limitsText(checked)}).${raise.reason ? ` ${raise.reason}` : ""}`);
  ev(fx, w, "wo.limit.raise", { station: sid, limits: checked, oneOff: true, boundTo: { station: sid, nextAttemptOnly: true }, stoppedOn: "cost", ...(raise.reason ? { reason: raise.reason } : {}) }, { category: "config", before: prior });
  await saveWo(fx.tx, fx.orgId, w);
  // Raising the run's cap does not raise the work order's or the project's: the run-cap halt is lifted only when nothing else is over (as setWoCap does).
  const over = await overBudget(tx, actor.orgId, woId);
  if (over.length) {
    return { ...done(fx, `Saved the higher cost limit for the next attempt, but ${w.id} stays halted: it is still over ${over.map(overText).join(" and ")}. Raise that cap too; the next attempt then runs with $${checked.costUsd.toFixed(2)} per run.`, w.project, { version: w.version, running: false, heldBy: over.map(overText) }), changes: [...new Set([...fx.changes, "workOrders", "home"])] };
  }
  const lifted = await liftBudgetHalt(tx, actor, woId, `One-off cost limit raise for the next attempt: $${checked.costUsd.toFixed(2)}`);
  // A kill (or another stop) beside the run-cap halt still holds the work order: say so, and leave the raise waiting for the attempt that starts when it is lifted.
  const still = await coveringStop(tx, actor.orgId, w);
  const msg = still ? `Saved the higher cost limit and lifted the run cost halt, but ${w.id} stays stopped (${still.reason || "stopped"}) until that is lifted; the next attempt then runs with $${checked.costUsd.toFixed(2)} per run.` : `${w.id} is running again with a one-off higher cost limit.`;
  return { ...done(fx, msg, w.project, { version: w.version + 1, running: !still }), events: [...fx.events, ...lifted.events], jobs: [...fx.jobs, ...lifted.jobs], changes: [...new Set([...fx.changes, "stops", "workOrders", "floor", "home"])] };
}

const limitsText = (l: Record<string, number>): string => [l.turns !== undefined ? `${l.turns} turns` : "", l.wallClockSeconds !== undefined ? `${Math.round((l.wallClockSeconds / 60) * 10) / 10} minutes` : "", l.costUsd !== undefined ? `$${l.costUsd.toFixed(2)} per run` : ""].filter(Boolean).join(", ");

/** The one-off limits a person asked for: each field in range, and none lower than what the run is bound by now (a retry can only raise); the field that stopped the run must really go up. */
function checkRaise(v: Record<string, unknown>, stopped: { limit?: string; max?: number } | undefined, prior: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const name: Record<string, string> = { turns: "Max turns", wallClockSeconds: "Max time", costUsd: "Max cost per run" };
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || x === null) continue;
    if (k !== "turns" && k !== "wallClockSeconds" && k !== "costUsd") throw invalid(`${k} is not a run limit.`);
    if (!limitInRange(k, x)) throw invalid(limitRangeText(k));
    out[k] = k === "costUsd" ? Math.round(x * 100) / 100 : x;
  }
  if (!Object.keys(out).length) throw invalid("Say which limit to raise for the next attempt.");
  for (const [k, x] of Object.entries(out)) {
    const was = prior[k];
    if (was === undefined) throw invalid("No cost limit applies to this station, so there is nothing to raise. Set one on the agent or the station instead.");
    if (x < was) throw invalid(`${name[k]} would go down from ${was} to ${x}. A retry with a higher limit can only raise limits; leave a field blank to keep it.`);
  }
  if (!Object.entries(out).some(([k, x]) => x > (prior[k] ?? 0))) throw invalid("None of these is higher than the current limits.");
  const field = stopped?.limit === "turns" ? "turns" : stopped?.limit === "time" ? "wallClockSeconds" : null;
  if (field && typeof stopped?.max === "number" && out[field] !== undefined && out[field] <= stopped.max) throw invalid(`The run stopped at ${stopped.max}; ask for more than that.`);
  return out;
}

/** What the station's next run would be bound by with no one-off raise: the audit's "before". */
async function resolvedFor(fx: Fx, w: Wo, sid: string): Promise<Record<string, number>> {
  const agent = String(openEntry(w)?.agent ?? stationDef(fx.catalog, sid)?.agent ?? "");
  const row = agent ? (await fx.tx.query<{ body: Record<string, unknown> | null; data: Record<string, unknown> }>(`select v.body, a.data from agents a left join agent_versions v on v.org_id = a.org_id and v.agent_id = a.id and v.version = a.live_version where a.org_id = $1 and a.id = $2`, [fx.orgId, agent])).rows[0] : undefined;
  const r = await loadRunLimits(fx.tx, { orgId: fx.orgId, projectId: w.project, station: sid, attemptData: {} }, { body: row?.body ?? {}, data: row?.data ?? {}, budgetUsd: row?.body?.budget ?? row?.data.budget });
  return { turns: r.turns, wallClockSeconds: r.wallClockSeconds, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
}

/**
 * A Factory Admin moves a work order that waits for a full station in anyway, with a reason (owner decision 2026-11-19: admin can override everything, audited).
 * The limit is a flow rule, not a safety rail, so it is overridable; stops still apply (a halt needs the usual override, a kill never).
 */
export async function wipOverride(tx: Tx, actor: Actor, woId: string, reason: string): Promise<CmdResult> {
  const adminNow = !!actor.personId && (await tx.query(`select 1 from effective_role_assignments where org_id = $1 and person_id = $2 and role_id = 'factory_admin' and project_id is null and revoked_at is null and (expires_at is null or expires_at > now()) limit 1`, [actor.orgId, actor.personId])).rows.length > 0;
  const { fx, w } = await begin(tx, actor, woId, "wo.move");
  const by = person(actor, "Moving past a station limit is");
  if (!adminNow) throw refuse("denied", "Only a Factory Admin can move a work order past a station's WIP limit.", { rule: { kind: "matrix", id: "wip.override", name: "WIP limit override" } });
  const why = (reason ?? "").trim();
  if (why.length < OVERRIDE_REASON_MIN) throw refuse("denied", `${w.id} waits for a full station. As Factory Admin you can move it in anyway. Give a reason of at least ${OVERRIDE_REASON_MIN} characters; it is recorded in the audit.`, { needs: "override_reason", overrideKind: "wip_limit", rule: { kind: "limit", id: "WIP-LIMIT", name: "Station WIP limit" } });
  const { station } = await overrideWip(fx, w, by, why);
  return done(fx, `${w.id} moved into ${stationDef(fx.catalog, station)?.name ?? station} past its WIP limit.`, w.project, { version: w.version, station });
}

/** Retry a failed or blocked work order: the station runs again as a fresh attempt. */
export async function retry(tx: Tx, actor: Actor, woId: string, raise?: LimitRaiseIn): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.sendback");
  const by = person(actor, "Retrying is");
  const stopped = w.data.limitStop as { limit?: string; max?: number } | undefined;
  // A station that failed (or lost its run) three times is parked in the Needs a person bay: retrying it is what that person is there to decide.
  const failedBay = w.state === "parked" && bayOf(fx.catalog, w) === "person" && w.data.bayCause === "failed";
  // An approved merge that could not happen (the pull request closed, or GitHub still refuses it) waits for a person: Retry merge asks again.
  if (w.state === "parked" && bayOf(fx.catalog, w) === "person" && w.data.bayCause === "merge") {
    if (raise) throw invalid(`Retrying the merge of ${w.id} starts no agent run, so there is no limit to raise. Use Retry merge.`);
    return retryMerge(fx, w, by);
  }
  if (w.state !== "failed" && w.state !== "blocked" && !failedBay) throw invalid(`${w.id} is not failed or blocked.`);
  const sid = stationIdOf(fx.catalog, w);
  const prior = raise ? await resolvedFor(fx, w, sid) : null;
  const checked = raise && prior ? checkRaise(raise.limits, stopped, prior) : null;
  const lim: RetryRaise | undefined = checked && raise ? { limits: checked, ...(prior ? { before: prior } : {}), ...(raise.reason ? { reason: raise.reason } : {}), ...(stopped?.limit ? { stoppedOn: stopped.limit } : {}) } : undefined;
  // The station may be full: the retry then waits (the order stays failed, or in its bay) until a place frees. A one-off raise waits with it, bound to that attempt.
  if (await wipHoldCheck(fx, w, sid, "retry", { by })) {
    if (lim) (w.data.wipWait as Record<string, unknown>).raise = lim;
    await saveWo(fx.tx, fx.orgId, w);
    await dispatchQueued(fx, w.project); // the limit may have moved since the count: a place that is free now is used now
    const live = w.data.wipWait as { live: number; limit: number };
    return done(fx, `${w.id}: ${stationDef(fx.catalog, sid)?.name ?? sid} is full (${live.live}/${live.limit}); the retry waits for a place${lim ? ", with its one-off higher limit" : ""}.`, w.project, { version: w.version, waiting: true });
  }
  fx.wipAdmit = w.id;
  await retryCore(fx, w, by, lim);
  return done(fx, `${w.id} is running again.`, w.project, { version: w.version });
}

/** A one-off limit raise asked with a retry: applied to the attempt the retry starts (also when the retry first waited for a place). */
interface RetryRaise { limits: Record<string, number>; before?: Record<string, number>; reason?: string; stoppedOn?: string }

/** The retry itself (the place at the station is already settled): the station runs again as a fresh attempt. Saves the order. */
export async function retryCore(fx: Fx, w: Wo, by: string, raiseIn?: RetryRaise): Promise<void> {
  const failedBay = w.state === "parked" && bayOf(fx.catalog, w) === "person" && w.data.bayCause === "failed";
  const sid = stationIdOf(fx.catalog, w);
  const lim = raiseIn ?? ((w.data.wipWait as { raise?: RetryRaise } | undefined)?.raise);
  if (failedBay) {
    await leaveBay(fx, w);
    // The person's retry starts the station's failure and interruption counts afresh.
    await fx.tx.query(`update attempts set data = data || '{"streakBroken": true}'::jsonb, updated_at = now() where org_id = $1 and wo_id = $2 and station = $3 and (state = 'failed' or outcome in ('interrupted','lease_expired'))`, [fx.orgId, w.id, sid]);
  }
  await cancelAttempts(fx, w, "retried");
  const gs = (w.data.gateStatus ??= {}) as Record<string, string>;
  for (const k of Object.keys(gs)) if (gs[k] === "failed") delete gs[k];
  w.data.gateChecks = {};
  const sname = stationDef(fx.catalog, sid)?.name ?? sid;
  if (lim) {
    w.data.limitRaise = { station: sid, limits: lim.limits, by, at: fx.now.getTime(), ...(lim.reason ? { reason: lim.reason } : {}), ...(lim.stoppedOn ? { stoppedOn: lim.stoppedOn } : {}) };
    note(w, fx, by, `Retried ${sname} with a one-off higher limit (${limitsText(lim.limits)}).${lim.reason ? ` ${lim.reason}` : ""}`);
    ev(fx, w, "wo.limit.raise", { station: sid, limits: lim.limits, oneOff: true, boundTo: { station: sid, nextAttemptOnly: true }, ...(lim.reason ? { reason: lim.reason } : {}), ...(lim.stoppedOn ? { stoppedOn: lim.stoppedOn } : {}) }, { category: "config", before: lim.before ?? {} });
  } else note(w, fx, by, `Retried ${sname}.`);
  await enterStation(fx, w, sid);
  ev(fx, w, "wo.retry", { station: sid, ...(lim ? { limits: lim.limits } : {}) });
  await saveWo(fx.tx, fx.orgId, w);
}

/**
 * Retry merge: the same approved head is merged again. Never a new approval and never another commit: when the pull request is closed or its head moved since the
 * approval, there is nothing approved to merge, and the person is told to reopen it on GitHub or return the work order to Review.
 */
async function retryMerge(fx: Fx, w: Wo, by: string): Promise<CmdResult> {
  const merging = (w.data.merging ?? {}) as { prNumber?: number; headSha?: string };
  if (!merging.prNumber || !merging.headSha) throw conflict(`${w.id} has no approved merge to retry. Return it to Review instead.`);
  const pr = (await fx.tx.query<{ state: string; head_sha: string | null }>(`select state, head_sha from pull_requests where org_id = $1 and wo_id = $2 and number = $3`, [fx.orgId, w.id, merging.prNumber])).rows[0];
  if (!pr || pr.state !== "open") throw conflict(`Pull request #${merging.prNumber} is not open, so there is nothing to merge. Reopen it on GitHub and retry, or return ${w.id} to Review.`);
  if (pr.head_sha !== merging.headSha) throw conflict(`Pull request #${merging.prNumber} changed after it was approved. Return ${w.id} to Review so the new commit is approved.`);
  // The merge has not happened yet, so the order needs a place at its station again: a full station keeps it in its bay.
  const station = String(w.data.bayFrom ?? "review");
  if (await wipHoldCheck(fx, w, station, "merge", { by })) {
    await saveWo(fx.tx, fx.orgId, w);
    await dispatchQueued(fx, w.project);
    const live = w.data.wipWait as { live: number; limit: number };
    return done(fx, `${w.id}: ${stationDef(fx.catalog, station)?.name ?? station} is full (${live.live}/${live.limit}); the merge is asked again when a place frees.`, w.project, { version: w.version, waiting: true });
  }
  fx.wipAdmit = w.id;
  await retryMergeCore(fx, w, by);
  return done(fx, `${w.id}: merging #${merging.prNumber} again.`, w.project, { version: w.version });
}

/** The merge request again (the place at the station is already settled). Saves the order. */
export async function retryMergeCore(fx: Fx, w: Wo, by: string): Promise<void> {
  const merging = (w.data.merging ?? {}) as { prNumber?: number; headSha?: string };
  if (!merging.prNumber || !merging.headSha) throw conflict(`${w.id} has no approved merge to retry. Return it to Review instead.`);
  await leaveBay(fx, w);
  w.position = String(w.data.bayFrom ?? "review");
  for (const k of ["bayReason", "bayFrom", "bayAt", "bayCause"]) delete w.data[k];
  w.state = "waiting";
  w.data.blockReason = `Merging pull request #${merging.prNumber}.`;
  const { job } = await import("../../core/jobs-contract.js");
  fx.jobs.push(job("merge.request", { woId: w.id, prNumber: merging.prNumber, headSha: merging.headSha }, { dedupeKey: `merge:${w.id}:${merging.prNumber}:${merging.headSha}:retry:${fx.now.getTime()}` }));
  note(w, fx, by, `Retried the merge of #${merging.prNumber} at ${merging.headSha.slice(0, 7)}.`);
  ev(fx, w, "wo.retry", { station: w.position, text: `merge #${merging.prNumber}` });
  await saveWo(fx.tx, fx.orgId, w);
}

/** `PUT .../record/summary`: the person-written summary on the record (legacy `setRecordSummary`; the right is wo.answer). */
export async function setRecordSummary(tx: Tx, actor: Actor, woId: string, text: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.answer", { allowClosed: true });
  const by = person(actor, "The record summary is");
  if (!text || text.trim().length < 10) throw invalid("Write at least a sentence.");
  const before = (w.data.recordSummary as { text?: string } | undefined)?.text ?? null;
  w.data.recordSummary = { text: text.trim(), by, at: fx.now.getTime() };
  ev(fx, w, "record.summary", { text: text.trim().slice(0, 8000) }, { before: { text: before } });
  await saveWo(fx.tx, fx.orgId, w);
  return done(fx, `Summary saved on ${w.id}.`, w.project, { version: w.version });
}

void arriveAtGate;
