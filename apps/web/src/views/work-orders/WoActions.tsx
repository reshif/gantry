/**
 * The one set of quick actions for a work order, the same labels in the same order wherever a work order appears (the work orders list, Inbox,
 * Home, Agents at work, the record, changes and conversation headers, the floor drawer): Conversation, Record, then the primary next action
 * when this person may take it. Pass `here` to leave out the action for the page you are already on. The next action is passed in (`next`) or
 * derived from the work order with `WoNext`, which asks the server's decision (`useCan`) before it enables anything.
 */
import type { ReactNode } from "react";
import { useCan } from "../../api/can";
import { hashFor, navigate } from "../../lib/router";
import { Btn } from "../../ui/primitives";
import { useReviewApproval } from "../inbox/ApprovalDialog";
import { gateItem } from "../inbox/kit";
import type { WorkOrder } from "../../api/types";
import { openQuestion } from "./needs";
import { waitingGate } from "./state";
import type { Catalog } from "@gantry/domain";

export type WoRef = { id: string; project: string };

/** A real link (middle-click and copy address work); a plain click goes through the router like every other navigation. */
const go = (route: "conversations" | "record", wo: WoRef) => (e: React.MouseEvent<HTMLAnchorElement>): void => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(route, wo.id, wo.project);
};

export function WoActions({ wo, next, here, id = `wo-acts-${wo.id}`, className }: { wo: WoRef; next?: ReactNode; here?: "conversation" | "record"; id?: string; className?: string }) {
  return (
    <span className={`wo-acts${className ? ` ${className}` : ""}`} id={id}>
      {here === "conversation" ? null : <a className="btn sm" id={`${id}-conversation`} href={hashFor("conversations", wo.id, wo.project)} aria-label={`Conversation for ${wo.id}`} onClick={go("conversations", wo)}>Conversation</a>}
      {here === "record" ? null : <a className="btn sm" id={`${id}-record`} href={hashFor("record", wo.id, wo.project)} aria-label={`Record of ${wo.id}`} onClick={go("record", wo)}>Record</a>}
      {next ?? null}
    </span>
  );
}

/** The primary next action for a work order, from its own data: Approve… at a waiting gate, Answer on an open station question. Null when nothing is for a person. */
export function WoNext({ w, cat, projectName }: { w: WorkOrder; cat: Catalog | null; projectName?: string }) {
  const review = useReviewApproval();
  const approve = useCan("gate.approve", { project: w.project });
  const answer = useCan("wo.answer", { project: w.project });
  const gid = waitingGate(w);
  if (openQuestion(w)) return <Btn label="Answer" small kind="primary" id={`wo-answer-${w.id}`} guard={answer.pending ? null : answer} onClick={() => navigate("conversations", w.id, w.project)} />;
  if (gid) {
    const g = cat?.gates.find((x) => x.id === gid);
    return <Btn label="Approve…" small kind="primary" id={`wo-approve-${w.id}`} guard={approve.pending ? null : approve} onClick={() => review(gateItem({ wo: w.id, title: w.title, gate: gid, gateLabel: g?.label ?? gid, gateName: g?.name ?? "gate", project: w.project, projectName: projectName ?? w.project }))} />;
  }
  return null;
}
