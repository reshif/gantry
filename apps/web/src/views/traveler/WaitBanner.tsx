/** Why a run is not running (R1): waiting for a run slot or low host disk, or stopped for a critically low host disk. The label comes from the server's `wait`; the drawer and the Record show the same banner. */
import { Icon } from "../../ui/Icon";
import { Status } from "../../ui/primitives";

export interface WaitRead { label: string; reason?: string | null; since?: string | null; kind: "slot" | "disk" | "disk_critical" }

export function WaitBanner({ wait }: { wait: WaitRead }) {
  return (
    <div className={wait.kind === "slot" ? "halt-banner" : "trv-killed"} role={wait.kind === "disk_critical" ? "alert" : "status"} id="trv-wait">
      <Icon name={wait.kind === "slot" ? "halt" : "alert"} />
      <span>{wait.label}{wait.reason ? ` · ${wait.reason}` : ""}</span>
    </div>
  );
}

/** The state chip while the run is held: the wait's own label, not RUNNING. */
export function WaitChip({ wait }: { wait: WaitRead }) {
  return <Status tone={wait.kind === "disk_critical" ? "fail" : "wait"} id="wait-chip">{wait.label}</Status>;
}
