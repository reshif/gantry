/**
 * The station-execution side of the flow engine (spec 9.1 F3 and F9, 10.3). The worker calls these inside its own transaction:
 *   applyStationResult  a station's structured result is applied, rejected when its attempt was superseded (F3)
 *   expireLeases        attempts whose lease lapsed get a bounded retry, then "Needs a person" (F9)
 *   recordMerged        the GitHub broker merged the pull request: the work order moves on
 *   recordNewHead       a new head commit closes the open gate instance and reopens it on the new head
 *   handleFlowTimer     escalation timers (paused while a halt covers the work order)
 * Each flushes its events and jobs with `flushFx` (actor "system"), so the caller only commits.
 */
import { stationDef } from "@gantry/domain";
import { schedule, type Tx } from "@gantry/db";
import { flushFx, attemptIsCurrent, arriveAtGate, bayOf, cancelAttempts, closeEntry, closeOpenInstances, advance, coveringStop, enterBay, enterStation, ev, loadOne, note, openGate, openInstanceOf, releaseSlot, startAttempt, stationIdOf, dispatchQueued, type Fx } from "./engine.js";
import { readCatalog, readOrg } from "../../core/read/index.js";
import { lockWo, saveWo, type Wo } from "./model.js";
import { saveConversation } from "./conversation.js";

export interface ObservedChecks { name: string; ok: boolean; warn?: boolean; note?: string }
export interface StationResult {
  status: "succeeded" | "failed" | "interrupted" | "needs_person";
  summary?: string;
  /** The station's structured output (spec 10.3). Agent-reported. */
  output?: Record<string, unknown> | null;
  error?: { code: string; msg: string } | null;
  usage?: { tokens?: number; costUsd?: number };
  /** System-observed values from GitHub and the edge. They win over the agent's report. */
  observed?: { checks?: ObservedChecks[]; files?: Array<{ path: string; additions?: number; deletions?: number }>; headSha?: string | null; tests?: { passed: number; failed: number; added: number } };
}

export type ApplyOutcome = { applied: true; woId: string; station: string; next: string } | { applied: false; code: "superseded" | "unknown" | "stopped"; reason: string; woId?: string };

/** After this many failed or interrupted attempts at one station the work order goes to "Needs a person" (spec 9.8). */
export const MAX_STATION_FAILURES = 3;

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function fxFor(tx: Tx, orgId: string, actor: string, now: Date): Promise<Fx> {
  return { tx, orgId, now, actor, catalog: await readCatalog(tx, orgId, await readOrg(tx, orgId)), events: [], jobs: [], changes: new Set(["workOrders", "floor", "home", "audit"]) };
}

async function addUsage(w: Wo, r: StationResult): Promise<void> {
  const h = Array.isArray(w.data.history) ? (w.data.history as Array<{ endedAt: number | null; tokens: number; cost: number }>) : [];
  const e = h.slice().reverse().find((x) => !x.endedAt) ?? h[h.length - 1];
  if (e && r.usage) {
    e.tokens += Number(r.usage.tokens) || 0;
    e.cost += Number(r.usage.costUsd) || 0;
  }
}

/** Folds the structured output of a station into the work order record (the labelled outputs per station). System-observed values replace what the agent reported. */
function absorbOutput(w: Wo, station: string, r: StationResult): { checks: ObservedChecks[] | undefined; headSha: string | null | undefined } {
  const out = asObj(r.output);
  (w.data.outputs ??= {})[station] = { ...out, _labels: { agentReported: Object.keys(out), systemObserved: Object.keys(r.observed ?? {}) } };
  const brief = (w.data.brief ??= {}) as Record<string, unknown>;
  if (station === "spec") {
    if (typeof out.goal === "string") brief.goal = out.goal;
    if (Array.isArray(out.scopeIn)) brief.scopeIn = strs(out.scopeIn);
    if (Array.isArray(out.scopeOut)) brief.scopeOut = strs(out.scopeOut);
    if (Array.isArray(out.acceptanceCriteria ?? out.ac)) brief.ac = strs(out.acceptanceCriteria ?? out.ac);
  }
  if (station === "plan" && Array.isArray(out.children)) brief.children = strs(out.children);
  if (station === "build" || r.observed?.files) {
    const files = r.observed?.files ?? (Array.isArray(out.files) ? (out.files as Array<{ path: string; additions?: number; deletions?: number }>).filter((f) => f && typeof f.path === "string") : []);
    if (files.length) {
      w.data.files = files.map((f) => ({ path: f.path, plus: Number(f.additions) || 0, minus: Number(f.deletions) || 0 }));
      w.data.paths = [...new Set([...(Array.isArray(w.data.paths) ? (w.data.paths as string[]) : []), ...files.map((f) => f.path)])];
      w.data.diff = { plus: files.reduce((a, f) => a + (Number(f.additions) || 0), 0), minus: files.reduce((a, f) => a + (Number(f.deletions) || 0), 0), files: files.length };
    }
  }
  const tests = r.observed?.tests ?? (out.tests && typeof out.tests === "object" ? (out.tests as { passed: number; failed: number; added: number }) : null);
  if (tests) w.data.tests = { passed: Number(tests.passed) || 0, failed: Number(tests.failed) || 0, added: Number(tests.added) || 0 };
  const checks = r.observed?.checks ?? (Array.isArray(out.checks) ? (out.checks as ObservedChecks[]).filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name, ok: c.ok !== false, ...(c.warn ? { warn: true } : {}) })) : undefined);
  return { checks, headSha: r.observed?.headSha ?? (typeof out.headSha === "string" ? out.headSha : undefined) };
}

async function failCount(tx: Tx, orgId: string, woId: string, station: string): Promise<number> {
  return Number((await tx.query(`select count(*)::int as n from attempts where org_id = $1 and wo_id = $2 and station = $3 and state = 'failed' and (data->>'streakBroken') is null`, [orgId, woId, station])).rows[0].n);
}

async function needsPerson(fx: Fx, w: Wo, reason: string): Promise<void> {
  const from = stationIdOf(fx.catalog, w);
  w.data.bayFrom = from;
  w.data.bayReason = reason;
  w.data.bayAt = fx.now.getTime();
  w.position = "person";
  w.state = "parked";
  await releaseSlot(fx, w);
  await enterBay(fx, w, "person", reason);
  note(w, fx, "system", reason);
  ev(fx, w, "wo.bay", { bay: "person", from: null, station: from, text: reason });
}

/**
 * Applies a station's result (spec 9.4 "complete station"): rejects a superseded attempt (F3: a second attempt, a stop's higher fencing number, a send-back), otherwise records the output,
 * closes the history entry and opens the gate behind the station or advances. Safe to call twice: the second call finds the attempt already finished and is rejected.
 */
export async function applyStationResult(tx: Tx, attemptId: string, fencing: number, result: StationResult, o: { now?: Date; actor?: string } = {}): Promise<ApplyOutcome> {
  const now = o.now ?? new Date();
  const found = (await tx.query<{ org_id: string; wo_id: string; station: string }>(`select org_id, wo_id, station from attempts where id = $1 and fencing = $2`, [attemptId, fencing])).rows[0];
  if (!found) {
    const any = (await tx.query<{ wo_id: string }>(`select wo_id from attempts where id = $1`, [attemptId])).rows[0];
    return { applied: false, code: any ? "superseded" : "unknown", reason: any ? "That attempt was superseded (fencing number differs)." : "No such attempt.", ...(any ? { woId: any.wo_id } : {}) };
  }
  const orgId = found.org_id;
  const w = await lockWo(tx, orgId, found.wo_id);
  const cur = await attemptIsCurrent(tx, orgId, attemptId, fencing);
  const fx = await fxFor(tx, orgId, o.actor ?? "system", now);
  if (!cur.current) {
    ev(fx, w, "run.result.rejected", { station: found.station, attempt: attemptId, text: cur.reason }, { outcome: "denied" });
    await flushFx(fx);
    return { applied: false, code: cur.reason.startsWith("A stop") ? "stopped" : "superseded", reason: cur.reason, woId: w.id };
  }
  const sid = found.station;
  const finalState = result.status === "succeeded" ? "succeeded" : result.status === "failed" ? "failed" : "cancelled";
  await tx.query(`update attempts set state = $3, outcome = $4, ended_at = $5, lease_until = null, updated_at = now(), version = version + 1 where org_id = $1 and id = $2`, [orgId, attemptId, finalState, result.status, now]);
  await addUsage(w, result);
  fx.actor = ((await tx.query<{ data: Record<string, unknown> }>(`select data from attempts where org_id = $1 and id = $2`, [orgId, attemptId])).rows[0]?.data.agent as string | undefined) ?? "system";
  const project = (await import("./engine.js")).pinned;
  const p = await project(fx, w);
  let next = "";
  if (result.status === "succeeded") {
    const { checks, headSha } = absorbOutput(w, sid, result);
    closeEntry(w, fx, "passed", result.summary ?? "");
    w.data.progress = 100;
    note(w, fx, fx.actor, result.summary ? `${stationDef(fx.catalog, sid)?.name ?? sid} finished: ${result.summary.slice(0, 200)}` : `${stationDef(fx.catalog, sid)?.name ?? sid} finished.`);
    ev(fx, w, "wo.station.done", { station: sid, attempt: attemptId, text: result.summary ?? "" });
    await arriveAtGate(fx, w, fx.actor, { project: p, ...(checks ? { checks } : {}), ...(headSha !== undefined ? { headSha } : {}) });
    next = bayOf(fx.catalog, w) ?? stationIdOf(fx.catalog, w);
  } else if (result.status === "needs_person") {
    closeEntry(w, fx, "question");
    const q = typeof asObj(result.output).question === "string" ? String(asObj(result.output).question) : result.summary ?? "The agent needs a decision.";
    const conv = (await loadOne(fx, w)).conv;
    const c2 = structuredClone(conv);
    c2.raised.push({ station: sid, text: q, at: now.getTime(), answered: false });
    c2.messages.push({ from: fx.actor, at: now.getTime(), text: q });
    await saveConversation(fx, w.id, c2, conv.messages.length, "open");
    await needsPerson(fx, w, `Question raised at ${stationDef(fx.catalog, sid)?.name ?? sid}`);
    next = "person";
  } else {
    closeEntry(w, fx, result.status === "failed" ? "failed" : "interrupted", result.error?.msg ?? result.summary ?? "");
    const n = await failCount(tx, orgId, w.id, sid);
    if (result.status === "failed" && n < MAX_STATION_FAILURES) {
      w.state = "failed";
      w.data.failReason = result.error?.msg ?? `${stationDef(fx.catalog, sid)?.name ?? sid} failed.`;
      ev(fx, w, "wo.state", { from: "running", to: "failed", station: sid, text: String(w.data.failReason) });
      next = sid;
    } else if (result.status === "interrupted" && (await interruptions(tx, orgId, w.id, sid)) < MAX_STATION_FAILURES) {
      await enterStation(fx, w, sid);
      next = sid;
    } else {
      await needsPerson(fx, w, `${stationDef(fx.catalog, sid)?.name ?? sid} ${result.status === "failed" ? "failed" : "was interrupted"} ${MAX_STATION_FAILURES} times; a person needs to look.`);
      next = "person";
    }
  }
  await saveWo(tx, orgId, w);
  await flushFx(fx);
  await dispatchQueued(fx, w.project);
  await flushFx(fx);
  return { applied: true, woId: w.id, station: sid, next };
}

async function interruptions(tx: Tx, orgId: string, woId: string, station: string): Promise<number> {
  return Number((await tx.query(`select count(*)::int as n from attempts where org_id = $1 and wo_id = $2 and station = $3 and outcome in ('interrupted','lease_expired')`, [orgId, woId, station])).rows[0].n);
}

/** F9: a run whose lease lapsed is retried as a fresh attempt, up to a bound, then the work order goes to "Needs a person". Returns the attempts handled. */
export async function expireLeases(tx: Tx, o: { now?: Date; limit?: number } = {}): Promise<string[]> {
  const now = o.now ?? new Date();
  const { rows } = await tx.query<{ org_id: string; id: string; wo_id: string; station: string }>(
    `select org_id, id, wo_id, station from attempts where state = 'running' and lease_until < $1 order by lease_until limit $2 for update skip locked`, [now, o.limit ?? 50],
  );
  const handled: string[] = [];
  for (const a of rows) {
    const w = await lockWo(tx, a.org_id, a.wo_id);
    const cur = (await tx.query<{ state: string; lease_until: Date | null }>(`select state, lease_until from attempts where org_id = $1 and id = $2`, [a.org_id, a.id])).rows[0];
    if (cur?.state !== "running" || !cur.lease_until || cur.lease_until >= now) continue;
    const fx = await fxFor(tx, a.org_id, "system", now);
    await tx.query(`update attempts set state = 'failed', outcome = 'lease_expired', ended_at = $3, lease_until = null, updated_at = now(), version = version + 1 where org_id = $1 and id = $2`, [a.org_id, a.id, now]);
    await (await import("../internal/tokens.js")).revokeRunTokens(tx, { orgId: a.org_id, woId: w.id, reason: "lease expired" });
    closeEntry(w, fx, "lost", "The run stopped heartbeating.");
    ev(fx, w, "run.lease_expired", { station: a.station, attempt: a.id, text: "The run stopped heartbeating." }, { outcome: "failed" });
    if (await coveringStop(tx, a.org_id, w)) {
      // A stop covers it: the run was torn down on purpose. Resume starts a fresh attempt.
    } else if ((await interruptions(tx, a.org_id, w.id, a.station)) < MAX_STATION_FAILURES) {
      await enterStation(fx, w, a.station);
    } else {
      await needsPerson(fx, w, `${stationDef(fx.catalog, a.station)?.name ?? a.station} lost its run ${MAX_STATION_FAILURES} times; a person needs to look.`);
    }
    await saveWo(tx, a.org_id, w);
    await flushFx(fx);
    handled.push(a.id);
  }
  return handled;
}

/** The broker merged the pull request at the approved head: the work order moves on from the merge gate. Idempotent. */
export async function recordMerged(tx: Tx, orgId: string, woId: string, o: { prNumber: number; mergeSha?: string; now?: Date }): Promise<{ applied: boolean; reason?: string }> {
  const w = await lockWo(tx, orgId, woId);
  const merging = asObj(w.data.merging);
  if (merging.prNumber !== o.prNumber) return { applied: false, reason: "No merge was waiting for that pull request." };
  const fx = await fxFor(tx, orgId, "system", o.now ?? new Date());
  delete w.data.merging;
  w.data.blockReason = null;
  note(w, fx, "system", `Pull request #${o.prNumber} merged${o.mergeSha ? ` at ${o.mergeSha.slice(0, 7)}` : ""}.`);
  ev(fx, w, "wo.merged", { text: `#${o.prNumber}` }, { category: "flow" });
  await advance(fx, w, "system");
  await saveWo(tx, orgId, w);
  await flushFx(fx);
  return { applied: true };
}

/** A new head commit on the pull request closes the open gate instance (spec 9.5) and, when the work order was waiting at a human gate, opens a fresh one on the new head. */
export async function recordNewHead(tx: Tx, orgId: string, woId: string, headSha: string, o: { now?: Date } = {}): Promise<{ reopened: string | null }> {
  const w = await lockWo(tx, orgId, woId);
  const fx = await fxFor(tx, orgId, "system", o.now ?? new Date());
  const open = (await tx.query<{ gate_id: string; head_sha: string | null }>(`select gate_id, head_sha from gate_instances where org_id = $1 and wo_id = $2 and status = 'open'`, [orgId, woId])).rows;
  const stale = open.filter((i) => i.head_sha !== headSha);
  if (!stale.length) return { reopened: null };
  await closeOpenInstances(fx, woId, "new_head");
  const gate = stale[0]!.gate_id;
  if (gate === "G0G1") return { reopened: null };
  await openGate(fx, w, gate, { headSha });
  ev(fx, w, "gate.reopened", { gate, text: `New head commit ${headSha.slice(0, 7)}` }, { category: "approvals" });
  await saveWo(tx, orgId, w);
  await flushFx(fx);
  return { reopened: gate };
}

/** `flow.timer` jobs. Escalation: the open gate instance gets an escalation event (the worker's notifier turns it into a message); a halt pauses it by pushing the timer back. */
export async function handleFlowTimer(tx: Tx, p: { kind: "escalation" | "soak" | "lease_expiry"; woId?: string; gateInstanceId?: string }, o: { now?: Date } = {}): Promise<{ handled: boolean; note: string }> {
  const now = o.now ?? new Date();
  if (p.kind === "lease_expiry") return { handled: true, note: `${(await expireLeases(tx, { now })).length} attempts expired` };
  if (p.kind !== "escalation" || !p.woId || !p.gateInstanceId) return { handled: false, note: "nothing to do" };
  const row = (await tx.query<{ org_id: string }>(`select org_id from work_orders where id = $1`, [p.woId])).rows[0];
  if (!row) return { handled: false, note: "no such work order" };
  const w = await lockWo(tx, row.org_id, p.woId);
  const inst = (await tx.query<{ id: string; gate_id: string; status: string; basis: Record<string, unknown> }>(`select id, gate_id, status, basis from gate_instances where org_id = $1 and id = $2 for update`, [row.org_id, p.gateInstanceId])).rows[0];
  if (!inst || inst.status !== "open") return { handled: false, note: "the gate was already decided" };
  const fx = await fxFor(tx, row.org_id, "system", now);
  const stop = await coveringStop(tx, row.org_id, w);
  if (stop) {
    await schedule(tx, { orgId: row.org_id, kind: "flow.timer", fireAt: new Date(now.getTime() + 15 * 60_000), subject: inst.id, dedupeKey: `escalation:${inst.id}`, payload: p });
    return { handled: true, note: `paused by ${stop.scope} ${stop.mode}` };
  }
  if (inst.basis.escalated) return { handled: true, note: "already escalated" };
  await tx.query(`update gate_instances set basis = basis || '{"escalated": true}'::jsonb, updated_at = now() where org_id = $1 and id = $2`, [row.org_id, inst.id]);
  note(w, fx, "system", `Escalated: ${inst.gate_id} has waited past its limit.`);
  ev(fx, w, "gate.escalated", { gate: inst.gate_id, instance: inst.id, text: "Waited past the escalation limit" }, { category: "approvals" });
  await saveWo(tx, row.org_id, w);
  await flushFx(fx);
  return { handled: true, note: "escalated" };
}

void [openInstanceOf, cancelAttempts, startAttempt];
