/** Station documents and the dialogue log (services/api routes/workorders.ts). Keys start with `workOrders`, so any work-order change refreshes them. */
import { useQuery } from "@tanstack/react-query";
import { api, get, post, type ApiResult } from "../../api/client";
import { invalidateSlices } from "../../api/keys";

export interface DocVersion {
  id: string;
  doc: string;
  station: string | null;
  version: number;
  supersedes: string | null;
  authorKind: "agent" | "person" | "system";
  authorId: string | null;
  attemptId: string | null;
  size: number;
  contentHash: string;
  createdAt: number;
  acceptedBy: string | null;
  body?: string;
}

export interface StationQuestion {
  id: string;
  station: string;
  attemptId: string | null;
  askedBy: string;
  question: string;
  why: string;
  options: string[];
  blocking: boolean;
  askOf: string;
  status: "open" | "answered" | "dismissed";
  answer: string | null;
  answerKind: "answer" | "dont_know" | "not_relevant" | null;
  answeredBy: string | null;
  answeredAt: number | null;
  createdAt: number;
}

export interface Assumption {
  id: string;
  station: string;
  attemptId: string | null;
  madeBy: string;
  statement: string;
  because: string;
  impact: "low" | "medium" | "high";
  status: "open" | "confirmed" | "corrected";
  note: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

export interface Dialogue { questions: StationQuestion[]; assumptions: Assumption[]; objections: Objection[] }

const enc = encodeURIComponent;
export const useWoDocuments = (woId: string | null | undefined) =>
  useQuery({ queryKey: ["workOrders", "documents", woId ?? ""], queryFn: () => get<{ items: DocVersion[] }>(api(`work-orders/${enc(woId ?? "")}/documents`)), enabled: !!woId });
export const useWoDocument = (woId: string, id: string | null | undefined) =>
  useQuery({ queryKey: ["workOrders", "document", woId, id ?? ""], queryFn: () => get<DocVersion>(api(`work-orders/${enc(woId)}/documents/${enc(id ?? "")}`)), enabled: !!id, staleTime: Infinity });
export const useWoDialogue = (woId: string | null | undefined) =>
  useQuery({ queryKey: ["workOrders", "dialogue", woId ?? ""], queryFn: () => get<Dialogue>(api(`work-orders/${enc(woId ?? "")}/dialogue`)), enabled: !!woId });

export async function answerQuestion(woId: string, qid: string, b: { kind: "answer" | "dont_know" | "not_relevant"; answer?: string }): Promise<ApiResult> {
  const r = await post(api(`work-orders/${enc(woId)}/questions/${enc(qid)}/answer`), b);
  if (r.ok) invalidateSlices(["workOrders", "conversations", "home", "floor"]);
  return r;
}

export async function decideAssumption(woId: string, aid: string, b: { status: "confirmed" | "corrected"; note?: string }): Promise<ApiResult> {
  const r = await post(api(`work-orders/${enc(woId)}/assumptions/${enc(aid)}`), b);
  if (r.ok) invalidateSlices(["workOrders", "conversations"]);
  return r;
}

/** Who a question asks, in words. */
export function askOfText(askOf: string): string {
  if (askOf === "requester") return "the requester";
  if (askOf === "approvers") return "an approver";
  if (askOf === "anyone") return "anyone on the project";
  if (askOf.startsWith("role:")) return `a ${askOf.slice(5).replace(/_/g, " ")}`;
  return "a person";
}

export interface Source {
  id: string; ref: string; kind: string; station: string; attemptId: string | null; fetchedBy: string | null; url: string; finalUrl: string; host: string; title: string;
  httpStatus: number | null; contentType: string; contentHash: string; size: number; truncated: boolean; why: string; fetchedAt: number; excerpt?: string;
}
export interface ResearchPlan {
  status: "proposed" | "approved" | "rejected"; questions: string[]; hosts: string[]; web: boolean; budgetUsd: number | null; why: string; station: string; attempt: string;
  proposedAt: number; decidedBy?: string; decidedAt?: number; note?: string;
}
export interface ResearchState { plan: ResearchPlan | null; allowList: string[]; canDecide: boolean; canApproveUnlisted: boolean }

export const useWoSources = (woId: string | null | undefined) =>
  useQuery({ queryKey: ["workOrders", "sources", woId ?? ""], queryFn: () => get<{ items: Source[] }>(api(`work-orders/${enc(woId ?? "")}/sources`)), enabled: !!woId });
export const useWoSource = (woId: string, ref: string | null) =>
  useQuery({ queryKey: ["workOrders", "source", woId, ref ?? ""], queryFn: () => get<Source>(api(`work-orders/${enc(woId)}/sources/${enc(ref ?? "")}`)), enabled: !!ref, staleTime: Infinity });

export async function decideResearchPlan(woId: string, b: { decision: "approve" | "reject"; hosts?: string[]; web?: boolean; budgetUsd?: number | null; note?: string }): Promise<ApiResult> {
  const r = await post(api(`work-orders/${enc(woId)}/research-plan`), b);
  if (r.ok) invalidateSlices(["workOrders", "conversations", "home", "floor", "audit"]);
  return r;
}

export type TimelineEntry =
  | { at: number; kind: "start"; text: string }
  | { at: number; kind: "step"; turn: number; tool: string; detail: string }
  | { at: number; kind: "source"; ref: string; url: string; title: string }
  | { at: number; kind: "document"; name: string; version: number }
  | { at: number; kind: "result"; outcome: string; text: string };
export interface RunTimeline {
  runId: string; attemptId: string; station: string; state: string; startedAt: number; endedAt: number | null; turn: number | null;
  model: string | null; calls: number; tokens: number; costUsd: number; entries: TimelineEntry[];
}
const live = (runs: RunTimeline[] | undefined) => !!runs?.some((r) => r.state === "running" || r.state === "starting");
/** Polls while a run is live (every 4 s), not otherwise. */
export const useWoTimeline = (woId: string | null | undefined) =>
  useQuery({ queryKey: ["workOrders", "timeline", woId ?? ""], queryFn: () => get<{ runs: RunTimeline[] }>(api(`work-orders/${enc(woId ?? "")}/timeline`)), enabled: !!woId, refetchInterval: (q) => (live(q.state.data?.runs) ? 4000 : false) });

export interface Objection {
  id: string; station: string; attemptId: string | null; raisedBy: string; targetDoc: string; targetStation: string | null; section: string; claim: string; reason: string;
  severity: "low" | "medium" | "high"; status: "open" | "upheld" | "overruled"; note: string | null; decidedBy: string | null; decidedAt: number | null; createdAt: number;
}
export interface SwarmScout { id: string; attempt: string; question: string; focus: "repo" | "web"; state: "queued" | "running" | "done" | "failed" | "stopped"; summary?: string; stoppedBy?: string; turn: number | null; costUsd: number }
export interface SwarmView { station: string; parent: string; startedAt: number; endedAt?: number; scouts: SwarmScout[] }

export async function decideObjection(woId: string, oid: string, b: { decision: "upheld" | "overruled"; note: string }): Promise<ApiResult> {
  const r = await post(api(`work-orders/${enc(woId)}/objections/${enc(oid)}`), b);
  if (r.ok) invalidateSlices(["workOrders", "conversations", "audit"]);
  return r;
}
export async function stopScout(woId: string, sid: string, reason: string): Promise<ApiResult> {
  const r = await post(api(`work-orders/${enc(woId)}/scouts/${enc(sid)}/stop`), { reason });
  if (r.ok) invalidateSlices(["workOrders", "conversations", "floor"]);
  return r;
}
