/** Typed reads for this slice of /api/v1. Keys come from ../keys (`qk`). */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, get, getText } from "../client";
import { qk } from "../keys";
import type { PromptCall, PromptTrace, Conversation, EventEntry, FloorData, HomeData, KillImpact, Page, Project, RecordBundle, Repo, SavedView, Template, WorkOrder, OrgGuidelines } from "../types";

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
export const useGuidelines = () => useQuery({ queryKey: qk.guidelines(), queryFn: () => get<OrgGuidelines>(api("guidelines")) });

/**
 * The work orders of several projects as one list (the All projects scope): each project's own list read, page by page up to `cap` per project,
 * newest first. `cut` names the projects whose list was longer than `cap`, so a screen can say the list is cut short. Each read is the same
 * per-project read, so what a person may not see is never in it.
 */
export const useWorkOrdersAcross = (projectIds: readonly string[], o: { cap: number; pageSize: number; enabled: boolean }) =>
  useQuery({
    queryKey: qk.woTable(`all:${projectIds.join(",")}`, { cap: o.cap }),
    queryFn: async () => {
      const items: WorkOrder[] = [];
      const cut: string[] = [];
      for (const id of projectIds) {
        let cursor = "";
        let n = 0;
        for (;;) {
          const pg = await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(id)}/work-orders`), { sort: "id", dir: "desc", limit: o.pageSize, cursor: cursor || undefined });
          items.push(...pg.items);
          n += pg.items.length;
          if (!pg.next) break;
          if (n >= o.cap) { cut.push(id); break; }
          cursor = pg.next;
        }
      }
      return { items, cut };
    },
    enabled: o.enabled && projectIds.length > 0,
    placeholderData: keepPreviousData,
  });

/* ---------- prompt records (what a model was given) ---------- */

/** The recorded model calls of a work order (GET prompt-calls?wo=). The server answers only what this person may read. */
export const usePromptCalls = (wo: string | null | undefined) =>
  useQuery({ queryKey: qk.promptCalls(wo ?? ""), queryFn: async () => (await get<{ ok: boolean; calls: PromptCall[] }>(api("prompt-calls"), { wo })).calls, enabled: !!wo });
/** One stored trace (GET prompt-traces/{hash}): the request, the answer and the prompt manifest. Read only once a person opens a call. */
export const usePromptTrace = (ref: string | null | undefined) =>
  useQuery({ queryKey: qk.promptTrace(ref ?? ""), queryFn: async () => (await get<{ ok: boolean; trace: PromptTrace }>(api(`prompt-traces/${encodeURIComponent(ref ?? "")}`))).trace, enabled: !!ref });
