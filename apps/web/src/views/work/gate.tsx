/**
 * Approve / Reject for one waiting gate, as the prototype's two buttons with their two dialogs. Home and Inbox share it.
 * The decision is pinned to the gate opening the person was shown (`instance`) and to the work order version, so a
 * conflict refreshes instead of deciding on stale data. Locked, with the reason, until the server's decision is known.
 */
import { useState } from "react";
import { ops } from "../../api/ops";
import { dec, useTravelerWo } from "../traveler/model";
import { Btn, type Decision } from "../../ui/primitives";
import { useCommand } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { useCatalog } from "../projects/kit";
import type { Approval } from "../home/data";

const CHECKING: Decision = { allowed: false, reason: "Checking what you may decide here.", needs: "" };

export function GateActions({ a, idPrefix, size = "sm" }: { a: Approval; idPrefix: string; size?: "sm" | "md" }) {
  const ui = useUI();
  const cat = useCatalog();
  const wo = a.wo ?? "";
  const gate = a.gate ?? "";
  const q = useTravelerWo(wo);
  const t = q.data;
  const brief = gate === "G0G1";
  const ap = t?.allowed?.approve;
  const base: Decision = !t
    ? q.isError
      ? { allowed: false, reason: "Could not check what you may decide. Open the work order to decide there.", needs: "" }
      : CHECKING
    : ap && ap.gate === gate
      ? { allowed: ap.allowed, reason: ap.reason, needs: ap.needs }
      : { allowed: false, reason: `${wo} is no longer waiting at this gate.`, needs: "" };
  const decideBack: Decision = brief && t && base.allowed ? dec(t, "decline") : base;
  const ifm = t ? { ifMatch: t.version } : undefined;
  const instance = ap?.instance ?? a.instance;
  const approve = useCommand(() => (brief ? ops.confirmBrief(wo, undefined, ifm) : ops.approveGate(wo, gate, instance, undefined, ifm)), {});
  const [busy, setBusy] = useState(false);
  const purpose = cat?.gates.find((g) => g.id === gate)?.purpose;
  const label = a.gateLabel ?? gate;
  const onApprove = async () => {
    const ok = await ui.confirm({ title: `Approve ${label} for ${wo}`, kicker: a.gateName ?? "Gate decision", body: purpose ?? `${a.gateName ?? "This gate"} passes and the work order moves on.`, ok: "Approve" });
    if (!ok) return;
    setBusy(true);
    try { await approve.run(); } finally { setBusy(false); }
  };
  const onReject = () =>
    ui.reasonDialog({
      title: `Reject ${label} for ${wo}`,
      kicker: a.gateName ?? "Gate decision",
      ok: "Reject",
      kind: "danger",
      min: 8,
      label: "Reason",
      placeholder: brief ? "Why will the factory not do this?" : "What must change before this passes?",
      sub: brief ? "The work order moves to Declined and the submitter is told why. The reason is recorded." : "The station's agent reworks the step with your reason. The reason is shown to the agent and recorded.",
      onOk: async (v) => {
        const r = brief ? await ops.decline(wo, v, undefined, ifm) : await ops.rejectGate(wo, gate, instance, v, undefined, ifm);
        if (r.ok) ui.toast(r.msg, "ok");
        return r;
      },
    });
  const cls = size === "sm" ? { small: true } : {};
  return (
    <>
      <Btn label="Approve" aria={`Approve ${wo} at ${label}`} kind="primary" {...cls} id={`${idPrefix}-ok-${wo}-${gate}`} guard={base} disabledReason={busy ? "Deciding…" : null} onClick={() => void onApprove()} />
      <Btn label="Reject" aria={`Reject ${wo} at ${label}`} kind="danger" {...cls} id={`${idPrefix}-back-${wo}-${gate}`} guard={decideBack} onClick={onReject} />
    </>
  );
}
