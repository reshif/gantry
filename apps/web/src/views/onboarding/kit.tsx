/**
 * Shared pieces of the Onboarding screen (legacy onboarding.js helpers): stage and status of a repo, the stepper, the settings draft the wizard and the settings dialog share,
 * and the reads the screen needs beyond the repo list (source integrations, available repositories, the pull request's files).
 */
import { useQuery } from "@tanstack/react-query";
import { NOTIFY_EVENTS, ONBOARD_STAGES, type IntegrationInstance, type IntegrationType, type NotifyOverride, type Project, type Repo } from "@gantry/domain";
import { api, get } from "../../api/client";
import { useIntegrationTypes, useIntegrations } from "../../api/queries";
import { Icon } from "../../ui/Icon";
import { useTeams } from "../projects/kit";

export type RepoV = Repo & { version?: number };
export const STAGES = ONBOARD_STAGES;
const stageIds = (): string[] => STAGES.map((s) => s.id);

export function stageName(id: string): string {
  const s = STAGES.find((x) => x.id === id);
  return s ? s.name : id === "person" ? "Needs a person" : id === "failed" ? "Failed" : id;
}

/** Index of the stage reached; for person/failed, the stage where it stopped. */
export function stageIndex(r: RepoV): number {
  const o = r.onboarding;
  const i = stageIds().indexOf(o.stage);
  if (i >= 0) return i;
  if (o.pr && o.pr.state === "merged") return 4;
  if (o.pr) return o.pr.checks === "pending" ? 2 : 3;
  if (o.findings.length) return 1;
  return 0;
}
export const isStopped = (r: RepoV): boolean => r.onboarding.stage === "person" || r.onboarding.stage === "failed";
export const needsMerge = (r: RepoV): boolean => {
  const o = r.onboarding;
  return !!o.pr && o.pr.state === "open" && o.pr.checks === "green" && o.stage === "pr_checks";
};
export const gaps = (r: RepoV) => r.onboarding.findings.filter((f) => !f.ok);

export interface Status {
  id: "ready" | "exception" | "person" | "failed" | "merge" | "progress";
  label: string;
  glyph: string;
}
export function status(r: RepoV): Status {
  const o = r.onboarding;
  if (o.stage === "ready") return o.exception ? { id: "exception", label: "Ready by exception", glyph: "shield" } : { id: "ready", label: "Ready", glyph: "st-done" };
  if (o.stage === "person") return { id: "person", label: "Needs a person", glyph: "human" };
  if (o.stage === "failed") return { id: "failed", label: "Failed", glyph: "st-fail" };
  if (needsMerge(r)) return { id: "merge", label: "Waiting for merge", glyph: "st-wait" };
  return { id: "progress", label: "In progress", glyph: "st-run" };
}

export function StatusChip({ r }: { r: RepoV }) {
  const s = status(r);
  return (
    <span className={`onb-status onb-st-${s.id}`}>
      <Icon name={s.glyph} />
      <span>{s.label}</span>
    </span>
  );
}

/** What the worker is doing for the repo right now, in words. */
export const BUSY: Record<string, string> = {
  assessing: "The Onboarding agent is assessing the repo.",
  opening_pr: "The Onboarding agent is opening the pull request.",
  updating_pr: "The Onboarding agent is updating the pull request.",
  merging: "GitHub is being asked to merge the pull request.",
  verifying: "Gantry is running the live checks against GitHub.",
};

export function Steps({ r, big }: { r: RepoV; big?: boolean }) {
  const idx = stageIndex(r);
  const stop = isStopped(r);
  const ready = r.onboarding.stage === "ready";
  return (
    <ol className={`onb-steps${big ? " is-big" : ""}`} aria-label={`Onboarding stage: ${stageName(r.onboarding.stage)} (${idx + 1} of 7)`}>
      {STAGES.map((s, i) => {
        const cls = i < idx || (ready && i === idx) ? "is-done" : i === idx ? (stop ? "is-stop" : "is-now") : "";
        return (
          <li key={s.id} className={cls} title={s.name + (cls === "is-done" ? ": done" : cls === "is-now" ? ": current" : cls === "is-stop" ? ": stopped here" : "")}>
            <span className="onb-step-mark mono" aria-hidden="true">{cls === "is-done" ? "✓" : cls === "is-stop" ? "!" : String(i + 1)}</span>
            {big ? <span className="onb-step-l">{s.name}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function useTeamName(): (id: string) => string {
  const teams = useTeams();
  return (id) => teams.find((t) => t.id === id)?.name ?? id;
}

/* ---------- source-control integrations ---------- */

export interface SourceInfo {
  inst: IntegrationInstance;
  type: Partial<IntegrationType>;
}
const isSource = (t: Partial<IntegrationType> | undefined): boolean => !!t && (t.category === "source" || (!!t.custom && !!t.source && t.category === "source"));
const open = (i: IntegrationInstance, project: string): boolean => i.projects === "all" || (Array.isArray(i.projects) && i.projects.includes(project));

/** The project's source-control instances and its notification destinations, from the integrations read (empty while that read is unavailable). */
export function useIntegrationsFor(project: string): { sources: SourceInfo[]; dests: SourceInfo[]; all: SourceInfo[] } {
  const inst = useIntegrations().data;
  const types = useIntegrationTypes().data;
  const list: SourceInfo[] = (Array.isArray(inst) ? inst : []).map((i) => ({ inst: i, type: (Array.isArray(types) ? types : []).find((t) => t.id === i.type) ?? {} }));
  return {
    all: list,
    sources: list.filter((x) => isSource(x.type) && open(x.inst, project)),
    dests: list.filter((x) => !!x.type.destination && open(x.inst, project)),
  };
}
export const instLabel = (i: IntegrationInstance): string => i.name + (i.status !== "healthy" ? ` (${i.status})` : "");
export const orgOf = (i: IntegrationInstance | null | undefined): string => {
  const c = i?.config ?? {};
  return String(c.org || c.group || c.workspace || "");
};

/* ---------- reads ---------- */

export interface AvailableRepos {
  /** null: GitHub could not be asked (see `unavailable`). */
  available: Array<{ repo: string; lang: string }> | null;
  unavailable?: string;
  hidden?: number;
}
/** Repositories the GitHub App can see and Gantry has not connected yet. */
export const useAvailableRepos = (projectId: string, enabled: boolean) =>
  useQuery({ queryKey: ["repos", projectId, "available"], queryFn: () => get<AvailableRepos>(api(`projects/${encodeURIComponent(projectId)}/repos/available`)), enabled, staleTime: 15_000, retry: false });

export interface PrFiles {
  number: number | null;
  files: Array<{ path: string; plus: number; minus: number; finding: string; mode?: string; added?: string[] }>;
}
/** The onboarding pull request's files with the lines each adds. */
export const usePrFiles = (repoId: string, enabled: boolean, key: unknown) =>
  useQuery({ queryKey: ["repos", "pr", repoId, key], queryFn: () => get<PrFiles>(api(`repos/${encodeURIComponent(repoId)}/onboarding/pr`)), enabled, retry: false });

/* ---------- settings draft (shared by the wizard and the settings dialog) ---------- */

export interface DraftRoute {
  event: string;
  integration: string | null;
  channel: string;
  target: string;
  template: string;
  mode?: string;
}
export interface Draft {
  name: string;
  /** An integration instance, or "" for the GitHub App itself. */
  source: string;
  team: string;
  mcp: string[];
  triggers: boolean;
  notify: DraftRoute[];
  defaultBranch: string;
  branchPrefix: string;
  merge: string;
  tagging: string;
  requiredChecks: string;
  protectedPaths: string;
}

export const defaultTemplate = (ev: string): string => ({ submitted: "submitted", question: "question", "gate.waiting": "gate", "gate.decided": "gate", blocked: "incident", "security.hold": "incident", andon: "incident", kill: "kill", restore: "kill", "onboarding.pr": "onboarding", released: "release", "eval.regression": "eval", budget: "budget" } as Record<string, string>)[ev] ?? "submitted";

export function draftFrom(r: RepoV | null, project: Project, dests: SourceInfo[]): Draft {
  const c = r ? r.config : { defaultBranch: "main", branchPrefix: "gantry/", merge: project.regulated ? "merge" : "squash", tagging: "semver-patch", requiredChecks: ["ci/test"], protectedPaths: [".github/workflows/**"] };
  const chat = dests.find((x) => x.inst.type === "slack" && x.inst.status === "healthy") ?? dests.find((x) => x.inst.status === "healthy") ?? dests[0] ?? null;
  const notify: DraftRoute[] = r
    ? (r.notifyOverrides ?? []).map((n: NotifyOverride) => {
        const d0 = n.dest[0] ?? { channel: "slack", target: "" };
        return { event: n.event, integration: d0.integration ?? null, channel: d0.channel, target: d0.target, template: n.template || defaultTemplate(n.event), mode: n.mode };
      })
    : chat ? [{ event: "onboarding.pr", integration: chat.inst.id, channel: chat.inst.type, target: chat.inst.type === "email" ? "project admins" : `#${project.teams[0] ?? "platform"}-eng`, template: "onboarding" }] : [];
  return {
    name: "", source: r?.source ?? "", team: r ? r.team : project.teams[0] ?? "platform", mcp: r ? r.mcp.slice() : project.mcp.slice(0, 2), triggers: r ? !!r.triggers : true, notify,
    defaultBranch: c.defaultBranch, branchPrefix: c.branchPrefix, merge: c.merge, tagging: c.tagging, requiredChecks: c.requiredChecks.join(", "), protectedPaths: c.protectedPaths.join("\n"),
  };
}

export function patchFrom(d: Draft): Record<string, unknown> {
  const events = new Set(NOTIFY_EVENTS.map((e) => e.id));
  return {
    team: d.team, mcp: d.mcp.slice(), triggers: d.triggers, source: d.source || null,
    notifyOverrides: d.notify.filter((n) => n.target.trim() && n.integration && events.has(n.event)).map((n, i) => ({ id: `RO-${i + 1}`, event: n.event, dest: [{ channel: n.channel, target: n.target.trim(), integration: n.integration }], template: n.template, mode: n.mode || "also" })),
    config: {
      defaultBranch: d.defaultBranch.trim() || "main", branchPrefix: d.branchPrefix.trim() || "gantry/", merge: d.merge, tagging: d.tagging,
      requiredChecks: d.requiredChecks.split(",").map((s) => s.trim()).filter(Boolean), protectedPaths: d.protectedPaths.split("\n").map((s) => s.trim()).filter(Boolean),
    },
  };
}
