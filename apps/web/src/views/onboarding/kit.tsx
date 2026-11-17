/**
 * Shared pieces of the Onboarding screen (legacy onboarding.js helpers): stage and status of a repo, the stepper, the settings draft the wizard and the settings dialog share,
 * and the reads the screen needs beyond the repo list (source integrations, available repositories, the pull request's files).
 */
import { useQuery } from "@tanstack/react-query";
import { NOTIFY_EVENTS, ONBOARD_STAGES, type IntegrationInstance, type IntegrationType, type NotifyOverride, type Project, type Repo } from "@gantry/domain";
import { api, get } from "../../api/client";
import { useIntegrationTypes, useIntegrations } from "../../api/queries";
import { PipelineRail } from "../../ui/pipeline";
import { Status as UiStatus, type Tone } from "../../ui/primitives";
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
  return !!o.pr && o.pr.state === "open" && (o.pr.checks === "green" || o.pr.checks === "none") && o.stage === "pr_checks";
};
export const gaps = (r: RepoV) => r.onboarding.findings.filter((f) => !f.ok);
/** Gaps an onboarding PR can fix (a file to add or change, not a manual step). */
export const fixable = (r: RepoV): boolean => r.onboarding.findings.some((f) => !f.ok && !!f.file && !f.manual);
/** Assessed, nothing running, no PR yet, and the PR has something to add: nothing moves until a person opens the onboarding PR. */
export const needsPr = (r: RepoV): boolean => {
  const o = r.onboarding;
  return ["assessed", "failed"].includes(o.stage) && !o.busy && (!o.pr || o.pr.state === "closed") && fixable(r);
};

export interface Status {
  id: "ready" | "exception" | "person" | "failed" | "merge" | "openpr" | "progress";
  label: string;
  glyph: string;
}
export function status(r: RepoV): Status {
  const o = r.onboarding;
  if (o.stage === "ready") return o.exception ? { id: "exception", label: "Ready by exception", glyph: "shield" } : { id: "ready", label: "Ready", glyph: "st-done" };
  if (o.stage === "person") return { id: "person", label: "Needs a person", glyph: "human" };
  if (o.stage === "failed") return { id: "failed", label: "Failed", glyph: "st-fail" };
  if (needsMerge(r)) return { id: "merge", label: "Waiting for merge", glyph: "st-wait" };
  if (o.stage === "assessed" && needsPr(r)) return { id: "openpr", label: "Open the PR", glyph: "branch" };
  return { id: "progress", label: "In progress", glyph: "st-run" };
}

const STATUS_TONE: Record<Status["id"], Tone> = { ready: "done", exception: "wait", person: "block", failed: "fail", merge: "wait", openpr: "wait", progress: "run" };

/** The repo's state as the one shared status badge. The wrapper keeps the `onb-st-<id>` hook. */
export function StatusChip({ r }: { r: RepoV }) {
  const s = status(r);
  return (
    <span className={`onb-status onb-st-${s.id}`}>
      <UiStatus tone={STATUS_TONE[s.id]} icon={s.glyph}>{s.label}</UiStatus>
    </span>
  );
}

/** What the worker is doing for the repo right now, in words. The agent is named only while a run of it exists (see `busyText`). */
export const BUSY: Record<string, string> = {
  assessing: "Gantry is assessing the repo.",
  opening_pr: "Gantry is opening the pull request.",
  updating_pr: "Gantry is updating the pull request.",
  merging: "GitHub is being asked to merge the pull request.",
  verifying: "Gantry is running the live checks against GitHub.",
};

/** Where the repo is on the seven stages. Small: a row of marks for tables. Big: the large rail for the repo page. */
export function Steps({ r, big }: { r: RepoV; big?: boolean }) {
  const idx = stageIndex(r);
  const stop = isStopped(r);
  const ready = r.onboarding.stage === "ready";
  const label = `Onboarding stage: ${stageName(r.onboarding.stage)} (${idx + 1} of 7)`;
  const state = (i: number): "done" | "now" | "stop" | "todo" => (i < idx || (ready && i === idx) ? "done" : i === idx ? (stop ? "stop" : "now") : "todo");
  if (big) return <div className="onb-rail"><PipelineRail label={label} steps={STAGES.map((s, i) => ({ key: s.id, name: s.name, tone: ({ done: "done", now: "run", stop: "bad", todo: "todo" } as const)[state(i)] }))} /></div>;
  return (
    <ol className="onb-steps" aria-label={label}>
      {STAGES.map((s, i) => {
        const st = state(i);
        return (
          <li key={s.id} className={st === "todo" ? "" : `is-${st}`} title={s.name + (st === "done" ? ": done" : st === "now" ? ": current" : st === "stop" ? ": stopped here" : "")}>
            <span className="onb-step-mark" aria-hidden="true" />
            <span className="sr">{`${s.name}${st === "done" ? ", done" : st === "now" ? ", current" : st === "stop" ? ", stopped here" : ""}`}</span>
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

/** The busy line for a repo: when the timeline says an Onboarding Agent run was started for this step, the agent is named; otherwise it is Gantry's rule-based work. */
export function busyText(r: RepoV): string | null {
  const b = r.onboarding.busy;
  if (!b) return null;
  const last = r.onboarding.timeline.at(-1);
  if ((b === "assessing" || b === "opening_pr") && last?.who === "ag-onboard" && /^Started the Onboarding Agent/.test(last.text)) return `The Onboarding Agent is working on this repo. ${last.text.replace(/^Started the /, "Run: ")}`;
  return BUSY[b] ?? null;
}

/**
 * Whether the Onboarding Agent can run now, judged from what the screen knows: it is active and the model it pins (or the same canonical model) is enabled on a connected vendor.
 * The server decides for real (the same routing the edge applies); this only explains. Null when usable, otherwise the reason.
 */
export function agentUnavailable(a: { status: string; model: string } | undefined, vendors: unknown): string | null {
  if (!a) return "The Onboarding Agent is not set up.";
  if (a.status !== "active") return `The Onboarding Agent is ${a.status}.`;
  const list = Array.isArray(vendors) ? (vendors as Array<{ connected: boolean; models: Array<{ id: string; enabled: boolean; canonical?: string }> }>) : [];
  const all = list.flatMap((v) => v.models.map((m) => ({ ...m, connected: v.connected })));
  const want = all.find((m) => m.id === a.model);
  const canon = want?.canonical ?? a.model;
  return all.some((m) => m.connected && m.enabled && (m.id === a.model || (m.canonical ?? m.id) === canon)) ? null : `No connected vendor serves ${a.model}.`;
}
