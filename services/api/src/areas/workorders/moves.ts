/** Board and traveler moves: move (one step along the route), send back, park, unpark, reassign, retry and the record summary (spec 9.4, 9.6). */
import { bayDef, can, gateForWO, moveCheck, nextStationId, route, stationDef, type MoveCheck, type Project } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor } from "../../core/command.js";
import { conflict, invalid, refuse } from "../../core/errors.js";
import {
  acquireSlot, arriveAtGate, bayOf, cancelAttempts, closeEntry, closeOpenInstances, dispatchQueued, enterStation, ev, leaveBay, note, openGate, projectOf, resetGatesFrom, stationIdOf, type Fx,
} from "./engine.js";
import { begin, done, flowFor, person, type CmdResult } from "./ctx.js";
import { approveInner } from "./gates.js";
import { declineInner, parkInto, resumeAt } from "./intake.js";
import { saveWo, type Wo } from "./model.js";

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
  await closeOpenInstances(fx, w.id, "send_back");
  await resetGatesFrom(fx, w, project, to);
  await enterStation(fx, w, to, { project });
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
    await enterStation(fx, w, "build", { project });
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
  return done(fx, `${w.id} is back at ${stationDef(fx.catalog, stationIdOf(fx.catalog, w))?.name ?? back}.`, w.project, { version: w.version });
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

/** Retry a failed or blocked work order: the station runs again as a fresh attempt. */
export async function retry(tx: Tx, actor: Actor, woId: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.sendback");
  const by = person(actor, "Retrying is");
  // A station that failed (or lost its run) three times is parked in the Needs a person bay: retrying it is what that person is there to decide.
  const failedBay = w.state === "parked" && bayOf(fx.catalog, w) === "person" && w.data.bayCause === "failed";
  // An approved merge that could not happen (the pull request closed, or GitHub still refuses it) waits for a person: Retry merge asks again.
  if (w.state === "parked" && bayOf(fx.catalog, w) === "person" && w.data.bayCause === "merge") return retryMerge(fx, w, by);
  if (w.state !== "failed" && w.state !== "blocked" && !failedBay) throw invalid(`${w.id} is not failed or blocked.`);
  const sid = stationIdOf(fx.catalog, w);
  if (failedBay) {
    await leaveBay(fx, w);
    // The person's retry starts the station's failure and interruption counts afresh.
    await fx.tx.query(`update attempts set data = data || '{"streakBroken": true}'::jsonb, updated_at = now() where org_id = $1 and wo_id = $2 and station = $3 and (state = 'failed' or outcome in ('interrupted','lease_expired'))`, [fx.orgId, w.id, sid]);
  }
  await cancelAttempts(fx, w, "retried");
  const gs = (w.data.gateStatus ??= {}) as Record<string, string>;
  for (const k of Object.keys(gs)) if (gs[k] === "failed") delete gs[k];
  w.data.gateChecks = {};
  note(w, fx, by, `Retried ${stationDef(fx.catalog, sid)?.name ?? sid}.`);
  await enterStation(fx, w, sid);
  ev(fx, w, "wo.retry", { station: sid });
  await saveWo(fx.tx, fx.orgId, w);
  return done(fx, `${w.id} is running again.`, w.project, { version: w.version });
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
  return done(fx, `${w.id}: merging #${merging.prNumber} again.`, w.project, { version: w.version });
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
