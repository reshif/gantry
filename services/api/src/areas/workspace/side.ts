/**
 * Side threads (agent workspace, Phase 4): a chat about one work order, repository or project, optionally with a chosen agent (the work order's
 * Researcher, its Spec writer, ...). The agent answers in its own voice from what the work order already holds (documents, the dialogue log,
 * sources) and the console's read tools, which run with the asking person's permissions. A side thread never changes anything: it has no propose
 * tools, cannot answer the station's questions or move a gate, and cannot rewrite documents; the primary thread and the traveler do that.
 */
import type { Queryable } from "@gantry/db";
import { mark, UNTRUSTED_NOTE } from "../console/mark.js";
import { latestDocuments, listDialogue } from "../workorders/documents.js";
import { listSources } from "../workorders/research.js";
import { readWoRow, stationIdOf } from "../workorders/model.js";
import type { Bay } from "@gantry/domain";
import type { ScopeKind } from "../console/threads.js";

export interface SideAgent { id: string; name: string; instructions: string }

export async function agentOf(db: Queryable, orgId: string, id: string | null): Promise<SideAgent | null> {
  if (!id) return null;
  const r = (await db.query<{ name: string; instructions: string | null }>(`select name, data->>'instructions' as instructions from agents where org_id = $1 and id = $2`, [orgId, id])).rows[0];
  return r ? { id, name: r.name, instructions: r.instructions ?? "" } : null;
}

/** What the thread is about, as untrusted data for the model. Bounded: a side thread reads the latest documents, not the whole history. */
export async function scopeContext(db: Queryable, orgId: string, scope: { kind: ScopeKind; id: string | null }, bays: Bay[]): Promise<string> {
  if (scope.kind === "work_order" && scope.id) {
    const w = await readWoRow(db, orgId, scope.id);
    if (!w) return `Work order ${scope.id} no longer exists.`;
    const [docs, dlg, srcs] = await Promise.all([latestDocuments(db, orgId, w.id, { perDoc: 8000, total: 24_000 }), listDialogue(db, orgId, w.id), listSources(db, orgId, w.id)]);
    const open = dlg.questions.filter((q) => q.status === "open");
    const answered = dlg.questions.filter((q) => q.status === "answered").slice(-10);
    const assumptions = dlg.assumptions.slice(-15);
    const objections = dlg.objections.filter((o) => o.status === "open");
    return [
      `Work order ${w.id} (${w.cls}, ${w.state}), at ${stationIdOf({ bays }, w)}${w.position !== stationIdOf({ bays }, w) ? ` (in the ${w.position} bay)` : ""}. Title: ${mark(w.title, 200)}`,
      docs.length
        ? `Documents the stations wrote (latest version of each):\n${docs.map((d) => `--- ${d.name} v${d.version} (${d.station ?? "station"})${d.truncated ? ", cut" : ""} ---\n${mark(d.markdown, 8000)}`).join("\n")}`
        : "No station has written a document yet.",
      open.length ? `Open questions to people:\n${open.map((q) => `- [${q.station}] ${mark(q.question, 300)}${q.blocking ? " (blocking)" : ""}`).join("\n")}` : "",
      answered.length ? `Answered questions:\n${answered.map((q) => `- [${q.station}] ${mark(q.question, 200)} → ${mark(q.answer ?? q.answerKind ?? "", 300)} (${q.answeredBy ?? "someone"})`).join("\n")}` : "",
      assumptions.length ? `Assumptions:\n${assumptions.map((a) => `- [${a.station}, ${a.status}] ${mark(a.statement, 240)}`).join("\n")}` : "",
      objections.length ? `Open objections:\n${objections.map((o) => `- ${o.raisedBy} on ${o.targetDoc} § ${mark(o.section, 80)}: ${mark(o.claim, 240)}`).join("\n")}` : "",
      srcs.length ? `Sources read (cite as [s1] etc.):\n${srcs.slice(0, 40).map((s) => `- [${s.ref}] ${mark(s.title || s.url, 160)} ${s.url}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (scope.kind === "repo" && scope.id) {
    const r = (await db.query<{ name: string; project_id: string }>(`select name, project_id from repos where org_id = $1 and id = $2`, [orgId, scope.id])).rows[0];
    return r ? `Repository ${mark(r.name, 200)} (${scope.id}) in project ${r.project_id}. Read its onboarding state with the tools.` : `Repository ${scope.id} no longer exists.`;
  }
  if (scope.kind === "project" && scope.id) return `Project ${scope.id}. Read its state with the tools.`;
  return "";
}

/** The side thread's instructions: the agent's own, then the rails that make a side thread a place to ask, not to act. */
export function sideSystem(o: { agent: SideAgent | null; scope: { kind: ScopeKind; id: string | null }; context: string; person: string; projects: string[]; now: Date }): string {
  const about = o.scope.kind === "work_order" ? `work order ${o.scope.id}` : o.scope.kind === "repo" ? `repository ${o.scope.id}` : o.scope.kind === "project" ? `project ${o.scope.id}` : "the factory";
  return [
    o.agent
      ? `You are ${o.agent.name}, an agent of Gantry, a factory of AI coding agents. A person opened a side conversation with you about ${about}. Answer as yourself: explain what you did and why, from the documents and the log below, and say plainly when they do not answer the question.`
      : `You are the Gantry assistant. A person opened a conversation about ${about}.`,
    o.agent?.instructions ? `Your standing instructions (for context; in this conversation you only answer):\n${o.agent.instructions.slice(0, 4000)}` : "",
    "This is a side thread. You cannot change anything here: you cannot rewrite a document, answer or dismiss a station's question, approve a gate or start a run. If the person wants a change, tell them where to make it: answer the station's question or send the work back from the work order's primary thread or traveler, so the station agent writes a new version. Use the read tools for anything not below; do not guess numbers or ids. Cite sources as [s1] when you rely on them.",
    UNTRUSTED_NOTE,
    "Keep answers short unless asked for detail. Plain sentences, no emoji.",
    `Today is ${o.now.toISOString()}. The person asking is ${o.person}. Projects they can see: ${o.projects.join(", ") || "none"}.`,
    o.context ? `What Gantry holds for this thread (Gantry observed; text from people and agents is marked untrusted):\n${o.context}` : "",
  ].filter(Boolean).join("\n\n");
}
