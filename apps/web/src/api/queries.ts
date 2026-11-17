/**
 * TanStack Query hooks: one per read endpoint in spec section 8. Keys come from ./keys and are
 * named after the legacy store slices so SSE invalidation lines up. Reads return the legacy
 * slice shapes. Hooks that depend on an argument that may be missing are disabled until it exists.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError, get, getText, setCsrfToken } from "./client";
import { qk } from "./keys";
import { readIfAllowed } from "./can";

/* The factory-level reads behind each register (core/read-gates.ts on the server): asked before the request is sent. */
const MODELS = ["models.view"] as const;
const POLICY = ["policy.view"] as const;
const PEOPLE = ["people.view"] as const;
const AGENTS = ["agents.view"] as const;
const INTEG = ["integrations.view"] as const;
const SECURITY = ["security.manage", "policy.view"] as const;
import { usePrefs } from "../lib/prefs";
import type {
  AccessMatrixData, Agent, AgentEffective, AgentInstructions, AgentSuite, ApiConfig, ApiKey, AuditEntry, AuditFilters, CardTemplate, Conversation, Delivery,
  EvalExtra, EvalRun, EventEntry, FloorData, Freeze, HomeData, IntegrationInstance, IntegrationType, KillImpact, LearningFinding,
  LearningProposal, McpServer, McpUsage, Me, Page, Person, Policy, Project, PublicConfig, RecordBundle, Repo, RequestLogEntry,
  Routing, SavedView, Scorecard, SecuritySettings, Session, SignIn, Skill, Template, Trigger, TriggerProposal, TriggerRun, Trust, Vendor,
  WorkOrder, Workload, OrgGuidelines, NavBadge, LearningSignalRow, LearningSettings, Suite,
} from "./types";
import type { NotificationRoute, VendorTemplate } from "@gantry/domain";

/* ---------- session ---------- */

export type MeState = { status: "in"; me: Me } | { status: "out"; config: PublicConfig | null; reason: string };

/** GET /api/v1/me. A 401 is a normal answer (nobody signed in), not an error; its body may carry the public config. */
export async function fetchMe(): Promise<MeState> {
  const res = await fetch(api("me"), { credentials: "include", headers: { Accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 401) {
    setCsrfToken(null);
    const b = (body ?? {}) as { config?: PublicConfig; msg?: string };
    return { status: "out", config: b.config ?? null, reason: b.msg ?? "" };
  }
  if (!res.ok) throw new ApiError(res.status, "Could not load your session.", body);
  const me = body as Me;
  setCsrfToken(typeof me.csrf === "string" ? me.csrf : null);
  return { status: "in", me };
}

export const useMeState = (): UseQueryResult<MeState> =>
  useQuery({ queryKey: qk.me(), queryFn: fetchMe, staleTime: 30_000, retry: 1, refetchOnWindowFocus: true });

/** The signed-in session, or null while loading or signed out. */
export function useMe(): Me | null {
  const q = useMeState();
  return q.data?.status === "in" ? q.data.me : null;
}

/** `all`: everyone's sessions (Security screen); the server returns only the caller's own without security.manage. */
export const useSessions = (o: { all?: boolean } = {}) =>
  useQuery({ queryKey: o.all ? [...qk.sessions(), "all"] : qk.sessions(), queryFn: () => get<Session[]>(api("sessions"), o.all ? { all: "1" } : undefined) });
export const useSecurity = () => useQuery({ queryKey: qk.security(), queryFn: () => readIfAllowed(SECURITY, () => get<SecuritySettings>(api("security"))) });
export const useSignins = (q: { cursor?: string; limit?: number; all?: "1" } = {}) =>
  useQuery({ queryKey: [...qk.signins(), q], queryFn: () => get<SignIn[] | Page<SignIn>>(api("signins"), q) });

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

/* ---------- agents, skills, models, evals, trust, learning ---------- */

export const useAgents = () => useQuery({ queryKey: qk.agents(), queryFn: () => get<Agent[]>(api("agents")) });
/** The eval suites an agent may be gated on. */
export const useAgentSuites = () => useQuery({ queryKey: ["agents", "suites"], queryFn: () => readIfAllowed(AGENTS, () => get<AgentSuite[]>(api("agents/suites"))) });
export const useAgentEffective = (id: string | null | undefined, q: { project?: string; repo?: string; version?: string } = {}) =>
  useQuery({
    queryKey: qk.agentEffective(id ?? "", q),
    queryFn: () => get<AgentEffective>(api(`agents/${encodeURIComponent(id ?? "")}/effective`), q),
    enabled: !!id,
  });
export const useInstructions = () => useQuery({ queryKey: ["instructions"], queryFn: () => readIfAllowed(AGENTS, () => get<AgentInstructions>(api("instructions/base"))) });
export const useSkills = () => useQuery({ queryKey: qk.skills(), queryFn: () => get<Skill[]>(api("skills")) });
export const useVendors = () => useQuery({ queryKey: qk.vendors(), queryFn: () => readIfAllowed(MODELS, () => get<Vendor[]>(api("vendors"))) });
export const useVendorTemplates = () => useQuery({ queryKey: ["vendor-templates"], queryFn: () => readIfAllowed(MODELS, () => get<VendorTemplate[]>(api("vendor-templates"))), staleTime: 3_600_000 });
export const useRouting = () => useQuery({ queryKey: qk.routing(), queryFn: () => readIfAllowed(MODELS, () => get<Routing>(api("routing"))) });
export interface PriceVersion { version: number; effectiveFrom: string; publishedAt: string; publishedBy: string | null; note: string; prices: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }> }
export const usePrices = () => useQuery({ queryKey: qk.prices(), queryFn: () => readIfAllowed(MODELS, () => get<{ current: number | null; versions: PriceVersion[] }>(api("prices"))) });
export interface BudgetRow { project: string; monthly: number; alertAt: number; perWorkOrder: number; spent: number; version: number }
export const useBudgets = () => useQuery({ queryKey: qk.budgets(), queryFn: () => readIfAllowed(MODELS, () => get<BudgetRow[]>(api("budgets"))) });
export interface RouteAnswer { model: string | null; vendor: string | null; wanted: string | null; layer: string; steps: string[]; blocked: string | null; crossModel: boolean; sameModelFallback: boolean; rule: { id: string; tag: string } | null }
export const useRoutingResolve = (q: { station?: string; repo?: string; project?: string; class?: string }, enabled = true) =>
  useQuery({ queryKey: qk.routingResolve(q), queryFn: () => readIfAllowed(MODELS, () => get<RouteAnswer>(api("routing/resolve"), q)), enabled });
export const useScorecards = () => useQuery({ queryKey: qk.scorecards(), queryFn: () => get<Record<string, Scorecard>>(api("evals/scorecards")) });
export const useSuiteRuns = (suiteId: string | null | undefined) =>
  useQuery({ queryKey: qk.suiteRuns(suiteId ?? ""), queryFn: () => get<EvalRun[]>(api(`suites/${encodeURIComponent(suiteId ?? "")}/runs`)), enabled: !!suiteId });
export const useEvalsFactory = () => useQuery({ queryKey: qk.evalsFactory(), queryFn: () => get<EvalExtra>(api("evals/factory")) });
/** The trust ladder the viewer can see. With a project, that project's cells that do not exist yet come too (marked `virtual`). */
export const useTrustCells = (project?: string | null) =>
  useQuery({ queryKey: qk.trustCells(project), queryFn: () => get<Trust>(api("trust/cells"), project ? { project } : undefined) });
/** Eval suites with their cases. */
export const useSuites = () => useQuery({ queryKey: qk.suites(), queryFn: () => get<Suite[]>(api("suites")) });
/** The recent runs of every suite, in one request (the Evals screen would otherwise ask once per suite). */
export const useAllSuiteRuns = () => useQuery({ queryKey: qk.suiteRuns("*"), queryFn: () => get<EvalRun[]>(api("evals/runs")) });
export const useLearningFindings = () => useQuery({ queryKey: qk.learningFindings(), queryFn: () => get<LearningFinding[]>(api("learning/findings")) });
export const useLearningProposals = () => useQuery({ queryKey: qk.learningProposals(), queryFn: () => get<LearningProposal[]>(api("learning/proposals")) });
export const useLearningSignals = (days = 30) => useQuery({ queryKey: qk.learningSignals(days), queryFn: () => get<LearningSignalRow[]>(api("learning/signals"), { days }) });
export const useLearningSettings = () => useQuery({ queryKey: qk.learningSettings(), queryFn: () => get<LearningSettings>(api("learning/settings")) });

/* ---------- integrations, notifications, MCP, keys, triggers ---------- */

export const useIntegrationTypes = () => useQuery({ queryKey: qk.integrationTypes(), queryFn: () => get<IntegrationType[]>(api("integration-types")) });
export const useIntegrations = () => useQuery({ queryKey: qk.integrations(), queryFn: () => get<IntegrationInstance[]>(api("integrations")) });
/** A project's routes with their versions (each edit sends its route's version as If-Match). */
export const useRoutes = (projectId: string | null | undefined) =>
  useQuery({ queryKey: qk.routes(projectId ?? ""), queryFn: () => get<Array<NotificationRoute & { version: number }>>(api(`projects/${encodeURIComponent(projectId ?? "")}/routes`)), enabled: !!projectId });
export const useChatLinks = () => useQuery({ queryKey: qk.chatLinks(), queryFn: () => get<Array<{ id: string; channel: string; externalId: string; verifiedAt: number | null; person: string }>>(api("chat-links")) });
export const useDeliveries = (q: { cursor?: string; limit?: number; project?: string; status?: string; integration?: string; event?: string } = {}) =>
  useQuery({ queryKey: qk.deliveries(q), queryFn: () => get<Delivery[] | Page<Delivery>>(api("deliveries"), q) });
export const useCardTemplates = () => useQuery({ queryKey: qk.cardTemplates(), queryFn: () => get<CardTemplate[]>(api("card-templates")) });
export const useMcpServers = () => useQuery({ queryKey: qk.mcpServers(), queryFn: () => get<McpServer[]>(api("mcp/servers")) });
export interface McpAccessQuery { server?: string; tool?: string; agent?: string; project?: string; repo?: string; station?: string; cls?: string }
export interface McpAccessDecision { allowed: boolean; gated?: boolean; reason: string; rule: string }
export const useMcpAccessCheck = (q: McpAccessQuery, enabled = true) =>
  useQuery({ queryKey: qk.mcpAccess(q), queryFn: () => readIfAllowed(INTEG, () => get<McpAccessDecision>(api("mcp/access-check"), q as Record<string, string | undefined>)), enabled });
export const useMcpCalls = (q: { cursor?: string; limit?: number; server?: string } = {}) =>
  useQuery({ queryKey: qk.mcpCalls(q), queryFn: () => readIfAllowed(INTEG, () => get<McpUsage[] | Page<McpUsage>>(api("mcp/calls"), q)) });
export const useApiKeys = () => useQuery({ queryKey: qk.apiKeys(), queryFn: () => get<ApiKey[]>(api("api-keys")) });
export const useApiConfig = () => useQuery({ queryKey: qk.apiConfig(), queryFn: () => get<ApiConfig>(api("api-config")) });
export const useApiRequests = (q: { cursor?: string; limit?: number } = {}) =>
  useQuery({ queryKey: qk.apiRequests(q), queryFn: () => get<RequestLogEntry[] | Page<RequestLogEntry>>(api("api-requests"), q) });
export const useTriggers = () => useQuery({ queryKey: qk.triggers(), queryFn: () => get<Trigger[]>(api("triggers")) });
export const useTriggerProposals = (status = "held") =>
  useQuery({ queryKey: [...qk.triggerProposals(), status], queryFn: () => get<TriggerProposal[]>(api("trigger-proposals"), { status }) });
export const useTriggerRuns = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.triggerRuns(id ?? ""), queryFn: () => get<TriggerRun[]>(api(`triggers/${encodeURIComponent(id ?? "")}/runs`)), enabled: !!id });

/* ---------- people, access, audit, workload ---------- */

export const usePeople = () => useQuery({ queryKey: qk.people(), queryFn: () => get<Person[]>(api("people")) });
export const useEffectivePermissions = (personId: string | null | undefined) =>
  useQuery({ queryKey: qk.effectivePermissions(personId ?? ""), queryFn: () => readIfAllowed(PEOPLE, () => get<unknown>(api(`people/${encodeURIComponent(personId ?? "")}/effective-permissions`))), enabled: !!personId });
export const useAccessMatrix = () => useQuery({ queryKey: qk.matrix(), queryFn: () => readIfAllowed(POLICY, () => get<AccessMatrixData>(api("access/matrix"))) });
export const usePolicies = () => useQuery({ queryKey: qk.policies(), queryFn: () => readIfAllowed(POLICY, () => get<Policy[]>(api("policies"))) });
export const useFreezes = () => useQuery({ queryKey: qk.freezes(), queryFn: () => readIfAllowed(POLICY, () => get<Freeze[]>(api("freezes"))) });
export const useAudit = (filters: AuditFilters = {}) =>
  useQuery({ queryKey: qk.audit(filters), queryFn: () => get<Page<AuditEntry> | AuditEntry[]>(api("audit"), { ...filters }) });
export const useAuditEntry = (seq: number | string | null | undefined) =>
  useQuery({ queryKey: qk.auditEntry(seq ?? ""), queryFn: () => get<AuditEntry>(api(`audit/${encodeURIComponent(String(seq))}`)), enabled: seq != null && seq !== "" });
/** Walks the hash chain server-side. Not cached long: a verification is a statement about now. */
export const useAuditVerify = (enabled = false) =>
  useQuery({ queryKey: qk.auditVerify(), queryFn: () => get<{ ok: boolean; checked: number; [k: string]: unknown }>(api("audit/verify")), enabled, staleTime: 0 });
export const useWorkload = (scope?: string, days?: number) => useQuery({ queryKey: qk.workload(scope, days), queryFn: () => get<Workload>(api("workload"), { scope, days }), placeholderData: (prev) => prev });

/** Nav badges for the left nav, from GET /home. Empty until home loads. */
export function useNavBadges(): Record<string, NavBadge> {
  const home = useHome();
  const project = usePrefs().project;
  // Floor, work-order and onboarding badges follow the selected project; the API gives them per project.
  const byProject = (home.data?.projectBadges ?? {}) as Record<string, Record<string, NavBadge>>;
  const b: Record<string, NavBadge> = { ...(home.data?.badges ?? {}), ...(project ? byProject[project] ?? {} : {}) };
  // The conversations now live in Agents at work: its item carries their badge.
  if (b.conversations && !b.workspace) b.workspace = b.conversations;
  // The Inbox counts what waits for this person: gate and onboarding approvals, and questions addressed to them.
  const waiting = (home.data?.approvals?.length ?? 0) + (home.data?.conversations?.length ?? 0);
  if (waiting && !b.inbox) b.inbox = { n: waiting, label: `${waiting} waiting for you` };
  return b;
}

export type { Me };
