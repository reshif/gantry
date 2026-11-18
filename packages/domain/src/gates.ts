/**
 * How a gate is named, explained and locked. Pure; the API refuses what `gateLock` locks and the console shows the same reason.
 * Gate ids and codes (`G0G1`, "G0+G1") are stable: they are stored in flows, rules, decisions and audit history.
 * What people read first is the gate's name; the code is secondary.
 */
import type { ApproverRule, Catalog, FlowOverrideMark, Gate, GateConfig, GateKind, Project, StationConfig } from "./types.js";

/** Gates whose code joins two legacy checks. They are ONE gate with ONE decision, not two approvals. */
export const COMBINED_GATES: Readonly<Record<string, string>> = {
  G0G1: "One gate. The old G0 (brief) and G1 (class and route) are confirmed together in a single decision, so one confirmation passes it.",
  G3G3s: "One gate. The old G3 (plan) and G3s (security) are judged together: a person approves the plan while the security checks run automatically.",
};

/** Gates that may not be turned off in any project, with the reason shown to people and in refusals. */
export const ALWAYS_ON_GATES: Readonly<Record<string, string>> = {
  G0G1: "Every work order starts with a person confirming the brief, class and route.",
  G3G3s: "It carries the security checks. Changes to CI, dependencies, code-owner files, auth paths, migrations and Gantry config always need a human gate (spec section 3).",
  G4: "The required checks must pass before review, and the Gantry check on the pull request only passes when every gate has passed (spec section 11).",
  G5: "No agent merges on its own authority: a merge needs a human review (invariant I1).",
};

export const REGULATED_LOCK = "Regulated projects keep every gate on.";

export interface GateLock {
  locked: boolean;
  reason: string;
}

export function gateLock(gate: Pick<Gate, "id">, project?: Pick<Project, "regulated"> | { regulated?: boolean } | null): GateLock {
  const always = ALWAYS_ON_GATES[gate.id];
  if (always) return { locked: true, reason: always };
  if (project?.regulated) return { locked: true, reason: REGULATED_LOCK };
  return { locked: false, reason: "" };
}

/** A Factory Admin's override of a lock needs a reason of at least this many characters; it is audited. */
export const OVERRIDE_REASON_MIN = 10;

/** The one gate nobody can switch off or make automatic, not even a Factory Admin: a person approves every merge (invariant I1, AGENTS.md G-02). */
export const NEVER_OVERRIDDEN_GATE = "G5";

/** Whether a Factory Admin may override this gate's lock. Everything but the merge gate. */
export const gateOverridable = (gate: Pick<Gate, "id">): boolean => gate.id !== NEVER_OVERRIDDEN_GATE;

/**
 * Why a gate may not move to `mode` in this project, or null. A gate that a person decides (no automatic checks behind it) never
 * becomes automatic or mixed: with no checks, "automatic" means "passes the moment it opens". That is a correctness rule and holds for a Factory Admin too.
 * The other locks (brief, plan and security, release, regulated projects) are permission rules: `o.override` (a Factory Admin giving a reason) lifts them,
 * except for the merge gate G5, which stays a person's decision for everyone.
 */
export function gateModeLock(gate: Pick<Gate, "id" | "kind" | "checks">, mode: GateKind, project?: { regulated?: boolean } | null, o: { override?: boolean } = {}): string | null {
  if (mode === "human") return null;
  if (gate.id === "G5") return ALWAYS_ON_GATES.G5 ?? "A merge needs a human review (invariant I1).";
  if (!o.override) {
    if (gate.id === "G0G1") return "Brief confirmed (G0+G1) is always confirmed by a person.";
    if (gate.id === "G3G3s" && mode !== "mixed") return "Plan and security (G3+G3s) always keeps a person's approval; only checks-then-a-person is allowed.";
    if (gate.id === "G6" && mode === "auto") return "Release confirmation always needs a person.";
  }
  if (gate.kind === "human" && !(gate.checks && gate.checks.length)) return `${gate.id} has no automatic checks, so it would pass the moment it opens. It stays a person's decision. To skip it, switch the gate off (a Factory Admin override) instead of making it automatic.`;
  if (!o.override && mode === "auto" && project?.regulated) return "Regulated projects keep a person on every gate.";
  return null;
}

/** What the flow shows about one gate's lock: whether it is locked, why, and whether the viewer may override it (decided by the server from the viewer's grants, never from a role name). */
export interface GateLockView {
  locked: boolean;
  reason: string;
  /** A Factory Admin could override this lock (false for G5, which nobody can). */
  overridable: boolean;
  /** The viewer is a Factory Admin who may override it. */
  viewerMayOverride: boolean;
  /** The gate (or its station) is off now by an override. */
  overridden: FlowOverrideMark | null;
  /** The mode is a locked mode held by an override. */
  modeOverridden: FlowOverrideMark | null;
}

export function gateLockView(
  gate: Pick<Gate, "id" | "after">,
  project: { regulated?: boolean; flow?: { gates: Record<string, GateConfig>; stations: Record<string, StationConfig> } | null | undefined } | null | undefined,
  viewerIsFactoryAdmin: boolean,
): GateLockView {
  const l = gateLock(gate, project);
  const cfg = project?.flow?.gates[gate.id];
  const st = project?.flow?.stations[gate.after];
  const off = cfg?.enabled === false ? cfg.override?.off : st?.enabled === false ? st.override?.off : undefined;
  const overridable = l.locked && gateOverridable(gate);
  return { locked: l.locked, reason: l.reason, overridable, viewerMayOverride: overridable && viewerIsFactoryAdmin, overridden: off ?? null, modeOverridden: cfg?.override?.mode ?? null };
}

export const gateKindText = (kind: GateKind): string => (kind === "human" ? "person" : kind === "auto" ? "automatic" : "person + automatic");

/** "Brief confirmed · G0+G1". */
export const gateTitle = (g: Pick<Gate, "name" | "label">): string => `${g.name} · ${g.label}`;

/**
 * What a person does at a gate that is still waiting. A gate's name states the outcome ("Spec approved"), which reads as already done on a card that is
 * still waiting, so waiting cards use this wording ("Approve spec"); the name stays for the done state.
 */
const PENDING_NAMES: Record<string, string> = {
  G0G1: "Confirm brief",
  G1f: "Check feasibility",
  G2: "Approve spec",
  G3d: "Review design",
  G3G3s: "Approve plan and security",
  G4: "Wait for green checks",
  G5: "Review and merge",
  G6: "Confirm release",
};
export const gatePendingName = (g: Pick<Gate, "id" | "name">): string => PENDING_NAMES[g.id] ?? `Approve ${g.name.toLowerCase()}`;

/** "Approve spec · G2": the title of a waiting gate. */
export const gatePendingTitle = (g: Pick<Gate, "id" | "name" | "label">): string => `${gatePendingName(g)} · ${g.label}`;

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * How many approvals a gate needs and from whom, read from the project's approver rule.
 * `roleName` and `personName` turn ids into words; the default shows the ids.
 */
export function approvalText(
  gate: Pick<Gate, "id">,
  mode: GateKind,
  rule: ApproverRule | undefined | null,
  roleName: (id: string) => string = (x) => x,
  personName: (id: string) => string = (x) => x,
  cls?: string | null,
): string {
  if (mode === "auto") return "No approvals: passes when its checks pass";
  const who = rule ? [...rule.roles.map(roleName), ...rule.people.map(personName)] : [];
  if (gate.id === "G0G1") {
    const others = rule ? rule.roles.filter((r) => r !== "engineer").map(roleName) : [];
    return `1 approval: the submitter${others.length ? `, or ${others.join(" / ")}` : ""}`;
  }
  const n = rule ? requiredFor(rule, cls) : 1;
  const from = who.length ? who.join(" / ") : "a Factory Admin (no rule set)";
  return `${mode === "mixed" ? "Checks, then " : ""}${plural(n, "approval")}: ${from}`;
}

/** The gate in a sentence for a tooltip: name, code, kind, purpose and the "+" note. */
export function gateExplain(g: Gate, mode: GateKind = g.kind): string {
  return [`${gateTitle(g)} (${gateKindText(mode)}).`, g.purpose, COMBINED_GATES[g.id]].filter(Boolean).join(" ");
}

/** What the cell under a gate diamond means. */
export function gateStateText(state: string, count = 0): string {
  return state === "waiting" ? `${plural(count, "work order")} waiting for approval` : state === "failing" ? `${count} failing its checks` : state === "off" ? "turned off in this project" : "nothing waiting";
}

export const gateOf = (c: Pick<Catalog, "gates">, id: string): Gate | undefined => c.gates.find((g) => g.id === id);

/** Explain a gate state the way the floor shows it: "nothing waiting" etc. */
export const gateOffNote = "Turned off: new work orders skip it and pass straight through. Work orders already in flight keep the flow they started with.";

/** Approvals a work order of this class needs at a gate: the class's override when the rule lists one, else the base count. Never below 1. */
export function requiredFor(rule: Pick<ApproverRule, "required" | "classRequired"> | null | undefined, cls: string | null | undefined): number {
  const o = cls && rule?.classRequired && Object.prototype.hasOwnProperty.call(rule.classRequired, cls) ? rule.classRequired[cls] : undefined;
  return Math.max(1, Math.floor(Number(o ?? rule?.required) || 1));
}

/** Why a class-count override is invalid, or null. Counts are whole numbers from 1 to 9; `classes` (when given) are the class ids the project has. */
export function classRequiredError(map: Record<string, number> | null | undefined, classes?: ReadonlySet<string>): string | null {
  if (map == null) return null;
  if (typeof map !== "object" || Array.isArray(map)) return "Per-class approvals must be a list of class and count.";
  for (const [cls, n] of Object.entries(map)) {
    if (!Number.isInteger(n) || n < 1) return `Approvals required for ${cls} must be a whole number of at least 1.`;
    if (n > 9) return `Approvals required for ${cls} cannot be more than 9.`;
    if (classes && !classes.has(cls)) return `Approvals override names a class this project does not have: ${cls}.`;
  }
  return null;
}
