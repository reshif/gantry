/**
 * The station-execution side of the flow engine (spec 9.1 F3 and F9, 10.3). The worker calls these inside its own transaction:
 *   applyStationResult  a station's structured result is applied, rejected when its attempt was superseded (F3)
 *   expireLeases        attempts whose lease lapsed get a bounded retry, then "Needs a person" (F9)
 *   recordMerged        the GitHub broker merged the pull request: the work order moves on
 *   recordNewHead       a new head commit closes the open gate instance and reopens it on the new head
 *   handleFlowTimer     escalation timers (paused while a halt covers the work order)
 * Each flushes its events and jobs with `flushFx` (actor "system"), so the caller only commits.
 */
import { limitStopOf } from "./limit-stop.js";
import { can, evaluateGuardrails, stationDef } from "@gantry/domain";
import { flowFor } from "./ctx.js";
import { schedule, type Tx } from "@gantry/db";
import { flushFx, attemptIsCurrent, arriveAtGate, bayOf, cancelAttempts, closeEntry, closeOpenInstances, advance, coveringStop, enterBay, enterStation, ev, leaveBay, loadOne, note, openGate, openInstanceOf, releaseSlot, startAttempt, stationIdOf, dispatchQueued, wipHoldCheck, wipLive, wipLimitOf, projectOf, type Fx } from "./engine.js";
import { readCatalog, readOrg } from "../../core/read/index.js";
import { lockWo, saveWo, type Wo } from "./model.js";
import { ensureStationDocument } from "./station-docs.js";
import { recordDialogue, type QuestionRow } from "./documents.js";
import type { ResearchPlan } from "./research.js";
import { applyScoutResult, scoutRequest, startSwarm } from "./swarm.js";
import { addWoMessage, updateId } from "./session/store.js";
import { isResearchHost } from "../../core/research-host.js";
import { enforceReview, parseReview, queueDescribe, reviewOf } from "./review.js";

/** The whole summary goes in the thread (lists truncate their own previews); the cap only guards against a runaway output. */
const clip = (t: string): string => (t.length > 8000 ? `${t.slice(0, 8000)}…` : t);

export interface ObservedChecks { name: string; ok: boolean; warn?: boolean; note?: string }
export interface StationResult {
  status: "succeeded" | "failed" | "interrupted" | "needs_person";
  summary?: string;
  /** The station's structured output (spec 10.3). Agent-reported. */
  output?: Record<string, unknown> | null;
  error?: { code: string; msg: string; /** "start": the run never started (seeding, launcher, no model). */ phase?: "start" } | null;
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
function absorbOutput(w: Wo, station: string, r: StationResult, o: { attempt: string; now: Date }): { checks: ObservedChecks[] | undefined; headSha: string | null | undefined } {
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
  // Review's verdict, per-criterion results, findings and PR description (agent-reported, labelled): enforced after the result is applied.
  if (station === "review") w.data.review = parseReview(out, { attempt: o.attempt, headSha: r.observed?.headSha ?? (typeof out.headSha === "string" ? out.headSha : null), now: o.now.getTime() });
  // The recorded diff is what the platform saw in the published commits. A Build's own `files` list is shown as its report (outputs) but never becomes the stats.
  {
    const files = r.observed?.files ?? [];
    if (files.length) {
      w.data.files = files.map((f) => ({ path: f.path, plus: Number(f.additions) || 0, minus: Number(f.deletions) || 0 }));
      w.data.paths = [...new Set([...(Array.isArray(w.data.paths) ? (w.data.paths as string[]) : []), ...files.map((f) => f.path)])];
      w.data.diff = { plus: files.reduce((a, f) => a + (Number(f.additions) || 0), 0), minus: files.reduce((a, f) => a + (Number(f.deletions) || 0), 0), files: files.length };
    }
  }
  // Verify's report: the per-criterion verdicts and the test runs are kept (agent-reported, labelled) so the record shows them. Counts come from the platform's
  // observation when there is one, else the agent's own `tests`, else the runs it listed (a pass and a fail each count once; a flaky run counts as neither).
  if (station === "verify") {
    const criteria = (Array.isArray(out.criteria) ? out.criteria : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x) => ({ criterion: String(x.criterion ?? ""), result: String(x.result ?? "untested"), evidence: String(x.evidence ?? "") }));
    const testsRun = (Array.isArray(out.testsRun) ? out.testsRun : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x) => ({ name: String(x.name ?? ""), command: String(x.command ?? ""), result: String(x.result ?? ""), ...(Number.isFinite(Number(x.ms)) && x.ms !== undefined && x.ms !== null ? { ms: Number(x.ms) } : {}) }));
    const observedFailed = r.observed?.tests ? Number(r.observed.tests.failed) || 0 : undefined;
    w.data.verification = { criteria, testsRun, ...(observedFailed !== undefined ? { observedFailed } : {}) };
  }
  const runs = station === "verify" && Array.isArray((w.data.verification as { testsRun?: unknown[] } | undefined)?.testsRun) ? ((w.data.verification as { testsRun: Array<{ result: string }> }).testsRun) : [];
  const fromRuns = runs.length ? { passed: runs.filter((t) => t.result === "pass").length, failed: runs.filter((t) => t.result === "fail").length, added: 0 } : null;
  const tests = r.observed?.tests ?? (out.tests && typeof out.tests === "object" ? (out.tests as { passed: number; failed: number; added: number }) : fromRuns);
  if (tests) w.data.tests = { passed: Number(tests.passed) || 0, failed: Number(tests.failed) || 0, added: Number(tests.added) || 0 };
  // Gate checks are system evidence only (worker-observed, or GitHub check runs read when the gate opens). An agent's own `output.checks` is shown but never judged.
  const checks = r.observed?.checks;
  return { checks, headSha: r.observed?.headSha ?? (typeof out.headSha === "string" ? out.headSha : undefined) };
}

/**
 * Spec 13.3 guardrails, judged in code from the files the system saw (the worker's observed list, else the recorded diff): the agent's forbidden paths
 * and `maxDiff`, and the repository's protected paths. The result lands on `w.data.guardrail`, which the gate reads (a breach needs a person and
 * demotes the cell). The prompt telling an agent about its guardrails is advice; this is the check.
 */
async function recordGuardrail(tx: Tx, orgId: string, w: Wo, agentId: string): Promise<void> {
  const files = (Array.isArray(w.data.files) ? (w.data.files as Array<{ path: string; plus?: number; minus?: number }>) : []).filter((f) => f && typeof f.path === "string");
  if (!files.length) return;
  const gr = ((await tx.query<{ g: { paths?: unknown; maxDiff?: unknown } | null }>(`select data->'guardrails' as g from agents where org_id = $1 and id = $2`, [orgId, agentId])).rows[0]?.g ?? {}) as { paths?: unknown; maxDiff?: unknown };
  const prot = (await tx.query<{ p: string[] | null }>(`select c.protected_paths as p from work_orders w join repo_config c on c.org_id = w.org_id and c.repo_id = w.repo_id where w.org_id = $1 and w.id = $2`, [orgId, w.id])).rows[0]?.p ?? [];
  const found = evaluateGuardrails(files, { forbidden: strs(gr.paths), protectedPaths: prot, maxDiff: Number(gr.maxDiff) || 0 });
  w.data.guardrail = found;
}

/**
 * The station's own message in the work order's session: what it said, the documents it wrote and the questions it asked (as cards that read their
 * live state). Posted once per attempt; the event scan then leaves this attempt's "finished" line out.
 */
/** A research plan the run proposed (output.researchPlan from the station tools), re-checked here. */
function proposedPlan(raw: unknown, station: string, attempt: string, now: Date): ResearchPlan | null {
  const p = asObj(raw);
  const questions = strs(p.questions).map((q) => q.trim().slice(0, 300)).filter(Boolean).slice(0, 12);
  if (!questions.length || typeof p.web !== "boolean") return null;
  const hosts = p.web ? strs(p.hosts).map((h) => h.trim().toLowerCase()).filter(isResearchHost).slice(0, 20) : [];
  const budget = typeof p.budgetUsd === "number" && p.budgetUsd > 0 ? Math.min(p.budgetUsd, 100) : null;
  return { status: "proposed", questions, hosts, web: p.web, budgetUsd: budget, why: typeof p.why === "string" ? p.why.slice(0, 1200) : "", station, attempt, proposedAt: now.getTime() };
}

async function postStationMessage(fx: Fx, w: Wo, station: string, attemptId: string, text: string, questions: QuestionRow[], assumptions = 0, plan = false): Promise<void> {
  const docs = (await fx.tx.query<{ id: string; doc: string; version: number }>(`select id, doc, version from artefacts where org_id = $1 and wo_id = $2 and attempt_id = $3 and doc is not null order by doc`, [fx.orgId, w.id, attemptId])).rows;
  const objs = (await fx.tx.query<{ id: string }>(`select id from wo_objections where org_id = $1 and wo_id = $2 and attempt_id = $3 order by id`, [fx.orgId, w.id, attemptId])).rows;
  if (!docs.length && !questions.length && !assumptions && !plan && !objs.length) return;
  const id = updateId(fx.orgId, w.id, `station:${attemptId}`);
  if ((await fx.tx.query(`select 1 from workorder_messages where org_id = $1 and id = $2`, [fx.orgId, id])).rowCount) return;
  const cards = [
    ...(plan ? [{ kind: "research_plan" as const, station }] : []),
    ...docs.map((d) => ({ kind: "document" as const, id: d.id, name: d.doc, version: d.version })),
    ...questions.map((q) => ({ kind: "station_question" as const, id: q.id })),
    ...objs.map((o) => ({ kind: "objection" as const, id: o.id })),
    ...(assumptions ? [{ kind: "assumptions" as const, station, attempt: attemptId, count: assumptions }] : []),
  ];
  await addWoMessage(fx.tx, fx.orgId, w.id, "assistant", fx.actor, text, { kind: "station", station, mode: "agent", agent: fx.actor, cards }, fx.now, id);
}

async function failCount(tx: Tx, orgId: string, woId: string, station: string): Promise<number> {
  return Number((await tx.query(`select count(*)::int as n from attempts where org_id = $1 and wo_id = $2 and station = $3 and state = 'failed' and (data->>'streakBroken') is null`, [orgId, woId, station])).rows[0].n);
}

async function needsPerson(fx: Fx, w: Wo, reason: string, cause?: "failed" | "merge"): Promise<void> {
  const from = stationIdOf(fx.catalog, w);
  w.data.bayFrom = from;
  w.data.bayReason = reason;
  w.data.bayAt = fx.now.getTime();
  w.position = "person";
  w.state = "parked";
  await releaseSlot(fx, w);
  await enterBay(fx, w, "person", reason);
  // Why it waits for a person: a failed station is retried, a question is answered. Cleared when it leaves the bay.
  if (cause) w.data.bayCause = cause;
  else delete w.data.bayCause;
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
  // An eval case's carrier is not work: its result is graded by the evals area (spec 13.2) and must never move through the flow.
  if (w.source === "eval" || w.source === "onboarding") return { applied: false, code: "unknown", reason: "That attempt belongs to an eval run or an onboarding agent step." };
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
    const { checks, headSha } = absorbOutput(w, sid, result, { attempt: attemptId, now });
    await recordGuardrail(tx, orgId, w, fx.actor);
    const dl = await recordDialogue(tx, { orgId, woId: w.id, station: sid, attemptId, agent: fx.actor, dialogue: asObj(result.output).dialogue, now });
    await ensureStationDocument(tx, { orgId, woId: w.id, attemptId, station: sid, stationName: stationDef(fx.catalog, sid)?.name ?? sid, result });
    await postStationMessage(fx, w, sid, attemptId, result.summary ? `${stationDef(fx.catalog, sid)?.name ?? sid} finished: ${clip(result.summary)}` : `${stationDef(fx.catalog, sid)?.name ?? sid} finished.`, dl.questions, dl.assumptions);
    const rv = sid === "review" ? reviewOf(w) : null;
    closeEntry(w, fx, rv?.verdict === "changes_requested" ? "changes requested" : "passed", result.summary ?? "");
    w.data.progress = 100;
    note(w, fx, fx.actor, result.summary ? `${stationDef(fx.catalog, sid)?.name ?? sid} finished: ${clip(result.summary)}` : `${stationDef(fx.catalog, sid)?.name ?? sid} finished.`);
    ev(fx, w, "wo.station.done", { station: sid, attempt: attemptId, text: result.summary ?? "" });
    if (rv) queueDescribe(fx, w, rv);
    // Review's verdict is enforced: "changes requested" goes back to the station the agent named (Build by default) or to Needs a person, never to the gate.
    const where = rv ? await enforceReview(fx, w, p, rv, fx.actor, (reason) => needsPerson(fx, w, reason)) : "gate";
    if (where === "gate") await arriveAtGate(fx, w, fx.actor, { project: p, ...(checks ? { checks } : {}), ...(headSha !== undefined ? { headSha } : {}) });
    next = bayOf(fx.catalog, w) ?? stationIdOf(fx.catalog, w);
  } else if (result.status === "needs_person" && asObj(result.output).scouts !== undefined && scoutRequest(asObj(result.output).scouts, w).ok) {
    // Phase 3: the run split its question among scouts. The work order stays at the station while they work; then the station runs again.
    const req = scoutRequest(asObj(result.output).scouts, w) as { ok: true; scouts: Array<{ question: string; focus: "repo" | "web" }> };
    await recordDialogue(tx, { orgId, woId: w.id, station: sid, attemptId, agent: fx.actor, dialogue: asObj(result.output).dialogue, now });
    await startSwarm(fx, w, sid, attemptId, req.scouts);
    next = sid;
  } else if (result.status === "needs_person") {
    closeEntry(w, fx, "question", result.summary ?? "");
    const out = asObj(result.output);
    // A scout request the rails refused becomes a question to a person, with the reason.
    if (out.scouts !== undefined && !out.dialogue && !out.researchPlan) out.dialogue = { questions: [{ question: `The agent wanted to send scouts but: ${(scoutRequest(out.scouts, w) as { reason: string }).reason} How should it go on?`, why: "The station cannot continue its plan as asked.", blocking: true }] };
    // An older runner reports one `output.question`; the station tools report `output.dialogue`. Either way the questions become rows.
    const dialogue = out.dialogue ?? (typeof out.question === "string" ? { questions: [{ question: out.question, why: "", blocking: true }] } : out.researchPlan ? {} : { questions: [{ question: result.summary || "The agent needs a decision to go on.", why: "", blocking: true }] });
    const dl = await recordDialogue(tx, { orgId, woId: w.id, station: sid, attemptId, agent: fx.actor, dialogue, now });
    const name = stationDef(fx.catalog, sid)?.name ?? sid;
    const plan = proposedPlan(out.researchPlan, sid, attemptId, now);
    if (plan) w.data.researchPlan = plan;
    const waiting = dl.questions.filter((q) => q.blocking);
    // A station that stops with only assumptions has nothing else to wait for: the open assumptions are what it waits on, so confirming or correcting the last one resumes it (S-30).
    const assumptionIds = !waiting.length && !plan && dl.assumptions
      ? (await tx.query<{ id: string }>(`select id from wo_assumptions where org_id = $1 and wo_id = $2 and attempt_id = $3 and status = 'open' order by id`, [orgId, w.id, attemptId])).rows.map((x) => x.id)
      : [];
    w.data.waitingOn = { station: sid, attempt: attemptId, questions: waiting.map((q) => q.id), askOf: [...new Set(waiting.map((q) => q.askOf))], ...(plan ? { plan: true } : {}), ...(assumptionIds.length ? { assumptions: assumptionIds } : {}) };
    const assumptionText = assumptionIds.length === 1 ? "1 assumption" : `${assumptionIds.length} assumptions`;
    const what = [waiting.length ? (waiting.length === 1 ? "an answer" : `${waiting.length} answers`) : "", plan ? "the research plan to be approved" : "", assumptionIds.length ? `${assumptionText} to be confirmed` : ""].filter(Boolean).join(" and ") || "a person";
    // The runner's own default ("research: waiting for ...") says less than this; an agent's real summary is kept after it.
    const said = result.summary && !/^[a-z-]+: waiting for /.test(result.summary) ? ` ${clip(result.summary)}` : "";
    await postStationMessage(fx, w, sid, attemptId, `${name} is waiting for ${what}.${said}`, dl.questions, dl.assumptions, !!plan);
    await needsPerson(fx, w, assumptionIds.length ? `Waiting for you to confirm ${assumptionText} at ${name}` : plan && !waiting.length ? `Waiting for the research plan at ${name}` : waiting.length ? `Waiting for ${waiting.length === 1 ? "an answer" : `${waiting.length} answers`} at ${name}` : `Waiting for a decision at ${name}`);
    if (plan) ev(fx, w, "research.plan.proposed", { station: sid, text: plan.questions.join(" · ").slice(0, 300), hosts: plan.hosts, web: plan.web, budgetUsd: plan.budgetUsd }, { category: "flow" });
    ev(fx, w, "wo.question", { station: sid, text: waiting.map((q) => q.question).join(" · ").slice(0, 300) }, { category: "flow" });
    next = "person";
  } else {
    // A run that stopped on a limit says which one and the numbers (used 40 of 40 turns); the person who may raise it is offered a one-off raise on the Record.
    const stop = result.status === "failed" ? await limitStopOf(tx, orgId, attemptId, sid, result.error ?? undefined) : null;
    if (stop) {
      w.data.limitStop = stop;
      await tx.query(`update attempts set data = data || $3::jsonb where org_id = $1 and id = $2`, [orgId, attemptId, JSON.stringify({ limitStop: stop })]);
    } else delete w.data.limitStop;
    closeEntry(w, fx, result.status === "failed" ? "failed" : "interrupted", stop?.text ?? result.error?.msg ?? result.summary ?? "");
    const n = await failCount(tx, orgId, w.id, sid);
    if (result.status === "failed" && n < MAX_STATION_FAILURES) {
      w.state = "failed";
      w.data.failReason = stop?.text ?? result.error?.msg ?? `${stationDef(fx.catalog, sid)?.name ?? sid} failed.`;
      if (result.error?.phase === "start") w.data.failPhase = "start";
      else delete w.data.failPhase;
      ev(fx, w, "wo.state", { from: "running", to: "failed", station: sid, text: String(w.data.failReason) });
      next = sid;
    } else if (result.status === "interrupted" && (await interruptions(tx, orgId, w.id, sid)) < MAX_STATION_FAILURES) {
      await enterStation(fx, w, sid);
      next = sid;
    } else {
      await needsPerson(fx, w, stop ? `${stationDef(fx.catalog, sid)?.name ?? sid} stopped on its ${stop.limit} limit ${MAX_STATION_FAILURES} times. ${stop.text} Retry with a higher limit, or change the limit.` : `${stationDef(fx.catalog, sid)?.name ?? sid} ${result.status === "failed" ? "failed" : "was interrupted"} ${MAX_STATION_FAILURES} times; a person needs to look.`, "failed");
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
  return Number((await tx.query(`select count(*)::int as n from attempts where org_id = $1 and wo_id = $2 and station = $3 and outcome in ('interrupted','lease_expired') and (data->>'streakBroken') is null`, [orgId, woId, station])).rows[0].n);
}

/**
 * The station's agent is turned off (or its live version never passed its eval suite), so its run is not started: the attempt is cancelled and the work order goes to
 * Needs a person with the reason, where Retry (after turning the agent on) or assigning another agent moves it. Nothing about the work is lost or failed.
 * Safe to call twice and for a superseded attempt (nothing happens).
 */
export async function refuseStationRun(tx: Tx, attemptId: string, fencing: number, reason: string, o: { now?: Date } = {}): Promise<{ applied: boolean }> {
  const found = (await tx.query<{ org_id: string; wo_id: string }>(`select org_id, wo_id from attempts where id = $1 and fencing = $2`, [attemptId, fencing])).rows[0];
  if (!found) return { applied: false };
  const w = await lockWo(tx, found.org_id, found.wo_id);
  if (w.source === "eval" || w.source === "onboarding") return { applied: false };
  if (!(await attemptIsCurrent(tx, found.org_id, attemptId, fencing)).current || w.state === "done" || w.state === "killed") return { applied: false };
  const fx = await fxFor(tx, found.org_id, "system", o.now ?? new Date());
  if (bayOf(fx.catalog, w)) return { applied: false };
  closeEntry(w, fx, "not started", reason);
  await cancelAttempts(fx, w, "agent_off");
  await needsPerson(fx, w, reason, "failed");
  await saveWo(tx, found.org_id, w);
  await flushFx(fx);
  await dispatchQueued(fx, w.project);
  await flushFx(fx);
  return { applied: true };
}

/** F9: a run whose lease lapsed is retried as a fresh attempt, up to a bound, then the work order goes to "Needs a person". Returns the attempts handled. */
export async function expireLeases(tx: Tx, o: { now?: Date; limit?: number } = {}): Promise<string[]> {
  const now = o.now ?? new Date();
  const { rows } = await tx.query<{ org_id: string; id: string; wo_id: string; station: string }>(
    `select org_id, id, wo_id, station from attempts where state = 'running' and lease_until < $1 and not exists (select 1 from work_orders w where w.org_id = attempts.org_id and w.id = attempts.wo_id and w.source in ('eval','onboarding')) order by lease_until limit $2 for update skip locked`, [now, o.limit ?? 50],
  );
  const handled: string[] = [];
  for (const a of rows) {
    // A scout that stopped heartbeating counts as failed; the swarm goes on without it (it never restarts the station on its own).
    const sd = (await tx.query<{ data: { scout?: unknown }; fencing: string }>(`select data, fencing::text from attempts where org_id = $1 and id = $2`, [a.org_id, a.id])).rows[0];
    if (sd?.data.scout) {
      await applyScoutResult(tx, a.id, Number(sd.fencing), { status: "failed", summary: "", output: null, error: { msg: "The scout stopped heartbeating." } }, now);
      handled.push(a.id);
      continue;
    }
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
      await needsPerson(fx, w, `${stationDef(fx.catalog, a.station)?.name ?? a.station} lost its run ${MAX_STATION_FAILURES} times; a person needs to look.`, "failed");
    }
    await saveWo(tx, a.org_id, w);
    await flushFx(fx);
    // F5: parking a Build work order freed its coding slot; the queue takes it now rather than at the next unrelated command.
    await dispatchQueued(fx, w.project);
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
  // The pull request merged while the order waited for a person (a blocked merge that was fixed on GitHub): it leaves the bay and moves on.
  // S-60: only the bay a blocked merge itself uses (cause "merge") may hold an order whose approval is still pending; a decline, park or hold cancels the approval first.
  if (bayOf(fx.catalog, w) && w.data.bayCause !== "merge") return { applied: false, reason: "The work order is in a bay; a merge never takes it out of one." };
  if (bayOf(fx.catalog, w)) {
    w.data.mergedFromBay = true;
    await leaveBay(fx, w);
    for (const k of ["bayReason", "bayAt", "bayCause"]) delete w.data[k];
    w.position = String(w.data.bayFrom ?? w.position);
    delete w.data.bayFrom;
    w.state = "waiting";
  }
  delete w.data.merging;
  w.data.blockReason = null;
  note(w, fx, "system", `Pull request #${o.prNumber} merged${o.mergeSha ? ` at ${o.mergeSha.slice(0, 7)}` : ""}.`);
  ev(fx, w, "wo.merged", { text: `#${o.prNumber}` }, { category: "flow" });
  const wasBay = !!w.data.mergedFromBay;
  delete w.data.mergedFromBay;
  await advance(fx, w, "system");
  await saveWo(tx, orgId, w);
  // The exception: the merge already happened, so the order comes back from its bay whatever the station holds. When it then waits there for the next station it
  // is one over the limit until it drains: an explicit audit event says so, and the Board shows the station over its limit.
  if (wasBay && w.state === "waiting" && w.data.wipWait) {
    const station = stationIdOf(fx.catalog, w);
    const limit = wipLimitOf(await projectOf(fx, w.project), station);
    const live = await wipLive(fx, w.project, station);
    if (limit && live > limit) ev(fx, w, "wo.wip.over_limit", { station, live, limit, text: `Returned from its bay after the merge of #${o.prNumber}: ${live} at ${stationDef(fx.catalog, station)?.name ?? station}, limit ${limit}` }, { category: "approvals" });
  }
  await flushFx(fx);
  return { applied: true };
}

/**
 * The approved merge cannot happen (the pull request was closed without merging, or GitHub still refuses it after the last retry): the order goes to
 * Needs a person with the reason instead of waiting as "merging" for ever. The approval stays on record (`data.merging`); Retry merge asks again for
 * the same approved head and never without it. Idempotent: nothing happens unless a merge of that pull request is still waiting.
 */
export async function parkMergeBlocked(tx: Tx, orgId: string, woId: string, o: { prNumber: number; reason: string; now?: Date }): Promise<{ parked: boolean }> {
  const w = await lockWo(tx, orgId, woId);
  if (asObj(w.data.merging).prNumber !== o.prNumber || w.state === "done" || w.state === "killed") return { parked: false };
  const fx = await fxFor(tx, orgId, "system", o.now ?? new Date());
  if (bayOf(fx.catalog, w)) return { parked: false };
  w.data.blockReason = null;
  await needsPerson(fx, w, o.reason, "merge");
  await saveWo(tx, orgId, w);
  await flushFx(fx);
  return { parked: true };
}

/** A new head commit on the pull request closes the open gate instance (spec 9.5) and, when the work order was waiting at a human gate, opens a fresh one on the new head. */
export async function recordNewHead(tx: Tx, orgId: string, woId: string, headSha: string, o: { now?: Date } = {}): Promise<{ reopened: string | null }> {
  const w = await lockWo(tx, orgId, woId);
  const fx = await fxFor(tx, orgId, "system", o.now ?? new Date());
  // A commit after the last G5 approval: the approval named the old head, so the merge is closed (it would never run) and G5 opens again on the new head.
  const merging = asObj(w.data.merging);
  if (typeof merging.prNumber === "number" && merging.headSha !== headSha && w.state !== "done" && w.state !== "killed") {
    if (bayOf(fx.catalog, w)) {
      // Back on the belt means a place at its station again: a full station keeps it in its bay until one frees.
      if (await wipHoldCheck(fx, w, String(w.data.bayFrom ?? "review"), "unpark", { by: "system" })) {
        await saveWo(tx, orgId, w);
        await dispatchQueued(fx, w.project);
        await flushFx(fx);
        return { reopened: null };
      }
      await leaveBay(fx, w);
      w.position = String(w.data.bayFrom ?? "review");
      for (const k of ["bayReason", "bayFrom", "bayAt", "bayCause"]) delete w.data[k];
    }
    delete w.data.merging;
    w.data.blockReason = null;
    w.state = "waiting";
    note(w, fx, "system", `Pull request #${merging.prNumber} changed after it was approved for merge (new head ${headSha.slice(0, 7)}); the merge is cancelled and the gate reopens.`);
    await closeOpenInstances(fx, woId, "new_head");
    await openGate(fx, w, "G5", { headSha });
    ev(fx, w, "gate.reopened", { gate: "G5", text: `New head commit ${headSha.slice(0, 7)} after approval` }, { category: "approvals" });
    await saveWo(tx, orgId, w);
    await flushFx(fx);
    return { reopened: "G5" };
  }
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

/**
 * A required check finished on a pull request's head: an open automatic G4 that was waiting for evidence (or judged an earlier result) reads the
 * CI results again. Nobody has voted on it (an automatic gate with a vote is a person's decision now), and a person who is deciding stays free to.
 */
export async function recheckAutoGate(tx: Tx, orgId: string, woId: string, headSha: string, o: { now?: Date } = {}): Promise<{ reopened: boolean }> {
  const open = (await tx.query<{ id: string }>(
    `select id from gate_instances where org_id = $1 and wo_id = $2 and status = 'open' and gate_id = 'G4' and coalesce(basis->'evidence'->>'source', 'none') in ('none', 'github')
       and not exists (select 1 from gate_votes v where v.org_id = gate_instances.org_id and v.gate_instance_id = gate_instances.id) and (head_sha is null or head_sha = $3)`,
    [orgId, woId, headSha],
  )).rows;
  if (!open.length) return { reopened: false };
  const w = await lockWo(tx, orgId, woId);
  const fx = await fxFor(tx, orgId, "system", o.now ?? new Date());
  await closeOpenInstances(fx, woId, "new_head");
  await openGate(fx, w, "G4", { headSha });
  await saveWo(tx, orgId, w);
  await flushFx(fx);
  return { reopened: true };
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
  // S-56: say who it reaches. The rule's fallback (the project owner when none is named) must be an active person who can approve this gate; otherwise nobody new is reached, and the announcement says so with a way forward.
  const { st, wo } = await flowFor(fx, w);
  const project = st.projects.find((x) => x.id === w.project);
  const rule = project?.approvers[inst.gate_id];
  const fallbackId = rule?.fallback ?? project?.owner ?? null;
  const fb = st.people.find((x) => x.id === fallbackId);
  const gate = st.catalog.gates.find((g) => g.id === inst.gate_id);
  const reached = !!fb && fb.status === "active" && can(st, fb.id, gate?.action || "gate.approve", { project: w.project, repo: wo.repo, time: now.getTime() }).allowed;
  const text = reached
    ? `Waited past the escalation limit. It now also reaches ${fb!.name}, the fallback approver.`
    : `Waited past the escalation limit, but the fallback approver${fb ? ` (${fb.name})` : ""} cannot approve it, so it reached nobody new. Name a fallback who can approve ${inst.gate_id} in the gate rule, or ask a Factory Admin.`;
  ev(fx, w, "gate.escalated", { gate: inst.gate_id, instance: inst.id, text, reached: reached ? fb!.id : null, fallback: fallbackId }, { category: "approvals" });
  await saveWo(tx, row.org_id, w);
  await flushFx(fx);
  return { handled: true, note: "escalated" };
}

void [openInstanceOf, cancelAttempts, startAttempt, loadOne];
