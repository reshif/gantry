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

export interface Dialogue { questions: StationQuestion[]; assumptions: Assumption[] }

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
