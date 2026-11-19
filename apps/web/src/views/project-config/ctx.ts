import type { ApproverRule, Catalog, Person } from "@gantry/domain";
import type { PView } from "../projects/kit";

/** Cross-tab view state of Project config (legacy `ui`): kept by the screen, reset when the project changes. */
export interface CfgState {
  tab: string;
  flowCls: string;
  add: { person: string; role: string };
  scen: { cls: string; risk: string; path: string };
  /** Unsaved approver rules by `${gate}`. */
  drafts: Record<string, ApproverRule>;
}

export interface PcProps {
  p: PView;
  cat: Catalog;
  people: Person[];
  s: CfgState;
  set: (patch: Partial<CfgState>) => void;
}

/** The eight tabs, in order. Nothing hides behind a menu. */
export const TABS: Array<[string, string]> = [
  ["overview", "Overview"], ["flow", "Flow"], ["approvers", "Approvers"], ["mcp", "MCP"], ["budget", "Budget"], ["repos", "Repos"], ["members", "Members"], ["line", "Line control"],
];
/** Old `?tab=` ids (the pages that used to sit behind a More menu) and where a bookmark to one lands now. `sec` is the section to open (`?sec=`), `rule` opens the approver rule editor (`?rule=`). */
export const LEGACY_TABS: Record<string, { tab: string; sec?: string; rule?: boolean }> = {
  classes: { tab: "flow", sec: "classes" },
  "flow-advanced": { tab: "flow", sec: "structure" },
  rules: { tab: "approvers", rule: true },
  spend: { tab: "budget" },
  archive: { tab: "line" },
  danger: { tab: "line" },
  history: { tab: "overview", sec: "history" },
  notifications: { tab: "overview", sec: "notifications" },
  more: { tab: "overview", sec: "overlay" },
};
export const membersOf = (people: Person[], p: PView): Person[] => people.filter((x) => x.roles.some((g) => g.scope === p.id));
export const rolesIn = (x: Person, pid: string): string[] => x.roles.filter((g) => g.scope === pid || g.scope === "factory").map((g) => g.role);
