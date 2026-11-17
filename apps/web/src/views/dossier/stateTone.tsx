/** A work order's state as the prototype's chip: a status tone and the state's own word. */
import { WO_STATES } from "@gantry/domain";
import { Status, type Tone } from "../../ui/primitives";

const TONE: Record<string, Tone> = { running: "run", waiting: "wait", blocked: "block", failed: "fail", done: "done", parked: "neutral", killed: "block", queued: "neutral" };

export function WoStatus({ state }: { state: string }) {
  const def = (WO_STATES as Record<string, { label: string }>)[state];
  return <Status tone={TONE[state] ?? "neutral"}>{def?.label ?? state}</Status>;
}
