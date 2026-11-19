/**
 * Who a station's question is for (agent workspace, Phase 1, G11). `ask_of` on a question names it: the requester, the approvers, anyone who may
 * answer on the project, or the holders of one role. "Waiting for you" is shown only to those people; everyone else sees whom it waits on.
 */
import { rolesIn, type Person } from "@gantry/domain";

export function asksMe(askOf: string, me: Person | undefined, w: { project: string; requestedBy: string | null; requesterActive?: boolean }, can: (action: string) => boolean): boolean {
  if (!me) return false;
  // A question for the requester, who has since been deactivated, is for nobody otherwise (S-31): it goes to the project admins, the line leads and the Factory Admins.
  const standIn = w.requesterActive === false && rolesIn(me, w.project).some((r) => r === "project_admin" || r === "line_lead" || r === "factory_admin");
  if (askOf === "requester") return w.requestedBy === me.id || standIn;
  if (askOf === "approvers") return can("gate.approve");
  if (askOf === "anyone") return w.requestedBy === me.id || can("wo.answer") || standIn;
  if (askOf.startsWith("role:")) return rolesIn(me, w.project).includes(askOf.slice(5));
  return false;
}

/**
 * Whether this caller may answer a question put to `askOf`. The addressee may; so may anyone who can approve gates on the project (an approver can
 * always speak for the factory). A question for approvers or for a role is not for the requester, nor for a bare `wo.answer` holder. Questions for
 * the requester or anyone stay open to whoever the route already lets answer (the requester, or a `wo.answer` holder).
 */
export function mayAnswer(askOf: string, me: Person | undefined, w: { project: string; requestedBy: string | null }, can: (action: string) => boolean): boolean {
  if (can("gate.approve") || asksMe(askOf, me, w, can)) return true;
  return askOf !== "approvers" && !askOf.startsWith("role:");
}

/** "the requester", "an approver", ... for a sentence like "Waiting for an answer from the requester". */
export function askOfLabel(askOf: string, roleName: (id: string) => string = (id) => id.replace(/_/g, " ")): string {
  if (askOf === "requester") return "the requester";
  if (askOf === "approvers") return "an approver";
  if (askOf === "anyone") return "someone on the project";
  if (askOf.startsWith("role:")) return `a ${roleName(askOf.slice(5))}`;
  return "a person";
}

/** Whether the requester can still be asked: a person who is not active (deactivated, suspended) or no longer exists cannot answer. */
export const requesterActive = (people: ReadonlyArray<Pick<Person, "id" | "status">>, requestedBy: string | null): boolean => !requestedBy || people.find((p) => p.id === requestedBy)?.status === "active";

/** "Asked of Tomas (deactivated)" for a question whose addressee (the requester) is no longer active. */
export const askedOfGone = (people: ReadonlyArray<Pick<Person, "id" | "name" | "status">>, requestedBy: string | null): string | null => {
  if (!requestedBy) return null;
  const p = people.find((x) => x.id === requestedBy);
  return p && p.status !== "active" ? `Asked of ${p.name} (${p.status})` : null;
};
