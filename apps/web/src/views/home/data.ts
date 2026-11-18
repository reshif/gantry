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
  /** A killed scope: Restore is offered to people who may, with approvals so far. */
  restore?: { scope: "factory" | "project"; id: string | null; approvals?: Array<{ by: string; at: number }>; needs?: number };
}

export interface Approval {
  wo?: string;
  title?: string;
  gate?: string;
  gateLabel?: string;
  gateName?: string;
  /** The exact gate opening shown (`WO-1:G2:3`); a decision names it. */
  instance?: string;
  project: string;
  projectName: string;
  have?: number;
  need?: number;
  waitMs?: number;
  repo?: string;
  repoName?: string;
  pr?: number;
  note?: string;
}

export interface Conversation {
  wo: string;
  title: string;
  project: string;
  question: string | null;
  /** Who asked, when, and the answer choices the agent offered (the server adds these when it has them; none is invented here). */
  agent?: string | null;
  at?: number | null;
  options?: string[];
  /** Set when the work order is at the brief gate: the item is a gate decision, not a question. */
  gate?: { id: string; label: string; name: string };
  /** A failed, blocked or parked work order that needs a person: the reason is `question`; `actions` are what this person may do (retry, assign). */
  stuck?: { state: string; station: string; reason: string; actions: string[] };
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

export interface SetupStep {
  id: "github" | "vendor" | "project" | "repo" | "work-order";
  label: string;
  state: "done" | "active" | "todo";
  detail: string;
  route: string;
  project: string | null;
}

export interface EvalHealth {
  scored: number;
  passing: number;
  unscored: number;
  failing: Array<{ agent: string; name: string; version: string; suite: string; score: number; threshold: number }>;
}

/** `home.sections`: built by the API by the caller's rights. A section that is absent is one the person may not see: the page renders what is present and never checks roles. */
export interface HomeSections {
  access?: "none";
  setup?: { done: number; total: number; steps: SetupStep[] };
  attention?: AttentionItem[];
  waiting?: { approvals: Approval[]; conversations: Conversation[] };
  approvers?: { count: number; oldestMs: number; late: number; byProject: Array<{ id: string; name: string; count: number; oldestMs: number }> };
  motion?: {
    inFlight: number;
    running: number;
    inBays: number;
    byStation: Record<string, number>;
    shippedToday: number;
    shippedWeek: number;
    shippedPrevWeek: number;
    recentDone: Array<{ id: string; title: string; project: string; projectName: string; doneAt: number | null }>;
    mine: MineWo[];
  };
  projects?: Array<{ id: string; roles: Array<{ id: string; name: string }>; repos: Array<{ id: string; name: string; stage: string; blocker: string }> }>;
  health?: {
    spend: { spent: number; budget: number; projects: Array<{ id: string; label: string; v: number; b: number; alert: number }> };
    evals: EvalHealth | null;
    audit: boolean;
  };
}

/** GET /api/v1/home. The bell and the sidebar badges read `approvals`, `conversations`, `badges` and `projectBadges`; the page reads `sections`. */
export interface HomeFull extends Omit<HomeData, "approvals" | "conversations" | "attention" | "figures"> {
  approvals: Approval[];
  conversations: Conversation[];
  sections: HomeSections;
}

/** Where an attention item's button goes: a project screen or a traveler. */
export function goAttention(a: AttentionItem["act"], openTraveler: (id: string) => void): void {
  if (a.project) setProject(a.project);
  if (a.route === "traveler" && a.wo) openTraveler(a.wo);
  else navigate(a.route);
}

export const STAGE_NAME: Record<string, string> = { connected: "Connected", assessed: "Assessed", pr_opened: "PR opened", pr_checks: "PR checks", pr_merged: "PR merged", verified: "Verified", ready: "Ready", failed: "Verification failed", person: "Needs a person" };
