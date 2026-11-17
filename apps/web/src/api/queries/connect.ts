/** Typed reads for this slice of /api/v1. Keys come from ../keys (`qk`). */
import { useQuery } from "@tanstack/react-query";
import { api, get } from "../client";
import { qk } from "../keys";
import { readIfAllowed } from "../can";
import type { ApiConfig, ApiKey, CardTemplate, Delivery, IntegrationInstance, IntegrationType, McpServer, McpUsage, Page, RequestLogEntry, Trigger, TriggerProposal, TriggerRun } from "../types";
import type { NotificationRoute } from "@gantry/domain";

const INTEG = ["integrations.view"] as const;

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
  useQuery({ queryKey: qk.triggerProposalsBy(status), queryFn: () => get<TriggerProposal[]>(api("trigger-proposals"), { status }) });
export const useTriggerRuns = (id: string | null | undefined) =>
  useQuery({ queryKey: qk.triggerRuns(id ?? ""), queryFn: () => get<TriggerRun[]>(api(`triggers/${encodeURIComponent(id ?? "")}/runs`)), enabled: !!id });
