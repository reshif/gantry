/** Typed reads for this slice of /api/v1. Keys come from ../keys (`qk`). */
import { useQuery } from "@tanstack/react-query";
import { api, get } from "../client";
import { qk } from "../keys";
import { readIfAllowed } from "../can";
import type { Agent, AgentEffective, AgentInstructions, AgentSuite, EvalExtra, EvalRun, LearningFinding, LearningProposal, Routing, Scorecard, Skill, Trust, Vendor, LearningSignalRow, LearningSettings, Suite } from "../types";
import type { VendorTemplate } from "@gantry/domain";

const MODELS = ["models.view"] as const;
const AGENTS = ["agents.view"] as const;

/* ---------- agents, skills, models, evals, trust, learning ---------- */

export const useAgents = () => useQuery({ queryKey: qk.agents(), queryFn: () => get<Agent[]>(api("agents")) });
/** The eval suites an agent may be gated on. */
export const useAgentSuites = () => useQuery({ queryKey: qk.agentSuites(), queryFn: () => readIfAllowed(AGENTS, () => get<AgentSuite[]>(api("agents/suites"))) });
export const useAgentEffective = (id: string | null | undefined, q: { project?: string; repo?: string; version?: string } = {}) =>
  useQuery({
    queryKey: qk.agentEffective(id ?? "", q),
    queryFn: () => get<AgentEffective>(api(`agents/${encodeURIComponent(id ?? "")}/effective`), q),
    enabled: !!id,
  });
export interface SurfaceBindingRow { surface: string; label: string; source: "station" | "fixed" | "binding" | "none"; agent: string | null; agentName: string | null; configurable: boolean; note: string }
export const useAgentBindings = () => useQuery({ queryKey: ["agents", "bindings"], queryFn: () => get<{ surfaces: SurfaceBindingRow[] }>(api("agents/bindings")) });
export const useInstructions = () => useQuery({ queryKey: qk.instructions(), queryFn: () => readIfAllowed(AGENTS, () => get<AgentInstructions>(api("instructions/base"))) });
export const useSkills = () => useQuery({ queryKey: qk.skills(), queryFn: () => get<Skill[]>(api("skills")) });
export const useVendors = () => useQuery({ queryKey: qk.vendors(), queryFn: () => readIfAllowed(MODELS, () => get<Vendor[]>(api("vendors"))) });
export const useVendorTemplates = () => useQuery({ queryKey: qk.vendorTemplates(), queryFn: () => readIfAllowed(MODELS, () => get<VendorTemplate[]>(api("vendor-templates"))), staleTime: 3_600_000 });
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
