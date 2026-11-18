/** Submission, the intake conversation, class override and decline (spec 9.4). */
import { answerConversation, classOf, classesOf, route, routeGates, startConversation, stationDef, submitGuard, type Conversation } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor } from "../../core/command.js";
import { conflict, invalid, refuse } from "../../core/errors.js";
import { loadFlowState } from "../../core/read/state.js";
import { closeConversation, replaceConversation, saveConversation } from "./conversation.js";
import { createWorkOrder, newWoId } from "./create.js";
import {
  bayOf, cancelAttempts, closeEntry, advance, closeOpenInstances, dispatchQueued, enterBay, enterStation, ev, leaveBay, loadOne, note, openInstanceOf, projectOf, releaseSlot, stationIdOf, type Fx,
} from "./engine.js";
import { begin, done, flowFor, makeFx, person, type CmdResult } from "./ctx.js";
import { saveWo, type Wo } from "./model.js";

export interface SubmitInput {
  repo: string;
  title: string;
  description?: string;
  priority?: string;
  requestedCls?: string | null;
  attachments?: unknown[];
  source?: string;
  paths?: string[];
  onBehalfOf?: string;
}

/** Submit a work order: the submit guard, classification, flow version pinned, the request stored verbatim and the intake conversation opened (spec 9.4). Idempotent through the pipeline's `Idempotency-Key`. */
export async function submitWO(tx: Tx, actor: Actor, projectId: string, b: SubmitInput): Promise<CmdResult> {
  const fx = await makeFx(tx, actor);
  const st = await loadFlowState(tx, actor.orgId);
  const project = st.projects.find((p) => p.id === projectId);
  if (!project) throw refuse("not_found", "No such project.");
  if (project.status === "archived") throw conflict(`${project.name} is archived and read-only.`);
  const why = submitGuard(st, projectId, b.repo);
  if (why?.startsWith("Submissions are refused")) throw refuse("stopped", why, { rule: { kind: "stop", id: "STOP", name: "Stop state" }, needs: "Resume or restore first" });
  if (why) throw invalid(why);
  const title = b.title.trim();
  if (!title) throw invalid("Give the work order a title.");
  if (b.requestedCls && !classesOf(fx.catalog, project).some((c) => c.id === b.requestedCls)) throw invalid(`Unknown class ${b.requestedCls}.`);
  const byKey = actor.kind !== "person";
  const onBehalf = b.onBehalfOf && st.people.some((p) => p.id === b.onBehalfOf) ? b.onBehalfOf : null;
  const requestedBy = byKey ? onBehalf ?? actor.id : (actor.personId as string);
  const source = b.source ?? (byKey ? "api" : actor.via ?? "web");
  const id = await newWoId(tx);
  const c = await createWorkOrder(fx, {
    id, project: projectId, repo: b.repo, title, description: (b.description ?? "").trim(), rawText: [title, (b.description ?? "").trim()].filter(Boolean).join("\n\n"), attachments: b.attachments ?? [],
    requestedCls: b.requestedCls ?? null, ...(b.priority ? { priority: b.priority } : {}), source, requestedBy, via: actor.via ?? actor.channel, awaiting: byKey ? "api" : "submitter",
    ...(b.paths ? { paths: b.paths } : {}), ...(byKey ? { submittedBy: actor.id } : {}),
  });
  const e = fx.events.find((x) => x.type === "wo.submit");
  if (e) e.after = { ...(e.after as object), cls: c.classification.cls, confidence: c.classification.confidence, route: c.route, priority: c.wo.priority, flowVersion: c.wo.flowVersion };
  const wo = await loadOne(fx, c.wo);
  return done(fx, `${id} submitted to ${project.name} as ${classOf(fx.catalog, project, c.classification.cls).name}.`, projectId, { id, wo, classification: c.classification, route: c.route, gates: c.gates, version: c.wo.version });
}

/** What a person changed in the brief by hand. Kept on the work order and laid over any brief Gantry recomputes from the scripted answers, so a later answer never wipes it. */
export interface BriefEdits { scopeIn?: string[]; scopeOut?: string[]; children?: string[]; by?: string; at?: number }

/** Lays a person's edits over a brief. Children only apply to an epic. */
export function withBriefEdits<B extends { scopeIn: string[]; scopeOut: string[]; children: string[] }>(brief: B, edits: BriefEdits | undefined, cls: string): B {
  if (!edits) return brief;
  return { ...brief, ...(edits.scopeIn ? { scopeIn: edits.scopeIn } : {}), ...(edits.scopeOut ? { scopeOut: edits.scopeOut } : {}), ...(edits.children && cls === "epic" ? { children: edits.children } : {}) };
}
const editsOf = (w: Wo): BriefEdits | undefined => (w.data.briefEdits && typeof w.data.briefEdits === "object" ? (w.data.briefEdits as BriefEdits) : undefined);

export interface BriefEditInput { scopeIn?: string[]; scopeOut?: string[]; children?: string[]; reason?: string }

const clipList = (v: string[], n = 300): string[] => v.map((x) => x.trim().slice(0, n)).filter(Boolean).slice(0, 12);

/** A person edits the brief's scope, and the child work orders of an epic, before confirming it. Only while the brief is open at Intake. The change is audited (before and after) and an agent's pending brief proposal is refused on approval because the brief moved (its fingerprint no longer matches). */
export async function editBrief(tx: Tx, actor: Actor, woId: string, b: BriefEditInput): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.answer");
  const by = person(actor, "Brief edits are");
  const { wo } = await flowFor(fx, w);
  const open = !bayOf(fx.catalog, w) && stationIdOf(fx.catalog, w) === "intake" && !!wo.gates.G0G1 && wo.gates.G0G1.status !== "passed";
  // An epic the plan left unsplit waits in Needs a person: a person's children there are the split.
  const unsplit = bayOf(fx.catalog, w) === "person" && w.cls === "epic" && w.data.bayFrom === "plan" && !w.data.split;
  if (unsplit && b.children?.length) {
    const kids = clipList(b.children);
    if (/\b(api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,}/i.test(JSON.stringify(kids))) throw invalid("The brief appears to contain a credential. Never put secrets in a brief.");
    const by0 = person(actor, "Brief edits are");
    const before0 = { children: wo.brief.children };
    w.data.briefEdits = { ...(editsOf(w) ?? {}), children: kids, by: by0, at: fx.now.getTime() };
    w.data.brief = { ...wo.brief, children: kids };
    note(w, fx, by0, `Added the epic's child work orders (${kids.length}).${b.reason ? ` ${b.reason}` : ""}`);
    ev(fx, w, "wo.brief.edit", { text: "children", fields: ["children"], reason: b.reason ?? null, edited: { children: kids } }, { before: before0 });
    await leaveBay(fx, w);
    for (const k of ["bayReason", "bayFrom", "bayAt", "bayCause"]) delete w.data[k];
    w.position = "plan";
    w.state = "running";
    await advance(fx, w, by0);
    await saveWo(fx.tx, fx.orgId, w);
    return done(fx, "Children added; the epic is split.", w.project, { brief: w.data.brief, version: w.version });
  }
  if (!open) throw conflict("The brief can only be edited at Intake, before it is confirmed.");
  if (b.scopeIn === undefined && b.scopeOut === undefined && b.children === undefined) throw invalid("Nothing to change: send scopeIn, scopeOut or children.");
  if (b.children !== undefined && w.cls !== "epic") throw invalid("Only an epic has child work orders.");
  const next = { ...(b.scopeIn !== undefined ? { scopeIn: clipList(b.scopeIn) } : {}), ...(b.scopeOut !== undefined ? { scopeOut: clipList(b.scopeOut) } : {}), ...(b.children !== undefined ? { children: clipList(b.children) } : {}) };
  if (next.scopeIn && !next.scopeIn.length) throw invalid("Say what is in scope.");
  if (/\b(api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,}/i.test(JSON.stringify(next))) throw invalid("The brief appears to contain a credential. Never put secrets in a brief.");
  const before = { scopeIn: wo.brief.scopeIn, scopeOut: wo.brief.scopeOut, children: wo.brief.children };
  const edits: BriefEdits = { ...(editsOf(w) ?? {}), ...next, by, at: fx.now.getTime() };
  w.data.briefEdits = edits;
  w.data.brief = withBriefEdits(wo.brief, edits, w.cls);
  note(w, fx, by, `Edited the brief (${Object.keys(next).join(", ")}).${b.reason ? ` ${b.reason}` : ""}`);
  ev(fx, w, "wo.brief.edit", { text: Object.keys(next).join(", "), fields: Object.keys(next), reason: b.reason ?? null, edited: next }, { before });
  await saveWo(fx.tx, fx.orgId, w);
  return done(fx, "Brief updated. A brief an agent proposed earlier must be proposed again.", w.project, { brief: w.data.brief, version: w.version });
}

export interface MessageInput {
  text: string;
  kind?: "answer" | "question";
}

/** An answer in the conversation, or a question raised to a person (which moves the work order to the Needs a person bay). */
export async function postMessage(tx: Tx, actor: Actor, woId: string, b: MessageInput): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, b.kind === "question" ? "wo.park" : "wo.answer");
  const text = b.text.trim();
  if (!text) throw invalid("Write an answer.");
  // An API key may answer intake questions (spec 8.10); the answer is recorded against the key.
  const by = actor.kind === "apikey" && b.kind !== "question" ? actor.id : person(actor, "The conversation is");
  const { st, wo } = await flowFor(fx, w);
  const project = st.projects.find((p) => p.id === w.project)!;
  if (b.kind === "question") {
    if (bayOf(fx.catalog, w)) throw conflict(`${w.id} is already in a bay.`);
    const sid = stationIdOf(fx.catalog, w);
    const conv: Conversation = structuredClone(wo.conv);
    conv.raised.push({ station: sid, text, at: fx.now.getTime(), answered: false });
    conv.messages.push({ from: by, at: fx.now.getTime(), text });
    await saveConversation(fx, w.id, conv, wo.conv.messages.length, "open");
    await parkInto(fx, w, "person", `Question raised at ${stationDef(fx.catalog, sid)?.name ?? sid}`);
    note(w, fx, by, `Question for a person: ${text}`);
    ev(fx, w, "wo.question", { text, station: sid }, { category: "flow" });
    await saveWo(fx.tx, fx.orgId, w);
    await dispatchQueued(fx, w.project);
    return done(fx, `Question raised; ${w.id} moved to Needs a person.`, w.project, { version: w.version });
  }
  const prev = wo.conv.messages.length;
  const r = answerConversation(fx.catalog, project, wo, text, by, fx.now.getTime());
  w.data.brief = withBriefEdits(r.brief, editsOf(w), w.cls);
  const returned = "returned" in r.outcome && r.outcome.returned;
  await saveConversation(fx, w.id, r.conv, prev, returned ? "open" : undefined);
  if (returned && w.position === "person") {
    const back = String(w.data.bayFrom ?? stationIdOf(fx.catalog, w));
    await leaveBay(fx, w);
    note(w, fx, by, `Answered; returned to ${stationDef(fx.catalog, back)?.name ?? back}.`);
    await resumeAt(fx, w, back);
  } else note(w, fx, by, "Answered an intake question.");
  ev(fx, w, "wo.answer", { text: text.slice(0, 200) });
  // The brief gate switched off by an admin override: a finished conversation is the brief, and the work order moves on with nobody confirming.
  const passed = r.conv.done && !returned ? await (await import("./gates.js")).passBriefIfGateOff(fx, w) : false;
  await saveWo(fx.tx, fx.orgId, w);
  if (passed) return done(fx, "Brief complete. The brief gate is off, so the work order moved on without a confirmation.", w.project, { version: w.version, conv: { done: true, qi: r.conv.qi }, passed: true });
  return done(fx, returned ? `Answer sent; ${w.id} is back on the belt.` : r.conv.done ? "Brief is ready to confirm." : "Answer recorded.", w.project, { version: w.version, conv: { done: r.conv.done, qi: r.conv.qi } });
}

/** Puts the work order into a bay: its slot and live attempt are released and the stay is recorded. An open gate instance stays open (it is still waiting). */
export async function parkInto(fx: Fx, w: Wo, bay: string, reason: string): Promise<void> {
  const from = bayOf(fx.catalog, w) ? String(w.data.bayFrom ?? "intake") : stationIdOf(fx.catalog, w);
  if (bayOf(fx.catalog, w)) await leaveBay(fx, w);
  w.data.bayFrom = from;
  w.data.bayReason = reason;
  delete w.data.bayCause;
  w.data.bayAt = fx.now.getTime();
  w.position = bay;
  w.state = "parked";
  closeEntry(w, fx, "parked", reason);
  await cancelAttempts(fx, w, `parked in ${bay}`);
  await releaseSlot(fx, w);
  await enterBay(fx, w, bay, reason);
  ev(fx, w, "wo.bay", { bay, from: null, station: from, text: reason });
}

/** Back to a station from a bay: a work order that was waiting at a gate goes back to waiting, anything else restarts the station with a new attempt. */
export async function resumeAt(fx: Fx, w: Wo, stationId: string): Promise<void> {
  const open = await fx.tx.query<{ gate_id: string }>(`select gate_id from gate_instances where org_id = $1 and wo_id = $2 and status = 'open'`, [fx.orgId, w.id]);
  delete w.data.bayReason;
  delete w.data.bayFrom;
  delete w.data.bayAt;
  delete w.data.bayCause;
  if (open.rowCount && stationId !== "build") {
    w.position = stationId;
    w.state = "waiting";
    ev(fx, w, "wo.bay", { bay: null, from: null, station: stationId, text: "Back on the belt" });
    return;
  }
  await enterStation(fx, w, stationId);
  ev(fx, w, "wo.bay", { bay: null, from: null, station: stationId, text: "Back on the belt" });
}

/** Class override at Intake, with an audited reason. The conversation restarts under the new class and answers to questions that still apply are replayed. */
export async function reclassify(tx: Tx, actor: Actor, woId: string, cls: string, reason: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.classify");
  const by = person(actor, "Class overrides are");
  const project = await projectOf(fx, w.project);
  if (!reason || reason.trim().length < 5) throw invalid("Give a reason for the override (at least 5 characters). It is audited.");
  if (!classesOf(fx.catalog, project).some((c) => c.id === cls)) throw invalid("Unknown class.");
  if (cls === w.cls) throw invalid(`${w.id} is already ${classOf(fx.catalog, project, cls).name}.`);
  if (stationIdOf(fx.catalog, w) !== "intake") throw invalid("Class can only change at Intake. Send it back to Intake first.");
  const { wo } = await flowFor(fx, w);
  const before = w.cls;
  w.cls = cls;
  w.priority = classOf(fx.catalog, project, cls).priority;
  w.data.clsOverridden = { by, at: fx.now.getTime(), from: before, reason: reason.trim() };
  const created = wo.createdAt;
  const fresh = startConversation(fx.catalog, project, { cls, title: w.title, description: String(w.data.description ?? ""), repo: w.repo ?? "", createdAt: created, clsConfidence: Number(w.data.clsConfidence) || 0, clsRationale: String(w.data.clsRationale ?? "") }, wo.conv.awaiting);
  let conv = fresh.conv;
  let brief = fresh.brief;
  for (const [qid, text] of Object.entries(wo.conv.answers)) {
    const q = conv.questions[conv.qi];
    if (q && q.id === qid) {
      const r = answerConversation(fx.catalog, project, { cls, title: w.title, conv }, text, by, fx.now.getTime());
      conv = r.conv;
      brief = r.brief;
    }
  }
  w.data.brief = withBriefEdits(brief, editsOf(w), cls);
  await replaceConversation(fx, w.id, conv);
  note(w, fx, by, `Class overridden: ${before} → ${cls} (${reason.trim()}).`);
  ev(fx, w, "wo.classify", { text: reason.trim(), from: before, to: cls }, { before: { cls: before } });
  await saveWo(fx.tx, fx.orgId, w);
  const r = route(fx.catalog, project, cls);
  return done(fx, `${w.id} is now ${classOf(fx.catalog, project, cls).name}. Route: ${r.map((s) => stationDef(fx.catalog, s)?.name ?? s).join(" → ")}.`, w.project, { route: r, gates: routeGates(fx.catalog, project, cls), version: w.version });
}

/** Decline the request: it moves to the Declined bay with the reason. */
export async function decline(tx: Tx, actor: Actor, woId: string, reason: string, via?: string): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.decline");
  return declineInner(fx, actor, w, reason, via);
}

export async function declineInner(fx: Fx, actor: Actor, w: Wo, reason: string, _via?: string, o: { fromGate?: { id: string } } = {}): Promise<CmdResult> {
  const by = person(actor, "Declining is");
  if (!reason || reason.trim().length < 5) throw invalid("Give a reason of at least 5 characters.");
  if (w.position === "declined") throw conflict(`${w.id} is already declined.`);
  const sid = stationIdOf(fx.catalog, w);
  closeEntry(w, fx, "declined", reason.trim());
  await closeOpenInstances(fx, w.id, "send_back");
  await parkInto(fx, w, "declined", reason.trim());
  await closeConversation(fx, w.id);
  note(w, fx, by, `Declined: ${reason.trim()}`);
  ev(fx, w, "wo.decline", { text: reason.trim(), station: sid, ...(o.fromGate ? { instance: o.fromGate.id } : {}) });
  await saveWo(fx.tx, fx.orgId, w);
  if (w.parentId) {
    const { completeParentIfDone } = await import("./engine.js");
    await completeParentIfDone(fx, w.parentId, by);
  }
  await dispatchQueued(fx, w.project);
  return done(fx, `${w.id} moved to Declined.`, w.project, { version: w.version });
}

export { openInstanceOf };

export interface FollowupInput {
  text: string;
  chips?: string[];
  mode?: string;
}

/** A follow-up question added to the intake conversation while the brief is not confirmed (legacy `addFollowup`, at most three). */
export async function addFollowup(tx: Tx, actor: Actor, woId: string, b: FollowupInput): Promise<CmdResult> {
  const { fx, w } = await begin(tx, actor, woId, "wo.answer");
  const by = person(actor, "The conversation is");
  const { st, wo } = await flowFor(fx, w);
  const project = st.projects.find((p) => p.id === w.project)!;
  const atIntake = !bayOf(fx.catalog, w) && stationIdOf(fx.catalog, w) === "intake" && wo.gates.G0G1 && wo.gates.G0G1.status !== "passed";
  if (!atIntake) throw invalid("Follow-up questions can only be added while the work order is at Intake and the brief is not confirmed.");
  const text = b.text.trim();
  if (text.length < 8) throw invalid("Write the question in at least a few words.");
  const conv: Conversation = structuredClone(wo.conv);
  const n = conv.questions.filter((x) => (x as { followup?: boolean }).followup).length;
  if (n >= 3) throw invalid("This conversation already has 3 follow-up questions.");
  if (conv.questions.some((x) => x.text.toLowerCase() === text.toLowerCase())) throw invalid("That question is already in the conversation.");
  const chips = (b.chips ?? []).map((c) => String(c).trim()).filter(Boolean).slice(0, 3);
  const nq = { id: `fu${n + 1}`, field: "extra", text, chips, followup: true, by, mode: b.mode ?? "local" } as unknown as Conversation["questions"][number];
  const now = fx.now.getTime();
  if (conv.done) {
    conv.questions.push(nq);
    conv.qi = conv.questions.length - 1;
    conv.done = false;
    conv.messages.push({ from: "ag-intake", at: now, text: nq.text, qid: nq.id, chips });
  } else {
    let at = conv.qi + 1;
    while (conv.questions[at] && (conv.questions[at] as { followup?: boolean }).followup) at++;
    conv.questions.splice(at, 0, nq);
  }
  const { buildBrief } = await import("@gantry/domain");
  w.data.brief = withBriefEdits(buildBrief(fx.catalog, project, { cls: w.cls, title: w.title, conv }), editsOf(w), w.cls);
  await saveConversation(fx, w.id, conv, wo.conv.messages.length, "open");
  note(w, fx, by, "Follow-up question added to the intake conversation.");
  ev(fx, w, "wo.followup", { text: text.slice(0, 200) });
  await saveWo(fx.tx, fx.orgId, w);
  return done(fx, conv.qi === conv.questions.indexOf(nq) ? "Follow-up asked. Answer it to complete the brief." : "Follow-up added. The Intake agent asks it after the current question.", w.project, { question: nq, version: w.version });
}
