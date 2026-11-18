/**
 * What a work order is waiting on, in words, from data the API already returns: the open question on its dialogue (home.waiting.conversations),
 * its pending gate with the approvals so far (home.waiting.approvals), the Review agent's verdict, the bay reason, a block or failure reason, or the agent
 * that holds it and since when. Nothing here is written by the client: the station and gate names come from the catalogue, the rest is the server's own text.
 */
import { bayDef, type Catalog, type WorkOrder } from "@gantry/domain";
import type { Approval, Conversation, HomeFull } from "../home/data";
import { agoMs } from "./format";

export type NeedKind = "question" | "gate" | "review" | "bay" | "stuck" | "running" | "waiting" | "none";
export interface Needs {
  kind: NeedKind;
  text: string;
  /** A second quiet line (the reason behind the first). */
  sub?: string;
  /** A person is wanted: sorts first, and the row offers the primary action. */
  mine: boolean;
  /** The gate id when `kind` is "gate". */
  gate?: string;
}

/** The pending approvals and open conversations the server lists for this person. */
export interface WaitingData { approvals: Approval[]; conversations: Conversation[] }
export const waitingOf = (home: HomeFull | undefined): WaitingData => ({ approvals: home?.sections?.waiting?.approvals ?? [], conversations: home?.sections?.waiting?.conversations ?? [] });

/** The list read may carry the Review agent's verdict on the work order; the record read always does. */
export type WoWithReview = WorkOrder & { review?: { verdict?: string } | null };

export function needsOf(w: WoWithReview, cat: Catalog, waiting: WaitingData, agentName: (id: string) => string, now: number = Date.now()): Needs {
  if (w.state === "done" || w.state === "killed") return { kind: "none", text: "", mine: false };
  const station = cat.stations[w.station]?.name ?? "";
  const conv = waiting.conversations.find((c) => c.wo === w.id);
  if (conv && !conv.gate && !conv.stuck && conv.question) return { kind: "question", text: station ? `${station} asks you` : "Asks you", sub: conv.question, mine: true };
  const ap = waiting.approvals.find((a) => a.wo === w.id && a.gate);
  const gate = ap ?? (conv?.gate ? { gate: conv.gate.id, gateLabel: conv.gate.label, have: undefined, need: undefined } : null);
  if (gate) {
    const n = typeof gate.have === "number" && typeof gate.need === "number" ? ` (${gate.have} of ${gate.need})` : "";
    return { kind: "gate", text: `${gate.gateLabel ?? gate.gate} approval${n}`, mine: true, gate: gate.gate ?? "" };
  }
  if (w.review?.verdict === "changes_requested") return { kind: "review", text: "Review requested changes", mine: false };
  if (w.bay) {
    const name = bayDef(cat, w.bay)?.name ?? w.bay;
    return { kind: "bay", text: w.bayReason || name, ...(w.bayReason ? { sub: name } : {}), mine: w.bay === "person" };
  }
  if (w.state === "blocked" || w.state === "failed") return { kind: "stuck", text: w.blockReason || w.failReason || (w.state === "failed" ? "Failed" : "Blocked"), mine: true };
  const open = w.history[w.history.length - 1];
  if (w.state === "running" && open?.agent) return { kind: "running", text: agentName(open.agent), sub: `started ${agoMs(Math.max(0, now - open.startedAt))}`, mine: false };
  if (w.state === "waiting") return { kind: "waiting", text: "Waiting for the next station", mine: false };
  return { kind: "none", text: "", mine: false };
}

/** Rows that need the viewer sort first (0), then the rest still moving (1), then nothing to do (2); oldest first inside a group. */
export const needsRank = (n: Needs, at: number): number => (n.mine ? 0 : n.kind === "none" ? 2 : 1) * 1e13 + at;
