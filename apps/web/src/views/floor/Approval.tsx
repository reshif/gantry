/** The approval dialog the Floor opens from every "Review" button: see shell/FloorApproval. */
import { gateDef, type Gate } from "@gantry/domain";
import type { UIApi } from "../../ui/overlay-context";
import { ApprovalDialog } from "../../shell/FloorApproval";
import { DrawerRoot } from "./Drawers";

/** Opens the approval for one work order at one gate. Closes drawers first, as the prototype does. */
export function openApproval(ui: UIApi, projectId: string, wo: string, gid: string, gateLabel: string, gateName: string): void {
  ui.drawer.close();
  ui.open((close) => (
    <DrawerRoot projectId={projectId}>
      <ApprovalDialog wo={wo} gid={gid} label={gateLabel} name={gateName} onClose={close} />
    </DrawerRoot>
  ));
}

export const gateTitle = (cat: Parameters<typeof gateDef>[0], gid: string): { label: string; name: string } => {
  const g = gateDef(cat, gid) as Gate | undefined;
  return { label: g?.label ?? gid, name: g?.name ?? "" };
};
