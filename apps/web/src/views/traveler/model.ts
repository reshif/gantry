/** Shared model for the traveler drawer, the record and the conversations: the traveler read (GET /work-orders/{id}), its decisions, and the small formatting helpers the three screens share. */
import { useQuery } from "@tanstack/react-query";
import type { Catalog, EventEntry, WorkOrder } from "@gantry/domain";
import { api, get } from "../../api/client";
import { qk } from "../../api/keys";
import { useCatalog } from "../projects/kit";

export interface TDecision {
  allowed: boolean;
  reason: string;
  needs?: string;
  rule?: unknown;
}
export interface GateProg {
  have: number;
  need: number;
  unmet: Array<{ id: string; text: string }>;
  conds: Array<{ id: string; text: string }>;
  onlyRequester: boolean;
  passes: boolean;
}
export interface TMove {
  allowed: boolean;
  reason: string;
  kind?: "park" | "unpark" | "back" | "approve";
}
export interface TStop {
  id: string;
  scope: string;
  mode: "halt" | "kill";
  reason: string;
}
/** The traveler read: the legacy work order plus the version, gate progress and what the viewer may do next. */
export type TWo = WorkOrder & {
  version: number;
  gateProgress: Record<string, GateProg>;
  allowed: { approve: (TDecision & { gate: string; instance: string }) | null; moves: Record<string, TMove>; can: Record<string, TDecision> };
  stop: TStop | null;
  route: string[];
};

export function useTravelerWo(id: string | null | undefined) {
  return useQuery({ queryKey: qk.workOrder(id ?? ""), queryFn: () => get<TWo>(api(`work-orders/${encodeURIComponent(id ?? "")}`)), enabled: !!id });
}

export const NO: TDecision = { allowed: false, reason: "" };
export const no = (reason: string): TDecision => ({ allowed: false, reason, needs: "" });
export const ok: TDecision = { allowed: true, reason: "" };
/** A decision from the read, or locked with the reason while the read has no answer. */
export const dec = (wo: TWo | undefined, k: string): TDecision => wo?.allowed?.can?.[k] ?? NO;

export const stName = (cat: Catalog | null, sid: string | null | undefined): string => (sid ? (cat?.stations.find((s) => s.id === sid)?.name ?? sid) : "");
export const stNo = (cat: Catalog | null, sid: string | null | undefined): string => cat?.stations.find((s) => s.id === sid)?.no ?? "";
export const bayLabel = (cat: Catalog | null, id: string | null | undefined): string => (id ? (cat?.bays.find((b) => b.id === id)?.name ?? id) : "");
export const clsName = (cat: Catalog | null, id: string | null | undefined): string => (id ? (cat?.classes.find((c) => c.id === id)?.name ?? id) : "");
export const openEntry = (w: Pick<WorkOrder, "history">) => w.history[w.history.length - 1];

/** An event of one work order's own history, as the journey scrubber and the timeline show it. */
export interface RecEvent {
  seq: number;
  at: number;
  type: string;
  by: string;
  outcome: string;
  detail: Record<string, unknown>;
  station?: string;
  gate?: string;
  text?: string;
  mode?: string;
  trust?: number | null;
  bay?: string | null;
}
export interface RawRecEvent {
  seq: number;
  at: string | null;
  type: string;
  by: string;
  outcome: string;
  detail: unknown;
}
export function toRecEvent(e: RawRecEvent): RecEvent {
  const d = e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as Record<string, unknown>) : {};
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
  const out: RecEvent = { seq: e.seq, at: e.at ? Date.parse(e.at) : 0, type: e.type, by: e.by, outcome: e.outcome, detail: d };
  const station = s("station");
  const gate = s("gate");
  const text = s("text");
  const mode = s("mode");
  const bay = s("bay");
  if (station) out.station = station;
  if (gate) out.gate = gate;
  if (text) out.text = text;
  if (mode) out.mode = mode;
  if (bay) out.bay = bay;
  if (typeof d.trust === "number") out.trust = d.trust;
  return out;
}
/** The milestones of the journey scrubber (answers and gate waits are in the conversation and the gates). */
const JOURNEY_TYPES = new Set(["wo.submit", "wo.enter", "gate.decision", "trust.auto", "wo.bay", "wo.state", "wo.sendback", "wo.reassign", "release", "wo.done", "kill", "restore", "outcome", "wo.classify", "brief.confirm", "wo.decline"]);
export const journeyOf = (events: RecEvent[]): RecEvent[] => events.filter((e) => JOURNEY_TYPES.has(e.type));

export type EventAsEntry = EventEntry;

export function useTravelerCatalog(): Catalog | null {
  return useCatalog();
}

export const plural = (n: number, w: string, p?: string): string => `${n} ${n === 1 ? w : (p ?? `${w}s`)}`;
export const isClosed = (w: Pick<WorkOrder, "state">): boolean => w.state === "done" || w.state === "killed";
/** Tab ids of the traveler. */
export const TRAVELER_TABS = ["journey", "lifecycle", "conversation", "brief", "artefacts", "history"] as const;
export type TravelerTab = (typeof TRAVELER_TABS)[number];
