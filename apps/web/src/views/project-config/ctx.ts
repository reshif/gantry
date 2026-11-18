import type { ApproverRule, Catalog, Person } from "@gantry/domain";
import type { PView } from "../projects/kit";

/** Cross-tab view state of Project config (legacy `ui`): kept by the screen, reset when the project changes. */
export interface CfgState {
  tab: string;
  gate: string;
  flowCls: string;
  add: { person: string; role: string };
  scen: { cls: string; risk: string; path: string };
  /** Unsaved approver rules by `${gate}`. */
  drafts: Record<string, ApproverRule>;
  /** Unsaved overview text by "desc" | "overlay". */
  text: Record<string, string>;
}

export interface PcProps {
  p: PView;
  cat: Catalog;
  people: Person[];
  s: CfgState;
  set: (patch: Partial<CfgState>) => void;
}

/** The Blueprint's tab strip. */
export const TABS: Array<[string, string]> = [
  ["overview", "Overview"], ["flow", "Flow"], ["approvers", "Approvers"], ["mcp", "MCP"], ["budget", "Budget"], ["repos", "Repos"], ["danger", "Line control"],
];
/** Pages that are not tabs: reached from a link on the tab they belong to (`?tab=`). `parent` is the tab that stays marked. */
export const SECONDARY: Array<[string, string, string]> = [
  ["members", "Members and roles", "overview"], ["classes", "Work classes", "overview"], ["notifications", "Notification routes", "overview"], ["history", "History", "overview"], ["more", "Instructions overlay and templates", "overview"],
  ["flow-advanced", "Flow details", "flow"], ["rules", "Full rule editor", "approvers"], ["spend", "Spend breakdown", "budget"], ["archive", "Archive project", "danger"],
];
export const membersOf = (people: Person[], p: PView): Person[] => people.filter((x) => x.roles.some((g) => g.scope === p.id));
export const rolesIn = (x: Person, pid: string): string[] => x.roles.filter((g) => g.scope === pid || g.scope === "factory").map((g) => g.role);
