/** Typed reads for this slice of /api/v1. Keys come from ../keys (`qk`). */
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, get, getText } from "../client";
import { ops } from "../ops";
import { qk } from "../keys";
import type { Conversation, EventEntry, FloorData, HomeData, KillImpact, Page, Project, RecordBundle, Repo, SavedView, Template, WorkOrder, OrgGuidelines } from "../types";

/* ---------- home, projects, configuration ---------- */

export const useHome = () => useQuery({ queryKey: qk.home(), queryFn: () => get<HomeData>(api("home")) });
export const useActivity = (project?: string) =>
  useQuery({ queryKey: qk.activity(project), queryFn: () => get<EventEntry[] | Page<EventEntry>>(api("activity"), { project }) });
export const useProjects = () => useQuery({ queryKey: qk.projects(), queryFn: () => get<Project[]>(api("projects")) });
export const useProject = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.project(id ?? ""), queryFn: () => get<Project>(api(`projects/${encodeURIComponent(id ?? "")}`)), enabled: !!id });
export const useSavedViews = () => useQuery({ queryKey: qk.savedViews(), queryFn: () => get<SavedView[]>(api("saved-views")) });
export const useTemplates = () => useQuery({ queryKey: qk.templates(), queryFn: () => get<Template[]>(api("templates")) });

/* ---------- floor, work orders, conversations, record ---------- */

/** `at` replays the floor at a past time (ms since epoch). */
export const useFloor = (projectId: string | null | undefined, at?: number) =>
  useQuery({
    queryKey: qk.floor(projectId ?? "", at),
    queryFn: () => get<FloorData>(api(`projects/${encodeURIComponent(projectId ?? "")}/floor`), { at }),
    enabled: !!projectId,
  });
export const useProjectEvents = (projectId: string | null | undefined, q: { from?: number; to?: number; kinds?: string } = {}) =>
  useQuery({
    queryKey: qk.events(projectId ?? "", q),
    queryFn: () => get<EventEntry[]>(api(`projects/${encodeURIComponent(projectId ?? "")}/events`), q),
    enabled: !!projectId,
  });
export const useWorkOrders = (projectId: string | null | undefined, q: { cursor?: string; limit?: number; state?: string; cls?: string; repo?: string; q?: string } = {}) =>
  useQuery({
    queryKey: qk.workOrders(projectId ?? "", q),
    queryFn: () => get<WorkOrder[] | Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), q),
    enabled: !!projectId,
  });
/** Work orders of several projects in one list (the command palette); each project is its own cached read. */
export const useWorkOrdersAcross = (projectIds: string[], q: { limit?: number } = {}): WorkOrder[] =>
  useQueries({
    queries: projectIds.map((id) => ({
      queryKey: qk.workOrders(id, q),
      queryFn: () => get<WorkOrder[] | Page<WorkOrder>>(api(`projects/${encodeURIComponent(id)}/work-orders`), q),
    })),
    combine: (rs) => rs.flatMap((r) => (Array.isArray(r.data) ? r.data : (r.data?.items ?? []))),
  });
/** The work orders of several projects at once (the factory-wide scope), under the same keys as `useWorkOrders` so the two share the cache. */
export const useWorkOrdersOf = (projectIds: string[]) =>
  useQueries({
    queries: projectIds.map((id) => ({
      queryKey: qk.workOrders(id, {}),
      queryFn: () => get<WorkOrder[] | Page<WorkOrder>>(api(`projects/${encodeURIComponent(id)}/work-orders`), {}),
    })),
    combine: (rs) => ({
      data: rs.flatMap((r) => (Array.isArray(r.data) ? r.data : (r.data?.items ?? []))),
      pending: rs.some((r) => r.isPending),
      failed: rs.find((r) => r.isError)?.error ?? null,
    }),
  });
/** Every work order in the given projects (first 100 of each), merged. `failed` is true when any project's list could not be read, so a count never claims more certainty than it has. */
export function useWorkOrdersOfProjects(projectIds: string[]): { items: WorkOrder[]; pending: boolean; failed: boolean } {
  const results = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: qk.workOrders(id, { limit: 100 }),
      queryFn: () => get<WorkOrder[] | Page<WorkOrder>>(api(`projects/${encodeURIComponent(id)}/work-orders`), { limit: 100 }),
    })),
  });
  const items = results.flatMap((r) => (r.data ? (Array.isArray(r.data) ? r.data : r.data.items) : []));
  return { items, pending: results.some((r) => r.isPending), failed: results.some((r) => r.isError) };
}
export const useWorkOrder = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.workOrder(id ?? ""), queryFn: () => get<WorkOrder>(api(`work-orders/${encodeURIComponent(id ?? "")}`)), enabled: !!id });
export const useConversations = (q: { project?: string; awaitingMe?: boolean } = {}) =>
  useQuery({ queryKey: qk.conversations(q), queryFn: () => get<Conversation[] | Page<Conversation>>(api("conversations"), q) });
export const useRecord = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.record(id ?? ""), queryFn: () => get<RecordBundle>(api(`work-orders/${encodeURIComponent(id ?? "")}/record`)), enabled: !!id });
export const useRecordMarkdown = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.recordMd(id ?? ""), queryFn: () => getText(api(`work-orders/${encodeURIComponent(id ?? "")}/record.md`)), enabled: !!id });
export const useChanges = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.changes(id ?? ""), queryFn: () => get<unknown>(api(`work-orders/${encodeURIComponent(id ?? "")}/changes`)), enabled: !!id });
/** Download URL of the record bundle with hashes (GET .../record/export). */
export const recordExportUrl = (id: string) => api(`work-orders/${encodeURIComponent(id)}/record/export`);

/* ---------- stop controls ---------- */

export const useKillImpact = (scope: string, id: string | null, enabled = true) =>
  useQuery({ queryKey: qk.killImpact(scope, id), queryFn: () => get<KillImpact>(api("stops/impact"), { scope, id }), enabled });

/* ---------- onboarding ---------- */

export const useRepos = (projectId: string | null | undefined) =>
  useQuery({ queryKey: qk.repos(projectId ?? ""), queryFn: () => get<Repo[]>(api(`projects/${encodeURIComponent(projectId ?? "")}/repos`)), enabled: !!projectId });
/** Repos of several projects in one list (the command palette), each tagged with its project; each project is its own cached read. */
export const useReposAcross = (projectIds: string[]): Array<Repo & { projectId: string }> =>
  useQueries({
    queries: projectIds.map((id) => ({ queryKey: qk.repos(id), queryFn: () => get<Repo[]>(api(`projects/${encodeURIComponent(id)}/repos`)) })),
    combine: (rs) => rs.flatMap((r, i) => (Array.isArray(r.data) ? r.data : []).map((x) => ({ ...x, projectId: projectIds[i] ?? "" }))),
  });
/** The repositories of several projects (the portfolio count of live repos); one query per project, sharing the per-project key. */
export const useReposOf = (projectIds: string[]) =>
  useQueries({ queries: projectIds.map((id) => ({ queryKey: qk.repos(id), queryFn: () => get<Repo[]>(api(`projects/${encodeURIComponent(id)}/repos`)) })) });
export const useGuidelines = () => useQuery({ queryKey: qk.guidelines(), queryFn: () => get<OrgGuidelines>(api("guidelines")) });

/** The four writes a gate decision can make (approve, confirm the brief, reject, decline it), for the Approve and Reject dialogs; views run them through useCommand. */
export const gateOps = { approveGate: ops.approveGate, confirmBrief: ops.confirmBrief, rejectGate: ops.rejectGate, decline: ops.decline };

/* ---------- prompt records (GET /prompt-calls, GET /prompt-traces/:ref; project.view on the call's project, else a 404) ---------- */

export interface PromptCall {
  requestId: string | null; run: string | null; wo: string | null; project: string | null; surface: string | null; station: string | null; turn: string | null;
  model: string; inputTokens: number; outputTokens: number; costMicros: number; promptHash: string | null; trace: string | null; outcome: string; at: string;
}
export interface PromptPart { kind: string; name: string; source?: string; version: number | null; sha256: string; bytes: number }
export interface PromptManifestRead { hash?: string; kind?: string; parts?: PromptPart[]; handoff?: { bytes: number; sha256: string }; conversation?: { messages: number; bytes: number }; compact?: boolean }
export interface PromptTrace { v?: number; kind?: string; model?: string; vendor?: string; status?: number; manifest?: PromptManifestRead | null; request?: unknown; response?: unknown }
/** The recorded model calls of one work order (newest first, at most 200). */
export const usePromptCalls = (woId: string | null | undefined) =>
  useQuery({ queryKey: qk.promptCalls(woId ?? ""), queryFn: async () => (await get<{ calls?: PromptCall[] }>(api("prompt-calls"), { wo: woId ?? "" })).calls ?? [], enabled: !!woId });
/** One stored trace: the manifest of what the model was given, and the request and answer. */
export const usePromptTrace = (ref: string | null | undefined) =>
  useQuery({ queryKey: qk.promptTrace(ref ?? ""), queryFn: async () => (await get<{ trace: PromptTrace }>(api(`prompt-traces/${encodeURIComponent(ref ?? "")}`))).trace, enabled: !!ref, staleTime: Infinity });
