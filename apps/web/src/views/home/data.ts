import type { HomeData } from "../../api/types";
import { navigate } from "../../lib/router";
import { setProject } from "../../lib/prefs";

export interface AttentionItem {
  id: string;
  sev: 0 | 1 | 2;
  icon: string;
  title: string;
  where: string;
  sub: string;
  act: { label: string; route: string; project?: string; tab?: string; wo?: string };
}

export interface Approval {
  wo?: string;
  title?: string;
  gate?: string;
  gateLabel?: string;
  gateName?: string;
  project: string;
  projectName: string;
  have?: number;
  need?: number;
  waitMs?: number;
  repo?: string;
  repoName?: string;
  pr?: number;
}

export interface MineWo {
  id: string;
  title: string;
  project: string;
  projectName: string;
  state: string;
  bay: string | null;
  bayName: string | null;
  station: string;
  cls: string;
  doneAt: number | null;
}

export interface RepoStage {
  repo: string;
  name: string;
  project: string;
  stage: string;
}

/** GET /api/v1/home. The factory sections are present only for people with a factory-wide role. */
export interface HomeFull extends Omit<HomeData, "approvals" | "attention" | "figures"> {
  mode: "factory" | "mine";
  approvals: Approval[];
  conversations: Array<{ wo: string; title: string; project: string; question: string | null }>;
  mine: { workOrders: MineWo[]; projects: Array<{ id: string; roles: Array<{ id: string; name: string }> }>; factoryRole: boolean };
  attention?: AttentionItem[];
  figures?: {
    projects: { active: number; archived: number };
    inFlight: number;
    running: number;
    inBays: number;
    shippedToday: number;
    shippedWeek: number;
    gatesWaiting: number;
    oldestWaitMs: number;
    lateGates: number;
    stops: string[];
    killedWorkOrders: number;
    spent: number;
    budget: number;
    agentSuccess: number | null;
    agentSuccessTrend: number[];
  };
  control?: {
    killed: { by: string; at: number; reason: string; mode: "hold" | "cancel" } | null;
    restoreApprovals: Array<{ by: string; at: number }>;
    restoreNeeds: number;
    admins: Array<{ id: string; name: string }>;
    impact: { projects: number; workOrders: number; running: number; prs: number };
  };
  human?: {
    waiting: Array<{ person: string; name: string; waiting: number; sole: number }>;
    gates: { count: number; oldestMs: number; sole: number };
    trust: { proposals: Array<{ id: string; cell: string; to: string }>; demotions: Array<{ cell: string; at: number; reason: string | null }> };
    learning: Array<{ id: string; kind: string; title: string }>;
  };
  onboarding?: { stages: Array<{ id: string; name: string; count: number }>; stuck: RepoStage[]; open: RepoStage[]; total: number; ready: number };
  spend?: { projects: Array<{ id: string; label: string; v: number; b: number; alert: number }>; vendors: Array<{ id: string; label: string; v: number; b: number }> };
}

/** Where an attention item's button goes (legacy: scroll to the control panel, or open a project screen or a traveler). */
export function goAttention(a: AttentionItem["act"], openTraveler: (id: string) => void): void {
  if (a.route === "home" && a.tab === "control") {
    document.getElementById("hm-ctl")?.scrollIntoView({ block: "start" });
    return;
  }
  if (a.project) setProject(a.project);
  if (a.route === "traveler" && a.wo) openTraveler(a.wo);
  else navigate(a.route);
}

export const STAGE_NAME: Record<string, string> = { connected: "Connected", assessed: "Assessed", pr_opened: "PR opened", pr_checks: "PR checks", pr_merged: "PR merged", verified: "Verified", ready: "Ready", failed: "Failed", person: "Needs a person" };
