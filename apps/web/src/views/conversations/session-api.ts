/** Work-order session API (services/api/src/routes/workorder-session.ts). Keys start with `workOrders` / `conversations`, so every change to a work order refreshes the session too. */
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Brief, WoCard } from "@gantry/domain";
import { api, get, post, streamCommand, type ApiResult } from "../../api/client";
import { invalidateSlices } from "../../api/keys";
import { isStreamLive, onStreamLive } from "../../api/stream";
import { SseReader } from "../console/api";
import type { TurnEvent } from "../session/kit";

export interface WoSessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  author: string;
  text: string;
  at: number;
  data: { cards?: WoCard[]; kind?: string; mode?: "agent" | "rule-based" | "legacy"; model?: string | null; agent?: string; version?: number; stopped?: boolean; chips?: string[] };
}
export type NextActor = "agent" | "you" | "approver" | "nobody";
export interface WoSession {
  woId: string;
  project: string;
  repo: string | null;
  wo: { id: string; title: string; description: string; cls: string; clsName: string; confidence: number; rationale: string; priority: string; station: string; stationName: string; state: string; bay: string | null; gate: { id: string; label: string; name: string } | null; requestedBy: string; closed: boolean };
  messages: WoSessionMessage[];
  agent: { mode: "agent"; name: string; id: string; model: string; vendor: string; version: number; station: string } | { mode: "rule-based"; name: string; id: string; reason: string; label: string; station: string };
  budget: { spentUsd: number; limitUsd: number };
  costUsd: number;
  can: { talk: boolean; talkWhy: string; confirm: boolean; confirmWhy: string };
  steps: Array<{ id: string; name: string; state: "done" | "current" | "todo" }>;
  next: { actor: NextActor; text: string };
  waiting: { text: string; kind: "agent" | "gate" } | null;
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
  waitingOn: "you" | "approver" | "agent" | "nobody";
  latest: { text: string; at: number; by: string; role: string } | null;
  unread: boolean;
  closed: boolean;
  started: boolean;
  requestedBy: string | null;
  createdAt: number;
}

const enc = encodeURIComponent;
/** The conversation and the inbox update from the live channel; they poll only while it is down. */
const useStreamLive = (): boolean => useSyncExternalStore(onStreamLive, isStreamLive, () => false);
const pollEvery = (live: boolean, ms: number): number | false => (live ? false : ms);
export const woSessionKey = (woId: string) => ["conversations", "session", woId] as const;
export const useWoSession = (woId: string | null | undefined) => {
  const live = useStreamLive();
  return useQuery({ queryKey: woSessionKey(woId ?? ""), queryFn: () => get<WoSession>(api(`work-orders/${enc(woId ?? "")}/session`)), enabled: !!woId, refetchInterval: pollEvery(live, 15_000) });
};
export const useWoSessions = (project: string | null | undefined) => {
  const live = useStreamLive();
  return useQuery({ queryKey: ["conversations", "sessions", project ?? null], queryFn: () => get<{ items: WoSessionRow[] }>(api("work-order-sessions"), project ? { project } : {}), enabled: project !== undefined, refetchInterval: pollEvery(live, 20_000) });
};

/** A person's message, or `open` / `continue` (the agent's turn without new words). The answer streams; a rule-based reply comes back as plain JSON. */
export async function sendWoTurn(woId: string, body: { kind: "message" | "open" | "continue"; text?: string }, on: (e: TurnEvent<WoCard>) => void, signal: AbortSignal): Promise<ApiResult> {
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
