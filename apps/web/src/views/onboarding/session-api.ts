/** Onboarding session API (services/api/src/routes/onboarding-session.ts). Query keys start with `repos`, so every change to a repo refreshes the conversation too. */
import { useQuery } from "@tanstack/react-query";
import type { Next, SessionCard, StepState } from "@gantry/domain";
import { api, get, post, streamCommand, type ApiResult } from "../../api/client";
import { invalidateSlices } from "../../api/keys";
import { SseReader } from "../console/api";

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  author: string;
  text: string;
  at: number;
  data: { cards?: SessionCard[]; kind?: string; mode?: "agent" | "rule-based"; model?: string | null; stopped?: boolean };
}
export interface Session {
  repoId: string;
  repo: string;
  project: string;
  messages: SessionMessage[];
  agent: { mode: "agent"; model: string; vendor: string; version: number } | { mode: "rule-based"; reason: string };
  budget: { spentUsd: number; limitUsd: number };
  costUsd: number;
  can: { talk: boolean; merge: boolean; talkWhy: string };
  steps: StepState[];
  next: Next;
  stage: string;
  busy: string | null;
  prNeedsUpdate: boolean;
  /** What the thread waits on outside the conversation (CI, the assessment, verification): Gantry posts and notifies when it happens. */
  waiting: { text: string; since: number | null; checkedAt: number | null } | null;
  prChecks: string | null;
}

const enc = encodeURIComponent;
export const sessionKey = (repoId: string) => ["repos", "session", repoId] as const;
export const useSession = (repoId: string) => useQuery({ queryKey: sessionKey(repoId), queryFn: () => get<Session>(api(`repos/${enc(repoId)}/onboarding/session`)), refetchInterval: 15_000 });

export type TurnEvent =
  | { event: "text"; data: { delta: string } }
  | { event: "tool"; data: { name: string; ok: boolean } }
  | { event: "card"; data: { card: SessionCard } }
  | { event: "done"; data: { messageId: string } }
  | { event: "error"; data: { code: string; msg: string } };

/** A person's message, or `open` / `continue` (the agent's turn without new words). The answer streams; a rule-based reply comes back as plain JSON. */
export async function sendTurn(repoId: string, body: { kind: "message" | "open" | "continue"; text?: string }, on: (e: TurnEvent) => void, signal: AbortSignal): Promise<ApiResult> {
  const sse = new SseReader();
  const r = await streamCommand(api(`repos/${enc(repoId)}/onboarding/session/messages`), body, (chunk) => {
    for (const e of sse.push(chunk)) on(e as unknown as TurnEvent);
  }, signal, true);
  invalidateSlices(["repos"]);
  return r;
}

export async function decide(repoId: string, messageId: string, pid: string, decision: "approve" | "changes" | "discard", text?: string, confirmSensitive?: boolean): Promise<ApiResult> {
  const r = await post(api(`repos/${enc(repoId)}/onboarding/session/proposals/${enc(messageId)}/${enc(pid)}`), { decision, ...(text ? { text } : {}), ...(confirmSensitive ? { confirmSensitive: true } : {}) });
  if (r.ok) invalidateSlices(["repos", "audit"]);
  return r;
}

/** The person has read the session's updates: the bell stops listing them. */
export async function markSeen(repoId: string): Promise<void> {
  const r = await post(api(`repos/${enc(repoId)}/onboarding/session/seen`));
  if (r.ok) invalidateSlices(["home"]);
}
