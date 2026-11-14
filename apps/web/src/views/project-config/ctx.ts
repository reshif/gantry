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

export const TABS: Array<[string, string]> = [
  ["overview", "Overview"], ["members", "Members & roles"], ["flow", "Flow"], ["classes", "Work classes"], ["approvers", "Approvers"],
  ["notifications", "Notifications"], ["mcp", "MCP"], ["budget", "Budget"], ["history", "History"], ["danger", "Danger zone"],
];

export const membersOf = (people: Person[], p: PView): Person[] => people.filter((x) => x.roles.some((g) => g.scope === p.id));
export const rolesIn = (x: Person, pid: string): string[] => x.roles.filter((g) => g.scope === pid || g.scope === "factory").map((g) => g.role);
