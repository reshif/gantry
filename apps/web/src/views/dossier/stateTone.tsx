/** A work order's state as the prototype's chip: a status tone and the state's own word ("At G5" while it waits on a gate, "Parked · Queue" in a bay). */
import { gateLabelOf } from "../../lib/gate-label";
import { WO_STATES } from "@gantry/domain";
import { Status, type Tone } from "../../ui/primitives";

const TONE: Record<string, Tone> = { running: "run", waiting: "wait", blocked: "block", failed: "fail", done: "done", parked: "neutral", killed: "block", queued: "neutral" };

export function WoStatus({ state, gate, bay }: { state: string; gate?: string | null; bay?: string | null }) {
  const def = (WO_STATES as Record<string, { label: string }>)[state];
  const text = state === "waiting" && gate ? `At ${gateLabelOf(null, gate)}` : state === "parked" && bay ? `Parked · ${bay}` : (def?.label ?? state);
  return <Status tone={TONE[state] ?? "neutral"}>{text}</Status>;
}
