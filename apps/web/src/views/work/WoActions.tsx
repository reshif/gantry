/**
 * The one set of actions on a work order, the same labels in the same order wherever a work order is listed (work orders list, Inbox, Home, Agents at work,
 * the Floor drawer, gate lists, headers): the primary next action when this person may take it (Answer for an open question, Approve… for a pending gate,
 * each behind `useCan`), then Conversation, then Record. `omit` drops the one for the page you are already on.
 */
import { useCan } from "../../api/can";
import { Btn } from "../../ui/primitives";
import { navigate } from "../../lib/router";
import type { Needs } from "./needs";

export type WoAction = "primary" | "conversation" | "record";
export const WO_ACTION_LABELS = { conversation: "Conversation", record: "Record", answer: "Answer", approve: "Approve…" } as const;

export function WoActions({ wo, project, repo, needs, idPrefix = "woa", omit = [], small = true, kind }: { wo: string; project: string; repo?: string | null; needs?: Needs | null; idPrefix?: string; omit?: WoAction[]; small?: boolean; kind?: "ghost" }) {
  const answer = useCan("wo.answer", { project, repo });
  const approve = useCan("gate.approve", { project, repo });
  const q = needs?.kind === "question";
  const g = needs?.kind === "gate";
  const primary = q ? { label: WO_ACTION_LABELS.answer, d: answer, go: () => navigate("conversations", wo, project) } : g ? { label: WO_ACTION_LABELS.approve, d: approve, go: () => navigate("record", wo, project) } : null;
  const has = (a: WoAction): boolean => !omit.includes(a);
  return (
    <div className="row wo-acts" role="group" aria-label={`Actions for ${wo}`}>
      {primary && has("primary") && !primary.d.pending && primary.d.allowed ? <Btn label={primary.label} small={small} kind="primary" id={`${idPrefix}-primary-${wo}`} aria={`${primary.label} for ${wo}`} onClick={primary.go} /> : null}
      {has("conversation") ? <Btn label={WO_ACTION_LABELS.conversation} small={small} {...(kind ? { kind } : {})} id={`${idPrefix}-conv-${wo}`} aria={`${WO_ACTION_LABELS.conversation} for ${wo}`} onClick={() => navigate("conversations", wo, project)} /> : null}
      {has("record") ? <Btn label={WO_ACTION_LABELS.record} small={small} {...(kind ? { kind } : {})} id={`${idPrefix}-rec-${wo}`} aria={`${WO_ACTION_LABELS.record} for ${wo}`} onClick={() => navigate("record", wo, project)} /> : null}
    </div>
  );
}
