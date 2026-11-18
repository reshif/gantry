/**
 * Query keys, named after the legacy G.store slices so the SSE `change` event ({"keys":["workOrders","audit"]})
 * maps straight onto TanStack Query invalidation: every key starts with its slice name, and
 * invalidating ["workOrders"] refreshes the list, the detail and anything keyed under it.
 */
import type { QueryClient } from "@tanstack/react-query";

export type KeyPart = string | number | boolean | null | undefined | Record<string, unknown>;

/** Slices whose reads also depend on another slice. Invalidating the key refreshes its dependents too. */
export const DEPENDENTS: Readonly<Record<string, readonly string[]>> = {
  workOrders: ["floor", "home", "conversations", "record", "changes", "events", "workload", "workspace"],
  console: ["workspace"],
  conversations: ["workspace"],
  repos: ["home", "workspace"],
  projects: ["floor", "home", "me", "repos", "notifications"],
  people: ["me", "home", "workload"],
  matrix: ["me", "home"],
  policies: ["home", "me"],
  freezes: ["home", "policies"],
  factory: ["me", "home", "floor"],
  session: ["me", "sessions"],
  sessions: ["me"],
  trust: ["home"],
  learning: ["home"],
  integrationInstances: ["home"],
  mcp: ["mcpUsage"],
  integrations: ["integrationInstances"],
  audit: ["activity"],
};

/** Slices that change what a `can()` decision answers. */
export const CAN_SLICES: readonly string[] = ["matrix", "policies", "people", "factory", "freezes", "session", "projects"];

/** The distinct top-level query keys to invalidate for a list of changed slices. */
export function expandSlices(slices: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of slices) {
    out.add(s);
    for (const d of DEPENDENTS[s] ?? []) out.add(d);
  }
  return [...out];
}

export function affectsCan(slices: readonly string[]): boolean {
  return slices.some((s) => CAN_SLICES.includes(s));
}

let client: QueryClient | null = null;
const canListeners = new Set<() => void>();

export function bindQueryClient(qc: QueryClient | null): void {
  client = qc;
}
export function getQueryClient(): QueryClient | null {
  return client;
}
/** Subscribed to by the can() cache so a matrix/policy/people change clears cached decisions. */
export function onCanInvalidated(fn: () => void): () => void {
  canListeners.add(fn);
  return () => {
    canListeners.delete(fn);
  };
}

/** Invalidate the queries behind the given slices (and the can() cache when a decision input changed). */
export function invalidateSlices(slices: readonly string[]): void {
  if (affectsCan(slices)) for (const fn of [...canListeners]) fn();
  if (!client) return;
  for (const key of expandSlices(slices)) void client.invalidateQueries({ queryKey: [key] });
}

/** Key builders. Every key's first element is the slice name. */
export const qk = {
  me: () => ["me"] as const,
  sessions: () => ["sessions"] as const,
  security: () => ["security"] as const,
  signins: () => ["signins"] as const,
  home: () => ["home"] as const,
  activity: (project?: string) => ["activity", project ?? null] as const,
  projects: () => ["projects"] as const,
  project: (id: string) => ["projects", "one", id] as const,
  savedViews: () => ["savedViews"] as const,
  templates: () => ["templates"] as const,
  floor: (project: string, at?: number | string) => ["floor", project, at ?? null] as const,
  events: (project: string, q: object) => ["events", project, q] as const,
  workOrders: (project: string, q?: object) => ["workOrders", "list", project, q ?? null] as const,
  workOrder: (id: string) => ["workOrders", "one", id] as const,
  conversations: (q?: object) => ["conversations", q ?? null] as const,
  record: (id: string) => ["record", id] as const,
  recordMd: (id: string) => ["record", id, "md"] as const,
  changes: (id: string) => ["changes", id] as const,
  killImpact: (scope: string, id: string | null) => ["stops", "impact", scope, id] as const,
  repos: (project: string) => ["repos", project] as const,
  guidelines: () => ["guidelines"] as const,
  agents: () => ["agents"] as const,
  agentEffective: (id: string, q: object) => ["agents", "effective", id, q] as const,
  skills: () => ["skills"] as const,
  vendors: () => ["vendors"] as const,
  routing: () => ["routing"] as const,
  routingVersions: () => ["routing", "versions"] as const,
  routingResolve: (q: object) => ["routing", "resolve", q] as const,
  prices: () => ["vendors", "prices"] as const,
  budgets: () => ["vendors", "budgets"] as const,
  scorecards: () => ["scorecards"] as const,
  suiteRuns: (suite: string) => ["evalRuns", suite] as const,
  evalsFactory: () => ["evalExtra"] as const,
  trustCells: (project?: string | null) => (project ? (["trust", "cells", project] as const) : (["trust"] as const)),
  suites: () => ["suites"] as const,
  learningFindings: () => ["learning", "findings"] as const,
  learningProposals: () => ["learning", "proposals"] as const,
  learningSignals: (days?: number) => ["learning", "signals", days ?? null] as const,
  learningSettings: () => ["learning", "settings"] as const,
  integrationTypes: () => ["integrationTypes"] as const,
  integrations: () => ["integrationInstances"] as const,
  routes: (project: string) => ["notifications", project] as const,
  deliveries: (q?: object) => ["deliveries", q ?? null] as const,
  cardTemplates: () => ["cardTemplates"] as const,
  chatLinks: () => ["chatLinks"] as const,
  mcpServers: () => ["mcp"] as const,
  mcpAccess: (q: object) => ["mcp", "access", q] as const,
  mcpCalls: (q?: object) => ["mcpUsage", q ?? null] as const,
  apiKeys: () => ["apiKeys"] as const,
  apiConfig: () => ["apiConfig"] as const,
  apiRequests: (q?: object) => ["requestLog", q ?? null] as const,
  triggers: () => ["triggers"] as const,
  triggerRuns: (id: string) => ["triggers", "runs", id] as const,
  triggerProposals: () => ["triggers", "proposals"] as const,
  people: () => ["people"] as const,
  effectivePermissions: (id: string) => ["people", "effective", id] as const,
  permissionCell: (person: string, action: string | undefined, project: string | undefined) => ["people", "cell", person, action, project] as const,
  factoryStops: () => ["factory", "stops"] as const,
  woDocumentComments: (wo: string) => ["workOrders", "documentComments", wo] as const,
  matrix: () => ["matrix"] as const,
  policies: () => ["policies"] as const,
  freezes: () => ["freezes"] as const,
  audit: (filters: object) => ["audit", "list", filters] as const,
  auditEntry: (seq: number | string) => ["audit", "entry", seq] as const,
  auditVerify: () => ["audit", "verify"] as const,
  workload: (scope?: string, days?: number) => ["workload", scope ?? null, days ?? null] as const,
  /* Keys that views used to spell as literals. Every key still starts with its slice name, so SSE invalidation is unchanged. */
  teams: () => ["teams"] as const,
  catalog: () => ["projects", "catalog"] as const,
  presets: () => ["templates", "presets"] as const,
  sessionsAll: () => ["sessions", "all"] as const,
  signinsList: (q: object) => ["signins", q] as const,
  agentSuites: () => ["agents", "suites"] as const,
  instructions: () => ["instructions"] as const,
  vendorTemplates: () => ["vendor-templates"] as const,
  triggerProposalsBy: (status?: string) => ["triggers", "proposals", status] as const,
  woTable: (project: string | null | undefined, params: object) => ["workOrders", "table", project, params] as const,
  woStats: (project: string | null | undefined) => ["workOrders", "stats", project] as const,
  woSnapshot: (project: string | null | undefined) => ["workOrders", "snapshot", project] as const,
  woIntake: (project: string | null | undefined) => ["workOrders", "intake", project] as const,
  woRecords: (project: string | null | undefined, params: object) => ["workOrders", "records", project, params] as const,
  woApprovers: (wo: string, gate: string) => ["workOrders", "approvers", wo, gate] as const,
  woDocuments: (wo: string) => ["workOrders", "documents", wo] as const,
  woDocument: (wo: string, id: string) => ["workOrders", "document", wo, id] as const,
  woDialogue: (wo: string) => ["workOrders", "dialogue", wo] as const,
  promptCalls: (wo: string) => ["promptCalls", wo] as const,
  promptTrace: (ref: string) => ["promptTrace", ref] as const,
  woSources: (wo: string) => ["workOrders", "sources", wo] as const,
  woSource: (wo: string, ref: string) => ["workOrders", "source", wo, ref] as const,
  woTimeline: (wo: string) => ["workOrders", "timeline", wo] as const,
  convSessions: (project: string | null) => ["conversations", "sessions", project] as const,
  convMentionable: (woId: string, query: string | null) => ["conversations", "mentionable", woId, query] as const,
  wsAgents: (wo: string) => ["workspace", "agents", wo] as const,
  cardPreview: (project: string | null | undefined, event: string, template: string, fields: object, actions: string[] | null) => ["cardPreview", project, event, template, fields, actions] as const,
  notifyPreview: (event: string, project: string) => ["notifications", "preview", event, project] as const,
  peopleCell: (person: string, action: string | undefined, project: string | undefined) => ["people", "cell", person, action, project] as const,
  systemHealth: () => ["system", "health"] as const,
  reposAvailable: (project: string) => ["repos", project, "available"] as const,
  repoPr: (repo: string, key: unknown) => ["repos", "pr", repo, key] as const,
};
