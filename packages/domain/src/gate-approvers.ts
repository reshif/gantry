/**
 * Who may approve a gate, in plain words (spec 9.3): the rule, the progress, the people the rule actually reaches (from effective roles, delegates, on-call conditions)
 * and whether the gate can pass as configured. Read only. A Factory Admin is universal (owner decision 2026-11-19): an eligible, active Factory Admin is a normal approver on every gate. Separation of duties still bars the author;
 * an admin who is the author may only override (break-glass, with a reason), which is shown apart.
 */
import { gateDef, gateDecision, gateProgress, conditionsFor, type FlowState } from "./flow.js";
import { requiredFor } from "./gates.js";
import { isOnCall, rolesIn } from "./policy.js";
import type { ApproverRule, Person, Project, WorkOrder } from "./types.js";

export interface EligibleApprover { id: string; name: string; why: string; away: boolean; oncall: boolean }
export interface GateApprovers {
  gate: string;
  label: string;
  name: string;
  /** "Needs 2 approvals from Line Lead or Project Admin · author can't approve". */
  rule: { text: string; required: number; base: number; classOverride: number | null; sod: boolean; roles: Array<{ id: string; name: string }>; people: Array<{ id: string; name: string }>; conditions: string[] };
  progress: { have: number; need: number; approvals: Array<{ by: string; name: string; at: number }>; unmet: string[]; onlyRequester: boolean };
  eligible: EligibleApprover[];
  /** Factory Admins who are not eligible for a normal approval (the author on a separation-of-duties gate) and may only approve as a break-glass override (with a reason). */
  overrides: Array<{ id: string; name: string }>;
  satisfiable: boolean;
  warning: string | null;
}

const list = (xs: string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}` : (xs[0] ?? "nobody"));

/** Plain-words rule: "Needs 2 approvals from Line Lead or Project Admin · author can't approve". */
export function ruleText(rule: Pick<ApproverRule, "roles" | "people" | "required" | "sod" | "classRequired">, roleName: (id: string) => string, personName: (id: string) => string, cls?: string | null): string {
  const need = requiredFor(rule, cls);
  const from = [...rule.roles.map(roleName), ...rule.people.map(personName)];
  return `Needs ${need} approval${need === 1 ? "" : "s"} from ${list(from)}${rule.sod ? " · the author can't approve" : ""}`;
}

/** The people a rule reaches in a project (by role or by name; conditions add more at decision time), without the author when separation of duties is on. */
export function reachOf(people: Person[], project: Pick<Project, "id">, rule: ApproverRule, author?: string): Person[] {
  return people.filter((p) => p.status === "active" && !(rule.sod && author && p.id === author)
    && (rolesIn(p, project.id).includes("factory_admin") || rule.people.includes(p.id) || rule.roles.some((r) => rolesIn(p, project.id).includes(r))));
}

/** Warning for a rule that cannot be satisfied by the people who hold its roles today (null when it can). */
export function ruleWarning(people: Person[], project: Pick<Project, "id" | "name">, rule: ApproverRule, label: string): string | null {
  const n = reachOf(people, project, rule).length;
  const need = Math.max(1, rule.required || 1);
  if (n >= need && rule.sod && n === need) return `${label} needs ${need} approval${need === 1 ? "" : "s"} with separation of duties on, and exactly ${n} ${n === 1 ? "person holds" : "people hold"} the roles it names in ${project.name}: a work order authored by one of them can pass this gate only by an override with a reason (audited). Grant the role to one more person to avoid that.`;
  return n < need ? `${label} needs ${need} approval${need === 1 ? "" : "s"} but only ${n} ${n === 1 ? "person holds" : "people hold"} the roles it names in ${project.name}. It cannot pass as configured; grant the role to more people or lower the number.` : null;
}

export function gateApprovers(state: FlowState, wo: WorkOrder, gateId: string, now: number): GateApprovers | null {
  const g = gateDef(state.catalog, gateId);
  const project = state.projects.find((p) => p.id === wo.project);
  if (!g || !project) return null;
  const rule = project.approvers[gateId] ?? { roles: [], people: [], required: 1, sod: false, conditions: [], escalateH: 0, fallback: null };
  const roleName = (id: string): string => state.catalog.roles.find((r) => r.id === id)?.name ?? id;
  const nameOf = (id: string): string => state.people.find((p) => p.id === id)?.name ?? id;
  const prog = gateProgress(project, wo, gateId, state.people);
  // Ask the real decision for everyone as if the gate were open and nobody had voted yet. A Factory Admin is a normal approver, except the author under separation of duties (override only).
  const open = { ...wo, gates: { ...wo.gates, [gateId]: { ...(wo.gates[gateId] ?? { approvals: [], rejections: [], checks: [] }), status: "waiting" as const, approvals: [] } } } as WorkOrder;
  const eligible: EligibleApprover[] = [];
  const overrides: Array<{ id: string; name: string }> = [];
  for (const p of state.people) {
    if (p.status !== "active") continue;
    const isAdmin = rolesIn(p, project.id).includes("factory_admin");
    const d = gateDecision(state, p.id, open, gateId, now);
    if (isAdmin && rule.sod && wo.requestedBy === p.id) { overrides.push({ id: p.id, name: p.name }); continue; }
    if (d.allowed) eligible.push({ id: p.id, name: p.name, why: d.reason, away: !!p.away && p.away.to > now, oncall: isOnCall(state, p, project.id) });
  }
  const need = prog.need;
  const remaining = eligible.filter((e) => !wo.gates[gateId]?.approvals.some((a) => a.by === e.id));
  const satisfiable = prog.have + remaining.length >= need;
  const text = ruleText(rule, roleName, nameOf, wo.cls);
  return {
    gate: gateId, label: g.label, name: g.name,
    rule: { text, required: need, base: Math.max(1, rule.required || 1), classOverride: rule.classRequired && Object.prototype.hasOwnProperty.call(rule.classRequired, wo.cls) ? requiredFor(rule, wo.cls) : null, sod: rule.sod, roles: rule.roles.map((id) => ({ id, name: roleName(id) })), people: rule.people.map((id) => ({ id, name: nameOf(id) })), conditions: conditionsFor(project, wo, gateId).map((c) => c.text) },
    progress: { have: prog.have, need, approvals: (wo.gates[gateId]?.approvals ?? []).map((a) => ({ by: a.by, name: nameOf(a.by), at: (a as { at?: number }).at ?? 0 })), unmet: prog.unmet.map((c) => c.text), onlyRequester: prog.onlyRequester },
    eligible, overrides, satisfiable,
    warning: satisfiable ? null : `This gate can't pass as configured: ${remaining.length === 0 && prog.have === 0 ? "nobody is" : `only ${prog.have + remaining.length} ${prog.have + remaining.length === 1 ? "person is" : "people are"}`} eligible and it needs ${need}.`,
  };
}
