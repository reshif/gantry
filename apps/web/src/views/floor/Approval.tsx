/** The approval dialog the Floor opens from every "Review" button: gate and work order in the title, the rule and who may decide, then the decision. */
import { gateDef, type Gate } from "@gantry/domain";
import type { UIApi } from "../../ui/overlay-context";
import { ApproversPanel } from "../traveler/Approvers";
import { DrawerRoot, GateRowActions } from "./Drawers";
import { useFloorCtx } from "./kit";

function Body({ wo, gid, onDone }: { wo: string; gid: string; onDone: () => void }) {
  const ctx = useFloorCtx();
  const w = ctx.wos.find((x) => x.id === wo);
  if (!w) return null;
  return (
    <div className="stack" id="floor-approval">
      <p className="small muted">{`${w.id} · ${w.title}`}</p>
      <ApproversPanel woId={wo} gate={gid} project={ctx.project.id} onNavigate={onDone} />
      <div onClickCapture={(e) => { if ((e.target as HTMLElement).closest("button") && !(e.target as HTMLElement).closest("[disabled]")) setTimeout(onDone, 400); }}>
        <GateRowActions w={w} gid={gid} />
      </div>
    </div>
  );
}

/** Opens the approval for one work order at one gate. Closes drawers first, as the prototype does. */
export function openApproval(ui: UIApi, projectId: string, wo: string, gid: string, gateLabel: string, gateName: string): void {
  ui.drawer.close();
  ui.dialog({
    title: `${gateLabel} ${gateName} for ${wo}`,
    kicker: "Approval",
    wide: true,
    body: (close) => (
      <DrawerRoot projectId={projectId}>
        <Body wo={wo} gid={gid} onDone={close} />
      </DrawerRoot>
    ),
    actions: [{ label: "Close" }],
  });
}

export const gateTitle = (cat: Parameters<typeof gateDef>[0], gid: string): { label: string; name: string } => {
  const g = gateDef(cat, gid) as Gate | undefined;
  return { label: g?.label ?? gid, name: g?.name ?? "" };
};
