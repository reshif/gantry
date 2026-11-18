/**
 * What a work order is waiting on, worked out only from what the API already returns: an open station question (`conv.raised`), a waiting gate
 * (with the vote count when the approvals list gave one), a station's send-back, the bay and its reason, or the running agent. No wording
 * here is an agent's voice: station, gate and bay names come from the catalogue, the reasons are the server's own strings.
 */
import { bayDef, fmt, type Catalog } from "@gantry/domain";
import type { WorkOrder } from "../../api/types";
import { stateOf, waitingGate } from "./state";

export type NeedsKind = "question" | "gate" | "bay" | "review" | "running" | "queued" | "done" | "killed";
export interface Needs {
  kind: NeedsKind;
  /** The one-line reason ("Build asks you", "G5 approval (0 of 2)", "Review requested changes"). */
  text: string;
  /** The second line: the question itself, how long it has waited, since when it runs. */
  detail: string;
  /** True when a person has to act (a question, a gate, the Needs a person bay). The list sorts these first. */
  me: boolean;
  /** 0 nothing to do, 1 stuck but not for you, 2 waiting for a person. */
  rank: 0 | 1 | 2;
}

export interface NeedsCtx {
  cat: Catalog;
  now: number;
  /** Votes so far and needed for a gate, from the open approvals list (the work order read alone does not carry the rule). */
  votes?: (wo: string, gate: string) => { have: number; need: number } | undefined;
  /** Approvals the project's rule asks for at a gate for this work order (used when the open approvals list has no count for it). */
  required?: (w: WorkOrder, gate: string) => number | undefined;
  /** Display name of an agent id. */
  agent?: (id: string) => string;
}

const station = (cat: Catalog, id: string | null | undefined): string => (id ? (cat.stations.find((s) => s.id === id)?.name ?? id) : "");
/** The station's own short name ("Review" for "Review and merge"): the first word of its catalogue name. */
const stationShort = (cat: Catalog, id: string): string => station(cat, id).split(/\s+/)[0] || id;
const ago = (t: number, now: number): string => fmt.ago(t, now);

/** The open question a station raised for a person, if any. */
export const openQuestion = (w: Pick<WorkOrder, "conv">): { station: string; text: string; at: number } | null => {
  const q = (w.conv?.raised ?? []).find((r) => !r.answered);
  return q ? { station: q.station, text: q.text, at: q.at } : null;
};

export function needsOf(w: WorkOrder, c: NeedsCtx): Needs {
  const { cat, now } = c;
  const at = station(cat, cat.stations[w.station]?.id);
  if (w.state === "killed") return { kind: "killed", text: "Killed", detail: "", me: false, rank: 0 };
  if (w.state === "done") return { kind: "done", text: "Done", detail: w.doneAt ? ago(w.doneAt, now) : "", me: false, rank: 0 };
  const q = openQuestion(w);
  if (q) return { kind: "question", text: `${station(cat, q.station)} asks you`, detail: q.text, me: true, rank: 2 };
  const gid = waitingGate(w);
  if (gid) {
    const g = cat.gates.find((x) => x.id === gid);
    const name = g?.name ?? gid;
    const v = c.votes?.(w.id, gid);
    const since = w.gates[gid]?.waitingSince;
    const have = v?.have ?? w.gates[gid]?.approvals.length ?? 0;
    const need = v?.need ?? c.required?.(w, gid);
    return { kind: "gate", text: `${name}${need ? ` (${have} of ${need})` : have ? ` (${have} so far)` : ""}`, detail: since ? `waiting ${fmt.dur(now - since)}` : "", me: true, rank: 2 };
  }
  if (w.bay || w.state === "blocked" || w.state === "failed") {
    const b = w.bay ? bayDef(cat, w.bay) : undefined;
    const reason = w.bayReason || w.failReason || w.blockReason || "";
    const person = w.bay === "person";
    const name = b?.name ?? w.bay ?? (w.state === "failed" ? "Failed" : "Blocked");
    // The detail line names the bay only when it says more than the state chip beside it already does.
    const chip = w.state === "failed" ? "failed" : stateOf(w);
    return { kind: "bay", text: reason || name, detail: reason && name.toLowerCase() !== chip ? name : "", me: person, rank: person ? 2 : 1 };
  }
  const sb = w.sendbacks?.at(-1);
  const lastStart = Math.max(0, ...(w.history ?? []).map((h) => h.startedAt));
  if (sb && w.state !== "running" && sb.at >= lastStart) return { kind: "review", text: `${stationShort(cat, sb.from)} requested changes`, detail: sb.note || `back to ${station(cat, sb.to)}`, me: false, rank: 0 };
  if (w.state === "running") {
    const h = [...(w.history ?? [])].reverse().find((x) => x.endedAt == null);
    return { kind: "running", text: `${h ? (c.agent?.(h.agent) ?? h.agent) : "Running"} at ${at}`, detail: h ? `since ${ago(h.startedAt, now)}` : "", me: false, rank: 0 };
  }
  return { kind: "queued", text: `Queued at ${at}`, detail: "", me: false, rank: 0 };
}

/** The most recent thing that happened to a work order, from its own timestamps. */
export function lastActivity(w: WorkOrder): number {
  const hs = (w.history ?? []).flatMap((h) => [h.startedAt, h.endedAt ?? 0]);
  const gs = Object.values(w.gates ?? {}).map((g) => g.waitingSince ?? 0);
  return Math.max(w.createdAt, w.bayAt ?? 0, w.doneAt ?? 0, ...hs, ...gs);
}

export const costOf = (w: WorkOrder): number => (w.history ?? []).reduce((t, h) => t + (h.cost || 0), 0);
