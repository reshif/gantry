/**
 * Who a station's question is for (agent workspace, Phase 1, G11). `ask_of` on a question names it: the requester, the approvers, anyone who may
 * answer on the project, or the holders of one role. "Waiting for you" is shown only to those people; everyone else sees whom it waits on.
 */
import { rolesIn, type Person } from "@gantry/domain";

export function asksMe(askOf: string, me: Person | undefined, w: { project: string; requestedBy: string | null }, can: (action: string) => boolean): boolean {
  if (!me) return false;
  if (askOf === "requester") return w.requestedBy === me.id;
  if (askOf === "approvers") return can("gate.approve");
  if (askOf === "anyone") return w.requestedBy === me.id || can("wo.answer");
  if (askOf.startsWith("role:")) return rolesIn(me, w.project).includes(askOf.slice(5));
  return false;
}

/** "the requester", "an approver", ... for a sentence like "Waiting for an answer from the requester". */
export function askOfLabel(askOf: string, roleName: (id: string) => string = (id) => id.replace(/_/g, " ")): string {
  if (askOf === "requester") return "the requester";
  if (askOf === "approvers") return "an approver";
  if (askOf === "anyone") return "someone on the project";
  if (askOf.startsWith("role:")) return `a ${roleName(askOf.slice(5))}`;
  return "a person";
}
