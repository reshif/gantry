/**
 * Pure shaping of a work-order conversation for the Conversations screen: what the list groups, and what the thread shows.
 * Only data the API already returns (the session read and the session rows); nothing here writes or decides.
 */
import type { WoSession, WoSessionMessage, WoSessionRow } from "./session-api";
import type { StationQuestion } from "../documents/api";

/* ------------------------------------------------------------------ the list ---- */

export type ListGroupId = "needs" | "active" | "done";
export interface ListGroup { id: ListGroupId; label: string; rows: WoSessionRow[] }

/** The reason a row sits where it does ("Question from Build", "Gate G5"), from the row's own fields. */
export function reasonOf(w: WoSessionRow): { text: string; tone: "you" | "gate" | "wait" | "done" | "run" } {
  if (w.closed) return { text: w.state === "killed" ? "Killed" : "Done", tone: "done" };
  if (w.waitingOn === "you") {
    if (w.bay === "person" || w.state === "failed" || w.state === "blocked") return { text: "Needs a person", tone: "you" };
    return { text: `Question from ${w.stationName}`, tone: "you" };
  }
  const others: Record<Exclude<WoSessionRow["waitingOn"], "you">, { text: string; tone: "gate" | "wait" | "run" }> = {
    approver: { text: w.gate ? `Gate ${w.gate}` : "Waiting for an approver", tone: "gate" },
    person: { text: "Waiting for someone else", tone: "wait" },
    agent: { text: `${w.agentName ?? w.stationName} is working`, tone: "run" },
    nobody: { text: `${w.agentName ?? w.stationName} is working`, tone: "run" },
  };
  return others[w.waitingOn as Exclude<WoSessionRow["waitingOn"], "you">];
}

const when = (w: WoSessionRow) => w.latest?.at ?? w.createdAt;

/** "Needs you" first, then "Active", then "Done"; newest activity first inside each. Empty groups are left out. */
export function groupSessions(rows: WoSessionRow[]): ListGroup[] {
  const sorted = [...rows].sort((a, b) => when(b) - when(a));
  const pick = (id: ListGroupId): WoSessionRow[] => sorted.filter((w) => (w.closed ? "done" : w.waitingOn === "you" ? "needs" : "active") === id);
  const labels: Record<ListGroupId, string> = { needs: "Needs you", active: "Active", done: "Done" };
  return (["needs", "active", "done"] as const).map((id) => ({ id, label: labels[id], rows: pick(id) })).filter((g) => g.rows.length);
}

/* ------------------------------------------------------------------ the thread ---- */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
const qkey = (q: StationQuestion) => `${q.station}|${norm(q.question)}`;

export interface QuestionView {
  /** Ids asked again later: their cards are not drawn, the latest copy carries the count. */
  superseded: Set<string>;
  /** Times each latest question was asked (only entries above 1). */
  times: Map<string, number>;
}
export function questionView(qs: Array<StationQuestion & { mine: boolean }>): QuestionView {
  const groups = new Map<string, Array<StationQuestion & { mine: boolean }>>();
  for (const q of qs) groups.set(qkey(q), [...(groups.get(qkey(q)) ?? []), q]);
  const superseded = new Set<string>();
  const times = new Map<string, number>();
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => a.createdAt - b.createdAt);
    const latest = sorted[sorted.length - 1]!;
    for (const q of sorted) if (q !== latest) superseded.add(q.id);
    if (sorted.length > 1) times.set(latest.id, sorted.length);
  }
  return { superseded, times };
}

/** The question that holds the line right now: open and blocking (one asking this person first), the latest copy of its wording. */
export function blockingQuestion(s: Pick<WoSession, "dialogue">): (StationQuestion & { mine: boolean }) | null {
  const view = questionView(s.dialogue.questions);
  const open = s.dialogue.questions.filter((q) => q.status === "open" && q.blocking && !view.superseded.has(q.id));
  return open.find((q) => q.mine) ?? open[0] ?? null;
}

export type FeedItem =
  | { kind: "events"; key: string; items: WoSessionMessage[] }
  | { kind: "msg"; key: string; m: WoSessionMessage; head: boolean };

const PERSON = "user";
/** A message a person wrote (the others come from a station's agent or the system). */
export const fromPerson = (m: WoSessionMessage): boolean => m.role === PERSON;
const isEvent = (m: WoSessionMessage) => m.data.kind === "update";
/** A station message whose every card is a question asked again later: nothing of it is drawn, the latest copy says "asked N times". */
const isRepeat = (m: WoSessionMessage, v: QuestionView) => {
  const cards = m.data.cards ?? [];
  return !fromPerson(m) && cards.length > 0 && cards.every((c) => c.kind === "station_question" && v.superseded.has(c.id));
};
const sameAuthor = (a: WoSessionMessage, b: WoSessionMessage) => a.role === b.role && a.author === b.author && (a.data.mode === "legacy") === (b.data.mode === "legacy");

/**
 * Messages in order, with a run of line events folded into one item and a run of one author's messages sharing one head.
 * Repeats of a station question and legacy (scripted) messages stay out of the way of that grouping, never reordering real messages.
 */
export function buildFeed(messages: WoSessionMessage[], view: QuestionView): FeedItem[] {
  const out: FeedItem[] = [];
  let prev: WoSessionMessage | null = null;
  for (const m of messages) {
    if (isRepeat(m, view)) continue;
    if (isEvent(m)) {
      const last = out[out.length - 1];
      if (last?.kind === "events") last.items.push(m);
      else out.push({ kind: "events", key: `ev-${m.id}`, items: [m] });
      continue;
    }
    out.push({ kind: "msg", key: m.id, m, head: !prev || !sameAuthor(prev, m) || out[out.length - 1]?.kind !== "msg" });
    prev = m;
  }
  return out;
}
