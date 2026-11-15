/**
 * People's side of the dialogue log (agent workspace, Phase 1): answering a station's question and confirming or correcting an assumption.
 * Both are attributed to the person and audited. When the last blocking question of a waiting station is settled, the work order leaves the
 * "Needs a person" bay and the station runs again (a fresh attempt): its handoff carries the answers, its earlier documents and the assumptions.
 */
import { stationDef } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor } from "../../core/command.js";
import { conflict, invalid, refuse } from "../../core/errors.js";
import { bayOf, ev, leaveBay, note } from "./engine.js";
import { begin, done, person, type CmdResult } from "./ctx.js";
import { resumeAt } from "./intake.js";
import { saveWo } from "./model.js";
import { lockAssumption, lockQuestion } from "./documents.js";
import { addWoMessage } from "./session/store.js";

export type AnswerKind = "answer" | "dont_know" | "not_relevant";
const KIND_TEXT: Record<AnswerKind, string> = { answer: "", dont_know: "I don't know.", not_relevant: "Not relevant to this work." };

export async function answerStationQuestion(tx: Tx, actor: Actor, woId: string, qid: string, b: { answer?: string; kind: AnswerKind }): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.answer");
  const by = person(actor, "Answering is");
  const q = await lockQuestion(tx, fx.orgId, w.id, qid);
  if (!q) throw refuse("not_found", "No such question on this work order.");
  if (q.status !== "open") throw conflict("That question was already answered.");
  const text = (b.answer ?? "").trim();
  if (b.kind === "answer" && text.length < 1) throw invalid("Write the answer.");
  const answer = b.kind === "answer" ? text.slice(0, 4000) : text ? `${KIND_TEXT[b.kind]} ${text.slice(0, 4000)}` : KIND_TEXT[b.kind];
  await tx.query(`update wo_questions set status = 'answered', answer = $4, answer_kind = $5, answered_by = $6, answered_at = $7, updated_at = $7 where org_id = $1 and wo_id = $2 and id = $3`, [fx.orgId, w.id, qid, answer, b.kind, by, fx.now]);
  await addWoMessage(tx, fx.orgId, w.id, "user", by, answer, { kind: "answer", cards: [{ kind: "station_question", id: qid }] }, fx.now);
  ev(fx, w, "wo.answer", { station: q.station, question: qid, text: answer.slice(0, 200), kind: b.kind });
  const name = stationDef(fx.catalog, q.station)?.name ?? q.station;
  let resumed = false;
  const waitingOn = w.data.waitingOn as { station?: string; questions?: string[] } | undefined;
  if (waitingOn?.questions?.includes(qid) && bayOf(fx.catalog, w) === "person") {
    const open = (await tx.query<{ n: number }>(`select count(*)::int as n from wo_questions where org_id = $1 and wo_id = $2 and id = any($3) and status = 'open'`, [fx.orgId, w.id, waitingOn.questions])).rows[0]!.n;
    if (open === 0) {
      const back = String(waitingOn.station ?? w.data.bayFrom ?? q.station);
      delete w.data.waitingOn;
      await leaveBay(fx, w);
      await resumeAt(fx, w, back);
      note(w, fx, by, `Answered; ${stationDef(fx.catalog, back)?.name ?? back} runs again with the answers.`);
      resumed = true;
    } else note(w, fx, by, `Answered a question from ${name}; ${open} still open.`);
  } else note(w, fx, by, `Answered a question from ${name}.`);
  await saveWo(tx, fx.orgId, w);
  return done(fx, resumed ? `Answer recorded; ${name} runs again with it.` : "Answer recorded.", w.project, { version: w.version, resumed });
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
  await saveWo(tx, fx.orgId, w);
  return done(fx, b.status === "confirmed" ? "Assumption confirmed." : "Correction recorded; later stations work from it.", w.project, { version: w.version });
}
