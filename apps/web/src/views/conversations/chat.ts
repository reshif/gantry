/**
 * The Conversations page, as data: how the thread list is grouped and how a work order's messages are laid out as a chat. Pure functions over what the
 * API already returns (the sessions list, the session's messages and station questions); nothing here talks to the server.
 */
import type { StationQuestion } from "../documents/api";
import type { WoSession, WoSessionMessage, WoSessionRow } from "./session-api";

export const cap = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/* ------------------------------------------------------------------ the thread list ---- */

export type ThreadGroup = "needs" | "active" | "done";
export const GROUPS: Array<{ id: ThreadGroup; label: string }> = [{ id: "needs", label: "Needs you" }, { id: "active", label: "Active" }, { id: "done", label: "Done" }];
export type ThreadFilter = "all" | ThreadGroup;

export const groupOf = (r: WoSessionRow): ThreadGroup => (r.waitingOn === "you" && !r.closed ? "needs" : r.closed ? "done" : "active");

/** Why a thread sits where it does: a gate waiting on the viewer, a question from a station, or who it waits on. */
export function reasonOf(r: WoSessionRow): { text: string; tone: "info" | "warn" | "" } {
  if (r.closed) return { text: "Done", tone: "" };
  if (r.waitingOn === "you") return r.gate ? { text: `Gate ${r.gate}`, tone: "warn" } : { text: `Question from ${r.stationName}`, tone: "info" };
  if (r.waitingOn === "approver") return { text: "With an approver", tone: "" };
  if (r.waitingOn === "person") return { text: "Waiting on someone", tone: "" };
  return { text: r.agentName ? `${r.agentName} at work` : "At work", tone: "" };
}

/** The list the page shows: matching `q` (id, title, station, last message), narrowed by `filter`, grouped Needs you / Active / Done, newest activity first. */
export function groupThreads(rows: WoSessionRow[], q = "", filter: ThreadFilter = "all"): Array<{ id: ThreadGroup; label: string; rows: WoSessionRow[] }> {
  const needle = q.trim().toLowerCase();
  const hit = (r: WoSessionRow) => !needle || `${r.id} ${r.title} ${r.stationName} ${r.latest?.text ?? ""}`.toLowerCase().includes(needle);
  const at = (r: WoSessionRow) => r.latest?.at ?? r.createdAt;
  return GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => groupOf(r) === g.id && hit(r) && (filter === "all" || filter === g.id)).sort((a, b) => at(b) - at(a)) })).filter((g) => g.rows.length);
}

/* ------------------------------------------------------------------ the transcript ---- */

/** What a station question looks like once repeats are folded: asked again with the same words, only the latest copy is drawn, with how many times. */
export interface QuestionView { shown: boolean; times: number }
const norm = (q: StationQuestion): string => `${q.station}|${q.question.toLowerCase().replace(/\s+/g, " ").trim()}`;
export function questionViews(questions: StationQuestion[]): Map<string, QuestionView> {
  const groups = new Map<string, StationQuestion[]>();
  for (const q of [...questions].sort((a, b) => a.createdAt - b.createdAt)) groups.set(norm(q), [...(groups.get(norm(q)) ?? []), q]);
  const out = new Map<string, QuestionView>();
  for (const g of groups.values()) g.forEach((q, i) => out.set(q.id, { shown: i === g.length - 1, times: g.length }));
  return out;
}

export type Side = "agent" | "person";
export type Block =
  | { t: "events"; key: string; items: WoSessionMessage[] }
  | { t: "turn"; key: string; side: Side; author: string; msgs: WoSessionMessage[] };

export const isEvent = (m: WoSessionMessage): boolean => m.data.kind === "update";
export const sideOf = (m: WoSessionMessage): Side => (m.role === "user" ? "person" : "agent");

/** A station message whose only content was a question that was asked again later: the later copy carries it. */
function folded(m: WoSessionMessage, views: Map<string, QuestionView>): boolean {
  const cards = m.data.cards ?? [];
  if (m.role === "user" || !cards.length) return false;
  return cards.every((c) => c.kind === "station_question" && views.get(c.id)?.shown === false);
}

/**
 * Runs of line events become one block; consecutive messages from the same author become one turn; repeated station questions drop out of the older
 * messages. `events: false` leaves the line events out altogether.
 */
export function buildTranscript(s: Pick<WoSession, "messages" | "dialogue">, events = true): Block[] {
  const views = questionViews(s.dialogue.questions);
  const out: Block[] = [];
  for (const m of s.messages) {
    if (isEvent(m)) {
      if (!events) continue;
      const last = out[out.length - 1];
      if (last?.t === "events") last.items.push(m);
      else out.push({ t: "events", key: `e-${m.id}`, items: [m] });
      continue;
    }
    if (folded(m, views)) continue;
    const side = sideOf(m);
    const last = out[out.length - 1];
    if (last?.t === "turn" && last.side === side && last.author === m.author) last.msgs.push(m);
    else out.push({ t: "turn", key: `t-${m.id}`, side, author: m.author, msgs: [m] });
  }
  return out;
}

/** The question a person's answer replies to, from the station question card on the message. */
export function repliedTo(m: WoSessionMessage, s: Pick<WoSession, "dialogue">): StationQuestion | null {
  const id = (m.data.cards ?? []).find((c) => c.kind === "station_question")?.id;
  return s.dialogue.questions.find((q) => q.id === id) ?? null;
}

/** The question the person is being waited on for: open, theirs, blocking first, newest of its repeats. */
export function waitingQuestion(s: Pick<WoSession, "dialogue">): StationQuestion | null {
  const views = questionViews(s.dialogue.questions);
  const open = s.dialogue.questions.filter((q) => q.status === "open" && q.mine && views.get(q.id)?.shown !== false);
  return open.find((q) => q.blocking) ?? open[0] ?? null;
}
