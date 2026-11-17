/** Work-order session API (services/api/src/routes/workorder-session.ts). Keys start with `workOrders` / `conversations`, so every change to a work order refreshes the session too. */
import { qk } from "../../api/keys";
import { useQuery } from "@tanstack/react-query";
import type { Brief, WoCard } from "@gantry/domain";
import { api, get, post, streamCommand, type ApiResult } from "../../api/client";
import { invalidateSlices } from "../../api/keys";
import { SseReader } from "../console/api";
import type { TurnEvent } from "../session/kit";
import type { Assumption, DocVersion, Objection, ResearchState, Source, StationQuestion, SwarmView } from "../documents/api";

export interface WoSessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  author: string;
  text: string;
  at: number;
  data: { cards?: WoCard[]; kind?: string; mode?: "agent" | "rule-based" | "legacy"; model?: string | null; agent?: string; version?: number; stopped?: boolean; chips?: string[]; mentions?: Array<{ id: string; name: string; access: boolean }> };
}
/** `person`: waiting for someone else (a station asked a particular person or role). */
export type NextActor = "agent" | "you" | "approver" | "person" | "nobody";
export interface WoSession {
  woId: string;
  project: string;
  repo: string | null;
  wo: { id: string; title: string; description: string; cls: string; clsName: string; confidence: number; rationale: string; priority: string; station: string; stationName: string; state: string; bay: string | null; gate: { id: string; label: string; name: string; purpose?: string } | null; requestedBy: string; closed: boolean };
  messages: WoSessionMessage[];
  agent: { mode: "agent"; name: string; id: string; model: string; vendor: string; version: number; station: string } | { mode: "rule-based"; name: string; id: string; reason: string; label: string; station: string };
  budget: { spentUsd: number; limitUsd: number };
  costUsd: number;
  can: { talk: boolean; talkWhy: string; confirm: boolean; confirmWhy: string; park?: boolean; parkWhy?: string };
  steps: Array<{ id: string; name: string; state: "done" | "current" | "todo" }>;
  next: { actor: NextActor; text: string };
  waiting: { text: string; kind: "agent" | "gate" | "you" | "person" } | null;
  /** The questions the station agents asked (with whether this person is the one asked) and the assumptions they proceeded on. */
  dialogue: { questions: Array<StationQuestion & { mine: boolean }>; assumptions: Assumption[]; objections: Objection[]; askedMe: boolean };
  swarm: SwarmView | null;
  documents: DocVersion[];
  research: ResearchState;
  sources: Source[];
  pending: Array<{ mid: string; id: string; what: "brief" | "reclassify" | "decline"; title: string }>;
  brief: Brief;
  briefConfirmed: boolean;
  briefOpen: boolean;
  ruleQuestion: { id: string; text: string; chips: string[] } | null;
  ruleReady: boolean;
  busy: boolean;
}
export interface WoSessionRow {
  id: string;
  project: string;
  title: string;
  cls: string;
  station: string;
  stationName: string;
  state: string;
  bay: string | null;
  gate: string | null;
  agent: string | null;
  agentName: string | null;
  waitingOn: "you" | "approver" | "agent" | "person" | "nobody";
  latest: { text: string; at: number; by: string; role: string } | null;
  unread: boolean;
  closed: boolean;
  started: boolean;
  requestedBy: string | null;
  createdAt: number;
}

const enc = encodeURIComponent;
export const woSessionKey = (woId: string) => ["workOrders", "session", woId] as const;
export const useWoSession = (woId: string | null | undefined) =>
  useQuery({ queryKey: woSessionKey(woId ?? ""), queryFn: () => get<WoSession>(api(`work-orders/${enc(woId ?? "")}/session`)), enabled: !!woId, refetchInterval: 15_000 });
export const useWoSessions = (project: string | null | undefined) =>
  useQuery({ queryKey: qk.convSessions(project ?? null), queryFn: () => get<{ items: WoSessionRow[] }>(api("work-order-sessions"), project ? { project } : {}), enabled: project !== undefined, refetchInterval: 20_000 });

/** A person's message, or `open` / `continue` (the agent's turn without new words). The answer streams; a rule-based reply comes back as plain JSON. */
export async function sendWoTurn(woId: string, body: { kind: "message" | "open" | "continue"; text?: string; mentions?: string[] }, on: (e: TurnEvent<WoCard>) => void, signal: AbortSignal): Promise<ApiResult> {
  const sse = new SseReader();
  const r = await streamCommand(api(`work-orders/${enc(woId)}/session/messages`), body, (chunk) => {
    for (const e of sse.push(chunk)) on(e as unknown as TurnEvent<WoCard>);
  }, signal, true);
  invalidateSlices(["workOrders", "conversations"]);
  return r;
}

export async function decideWo(woId: string, messageId: string, pid: string, decision: "approve" | "changes" | "discard", text?: string): Promise<ApiResult> {
  const r = await post(api(`work-orders/${enc(woId)}/session/proposals/${enc(messageId)}/${enc(pid)}`), { decision, ...(text ? { text } : {}) });
  if (r.ok) invalidateSlices(["workOrders", "conversations", "audit"]);
  return r;
}

/** The person has read the session's updates: the bell stops listing them. */
export async function markWoSeen(woId: string): Promise<void> {
  const r = await post(api(`work-orders/${enc(woId)}/session/seen`));
  if (r.ok) invalidateSlices(["home"]);
}
