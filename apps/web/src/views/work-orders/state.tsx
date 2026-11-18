/**
 * The prototype's five work order states (Running, Queued, Gate, Blocked, Done), worked out from the server's own state and gates:
 * a waiting work order is at a gate when a gate is waiting on it, otherwise it is queued; blocked also covers failed and parked.
 */
import type { Gate } from "@gantry/domain";
import type { WorkOrder } from "../../api/types";
import { Status, type Tone } from "../../ui/primitives";

export type StateId = "running" | "queued" | "gate" | "blocked" | "done";
export const STATE_OPTIONS: Array<{ value: StateId; label: string }> = [{ value: "running", label: "Running" }, { value: "queued", label: "Queued" }, { value: "gate", label: "Gate" }, { value: "blocked", label: "Blocked" }, { value: "done", label: "Done" }];

export const waitingGate = (w: Pick<WorkOrder, "gates">): string | null => Object.entries(w.gates ?? {}).find(([, g]) => g.status === "waiting")?.[0] ?? null;

export function stateOf(w: Pick<WorkOrder, "state" | "gates">): StateId | "killed" {
  if (w.state === "running") return "running";
  if (w.state === "waiting") return waitingGate(w) ? "gate" : "queued";
  if (w.state === "done") return "done";
  if (w.state === "killed") return "killed";
  return "blocked";
}

const TONE: Record<string, Tone> = { running: "run", queued: "neutral", gate: "wait", blocked: "block", done: "done", killed: "block", failed: "fail", parked: "neutral" };

/** The state chip in the prototype's words: Running, Queued, Gate G5, Blocked, Done (Failed, Parked and Killed keep their own names). */
export function WoStateChip({ w, gates }: { w: Pick<WorkOrder, "state" | "gates">; gates: readonly Gate[] }) {
  const s = stateOf(w);
  if (s === "gate") {
    const gid = waitingGate(w);
    return <Status tone="wait">{`Gate ${gates.find((g) => g.id === gid)?.label ?? gid ?? ""}`.trim()}</Status>;
  }
  const label = s === "blocked" && w.state !== "blocked" ? w.state : s;
  return <Status tone={TONE[label] ?? "neutral"}>{label.charAt(0).toUpperCase() + label.slice(1)}</Status>;
}
