/**
 * People's side of the dialogue log (agent workspace, Phase 1): answering a station's question and confirming or correcting an assumption.
 * Both are attributed to the person and audited. When the last blocking question of a waiting station is settled, the work order leaves the
 * "Needs a person" bay and the station runs again (a fresh attempt): its handoff carries the answers, its earlier documents and the assumptions.
 */
import { stationDef } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor } from "../../core/command.js";
import { conflict, invalid, refuse } from "../../core/errors.js";
import { bayOf, ev, leaveBay, note, type Fx } from "./engine.js";
import { readSecurity } from "../../core/read/index.js";
import { loadPolicyState } from "../../core/read/state.js";
import { decideFor } from "../../core/decide.js";
import { askOfLabel, mayAnswer } from "./asked.js";
import { planOf } from "./research.js";
import { begin, done, person, type CmdResult } from "./ctx.js";
import { resumeAt } from "./intake.js";
import { saveWo, type Wo } from "./model.js";
import { lockAssumption, lockObjection, lockQuestion } from "./documents.js";
import { addWoMessage } from "./session/store.js";
import { isResearchHost } from "../../core/research-host.js";

export type AnswerKind = "answer" | "dont_know" | "not_relevant";
const KIND_TEXT: Record<AnswerKind, string> = { answer: "", dont_know: "I don't know.", not_relevant: "Not relevant to this work." };

export async function answerStationQuestion(tx: Tx, actor: Actor, woId: string, qid: string, b: { answer?: string; kind: AnswerKind }): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.answer");
  const by = person(actor, "Answering is");
  const q = await lockQuestion(tx, fx.orgId, w.id, qid);
  if (!q) throw refuse("not_found", "No such question on this work order.");
  if (q.status !== "open") throw conflict("That question was already answered.");
  // The addressee is enforced here, inside the transaction and on the locked question, so a refusal is audited like any other denial.
  const st = await loadPolicyState(tx, fx.orgId);
  const principal = { kind: "person" as const, id: by, name: actor.name, sessionId: actor.sessionId ?? "" };
  const me = st.people.find((p) => p.id === by);
  if (!mayAnswer(q.askOf, me, { project: w.project, requestedBy: w.submitter }, (act) => decideFor(st, principal, act, { project: w.project, repo: w.repo, wo: w.id }).allowed)) {
    const roleName = (rid: string) => st.catalog.roles?.find((r) => r.id === rid)?.name ?? rid.replace(/_/g, " ");
    throw refuse("denied", `This question is for ${askOfLabel(q.askOf, roleName)}, so only they (or someone who can approve gates on the project) can answer it.`, { rule: { kind: "invariant", id: "ASK-OF", name: "Who the question is for" }, needs: "gate.approve" });
  }
  const text = (b.answer ?? "").trim();
  if (b.kind === "answer" && text.length < 1) throw invalid("Write the answer.");
  const answer = b.kind === "answer" ? text.slice(0, 4000) : text ? `${KIND_TEXT[b.kind]} ${text.slice(0, 4000)}` : KIND_TEXT[b.kind];
  await tx.query(`update wo_questions set status = 'answered', answer = $4, answer_kind = $5, answered_by = $6, answered_at = $7, updated_at = $7 where org_id = $1 and wo_id = $2 and id = $3`, [fx.orgId, w.id, qid, answer, b.kind, by, fx.now]);
  await addWoMessage(tx, fx.orgId, w.id, "user", by, answer, { kind: "answer", cards: [{ kind: "station_question", id: qid }] }, fx.now);
  ev(fx, w, "wo.answer", { station: q.station, question: qid, text: answer.slice(0, 200), kind: b.kind });
  const name = stationDef(fx.catalog, q.station)?.name ?? q.station;
  const resumed = await maybeResume(fx, w, by);
  if (!resumed) note(w, fx, by, `Answered a question from ${name}.`);
  await saveWo(tx, fx.orgId, w);
  return done(fx, resumed ? `Answer recorded; ${name} runs again with it.` : "Answer recorded.", w.project, { version: w.version, resumed });
}

/**
 * A waiting station runs again once nothing it waits for is open: its blocking questions answered and its research plan decided.
 * Returns whether it resumed.
 */
export async function maybeResume(fx: Fx, w: Wo, by: string): Promise<boolean> {
  const waitingOn = w.data.waitingOn as { station?: string; questions?: string[]; plan?: boolean; assumptions?: string[] } | undefined;
  if (!waitingOn || bayOf(fx.catalog, w) !== "person") return false;
  const qs = waitingOn.questions ?? [];
  const open = qs.length ? (await fx.tx.query<{ n: number }>(`select count(*)::int as n from wo_questions where org_id = $1 and wo_id = $2 and id = any($3) and status = 'open'`, [fx.orgId, w.id, qs])).rows[0]!.n : 0;
  const planOpen = waitingOn.plan === true && planOf(w.data)?.status === "proposed";
  const as = waitingOn.assumptions ?? [];
  const assumptionsOpen = as.length ? (await fx.tx.query<{ n: number }>(`select count(*)::int as n from wo_assumptions where org_id = $1 and wo_id = $2 and id = any($3) and status = 'open'`, [fx.orgId, w.id, as])).rows[0]!.n : 0;
  if (open > 0 || planOpen || assumptionsOpen > 0) return false;
  const back = String(waitingOn.station ?? w.data.bayFrom);
  delete w.data.waitingOn;
  await leaveBay(fx, w);
  await resumeAt(fx, w, back);
  note(w, fx, by, `${stationDef(fx.catalog, back)?.name ?? back} runs again with the answers.`);
  return true;
}

/**
 * Approve or reject the research plan a station proposed. Approving lets the station read the approved hosts and spend up to the approved budget;
 * a host that is not on the factory's research allow-list can be approved only by someone who manages security. Rejecting sends the station back
 * to work from the repository alone. Either way the station runs again once nothing else is open.
 */
export async function decideResearchPlan(tx: Tx, actor: Actor, woId: string, b: { decision: "approve" | "reject"; hosts?: string[]; web?: boolean; budgetUsd?: number | null; note?: string }, canManageSecurity: boolean): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "gate.approve");
  const by = person(actor, "Deciding a research plan is");
  const plan = planOf(w.data);
  if (!plan || plan.status !== "proposed") throw conflict("There is no research plan waiting for a decision.");
  const note = (b.note ?? "").trim().slice(0, 1000);
  if (b.decision === "reject") {
    if (note.length < 3) throw invalid("Say why the plan is rejected, so the agent can work without it.");
    w.data.researchPlan = { ...plan, status: "rejected", web: false, hosts: [], decidedBy: by, decidedAt: fx.now.getTime(), note };
    ev(fx, w, "research.plan.decided", { station: plan.station, decision: "rejected", text: note });
  } else {
    const web = b.web ?? plan.web;
    const hosts = web ? [...new Set((b.hosts ?? plan.hosts).map((h) => h.trim().toLowerCase()).filter(Boolean))] : [];
    const bad = hosts.filter((h) => !isResearchHost(h));
    if (bad.length) throw invalid(`${bad.join(", ")} must be DNS names, not IP addresses.`);
    if (web && !hosts.length) throw invalid("Approve at least one host, or approve the plan without the web.");
    const listed = new Set((await readSecurity(tx, fx.orgId)).value.researchHosts ?? []);
    const unlisted = hosts.filter((h) => !listed.has(h));
    if (unlisted.length && !canManageSecurity) {
      throw refuse("denied", `${unlisted.join(", ")} ${unlisted.length === 1 ? "is" : "are"} not on the factory's research allow-list. Someone who manages security can approve ${unlisted.length === 1 ? "it" : "them"}, or add ${unlisted.length === 1 ? "it" : "them"} to the list first.`, { rule: { kind: "matrix", id: "security.manage", name: "Manage security" } });
    }
    const budget = b.budgetUsd === undefined ? plan.budgetUsd : b.budgetUsd;
    w.data.researchPlan = { ...plan, status: "approved", web, hosts, budgetUsd: budget, decidedBy: by, decidedAt: fx.now.getTime(), ...(note ? { note } : {}) };
    ev(fx, w, "research.plan.decided", { station: plan.station, decision: "approved", hosts, web, budgetUsd: budget, unlisted, text: note });
  }
  await addWoMessage(tx, fx.orgId, w.id, "user", by, b.decision === "approve" ? `Approved the research plan${note ? `: ${note}` : "."}` : `Rejected the research plan: ${note}`, { kind: "answer", cards: [{ kind: "research_plan", station: plan.station }] }, fx.now);
  const resumed = await maybeResume(fx, w, by);
  await saveWo(tx, fx.orgId, w);
  return done(fx, `${b.decision === "approve" ? "Plan approved" : "Plan rejected"}${resumed ? `; ${stationDef(fx.catalog, plan.station)?.name ?? plan.station} runs again` : ""}.`, w.project, { version: w.version, resumed });
}

export async function decideAssumption(tx: Tx, actor: Actor, woId: string, aid: string, b: { status: "confirmed" | "corrected"; note?: string }): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.answer", { allowClosed: false });
  const by = person(actor, "Deciding an assumption is");
  const a = await lockAssumption(tx, fx.orgId, w.id, aid);
  if (!a) throw refuse("not_found", "No such assumption on this work order.");
  if (a.status !== "open") throw conflict("That assumption was already decided.");
  const text = (b.note ?? "").trim().slice(0, 2000);
  if (b.status === "corrected" && text.length < 3) throw invalid("Say what is true instead.");
  await tx.query(`update wo_assumptions set status = $4, note = $5, decided_by = $6, decided_at = $7, updated_at = $7 where org_id = $1 and wo_id = $2 and id = $3`, [fx.orgId, w.id, aid, b.status, text || null, by, fx.now]);
  ev(fx, w, "wo.assumption", { station: a.station, assumption: aid, status: b.status, text: (text || a.statement).slice(0, 200) });
  note(w, fx, by, b.status === "confirmed" ? `Confirmed an assumption: ${a.statement.slice(0, 160)}` : `Corrected an assumption: ${text.slice(0, 160)}`);
  // The last assumption a parked station waited on resumes it, as the last answer does.
  const resumed = await maybeResume(fx, w, by);
  await saveWo(tx, fx.orgId, w);
  const base = b.status === "confirmed" ? "Assumption confirmed" : "Correction recorded; later stations work from it";
  return done(fx, resumed ? `${base}; ${stationDef(fx.catalog, String(w.data.bayFrom ?? w.position))?.name ?? "the station"} runs again.` : `${base}.`, w.project, { version: w.version, resumed });
}

/** A person decides an objection one agent raised about another's work: it stands (upheld) or the author is right (overruled). Audited; the decision travels with the handoff. */
export async function decideObjection(tx: Tx, actor: Actor, woId: string, oid: string, b: { decision: "upheld" | "overruled"; note?: string }): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "gate.approve");
  const by = person(actor, "Deciding an objection is");
  const o = await lockObjection(tx, fx.orgId, w.id, oid);
  if (!o) throw refuse("not_found", "No such objection on this work order.");
  if (o.status !== "open") throw conflict("That objection was already decided.");
  const text = (b.note ?? "").trim().slice(0, 1000);
  if (text.length < 3) throw invalid("Say why, so both agents work from the decision.");
  await tx.query(`update wo_objections set status = $4, note = $5, decided_by = $6, decided_at = $7, updated_at = $7 where org_id = $1 and wo_id = $2 and id = $3`, [fx.orgId, w.id, oid, b.decision, text, by, fx.now]);
  ev(fx, w, "wo.objection.decided", { station: o.station, objection: oid, against: o.targetDoc, decision: b.decision, text: text.slice(0, 200) });
  note(w, fx, by, `${b.decision === "upheld" ? "Upheld" : "Overruled"} an objection to ${o.targetDoc}: ${text.slice(0, 160)}`);
  await addWoMessage(tx, fx.orgId, w.id, "user", by, `${b.decision === "upheld" ? "The objection stands" : "The author is right"}: ${text}`, { kind: "answer", cards: [{ kind: "objection", id: oid }] }, fx.now);
  await saveWo(tx, fx.orgId, w);
  return done(fx, b.decision === "upheld" ? `Objection upheld. To have ${o.targetStation ?? "the author"} redo it, send the work order back.` : "Objection overruled.", w.project, { version: w.version });
}
