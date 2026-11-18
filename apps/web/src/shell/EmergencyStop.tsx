/**
 * The Emergency stop dialog the Floor's "Halt line" opens (prototype G.stopDialog): a reason of at least 10 characters and the word STOP.
 * It is the kill switch of StopDialogs in the prototype's two-field form. The server still asks for the scope's own confirmation text
 * (project name, or KILL FACTORY); typing STOP here is the person's confirmation, and the command carries the scope's text for the server.
 * In-flight work is held in place (resumable), never cancelled. Step-up and refusals come back from the API and are shown inline.
 */
import { useEffect, useState } from "react";
import { useCan } from "../api/can";
import { ops, type StopScope } from "../api/ops";
import { useKillImpact, useMe } from "../api/queries";
import type { CommandRefusal } from "../api/client";
import { CrIcon } from "../ui/cr";
import { Dialog } from "../ui/Overlay";
import { useUI } from "../ui/overlay-context";
import { Field, LockNote } from "../ui/primitives";
import { StepUpNotice, clearStepUpDraft, draftFor, isStepUp, registerStepUpDraft } from "../ui/stepup";

export function EmergencyStopDialog({ scope, id, onClose }: { scope: "factory" | "project"; id: string | null; onClose: () => void }) {
  const me = useMe();
  const ui = useUI();
  const project = me?.projects.find((p) => p.id === id) ?? null;
  const d = useCan(`kill.${scope}`, scope === "project" && id ? { project: id } : {});
  const imp = useKillImpact(scope, id, d.allowed && !d.pending && (scope === "factory" || !!id));
  const saved = draftFor("kill", scope, id);
  const [reason, setReason] = useState(typeof saved?.reason === "string" ? saved.reason : "");
  const [confirm, setConfirm] = useState(typeof saved?.confirm === "string" ? saved.confirm : "");
  const [err, setErr] = useState<{ reason?: string; confirm?: string; form?: string }>({});
  const [step, setStep] = useState<CommandRefusal | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => registerStepUpDraft(() => ({ kind: "kill", scope, id, values: { reason, mode: "hold", confirm } })), [scope, id, reason, confirm]);
  if (!me) return null;
  const close = () => {
    clearStepUpDraft();
    onClose();
  };
  const where = scope === "factory" ? "the whole factory" : (project?.name ?? id ?? "");
  const n = imp.data?.workOrders;
  const submit = async () => {
    if (busy) return;
    const next: typeof err = {};
    if (!reason.trim()) next.reason = "Reason is required.";
    else if (reason.trim().length < 10) next.reason = "Give a reason of at least 10 characters.";
    if (!confirm.trim()) next.confirm = "Type STOP to confirm is required.";
    else if (!/^STOP$/.test(confirm)) next.confirm = "Type STOP in capitals.";
    setErr(next);
    if (next.reason || next.confirm) return;
    setBusy(true);
    const r = await ops.kill(scope as StopScope, scope === "factory" ? null : id, { reason: reason.trim(), mode: "hold", confirmText: scope === "factory" ? "KILL FACTORY" : (project?.name ?? "") });
    setBusy(false);
    if (!r.ok) {
      if (isStepUp(r)) setStep(r);
      else setErr({ form: r.msg });
      return;
    }
    ui.toast(`Emergency stop applied to ${scope === "factory" ? "the factory" : where}`, "error");
    close();
  };
  return (
    <Dialog
      title={`Emergency stop: ${where}`}
      kicker="Emergency stop"
      sub={`Stops agents immediately and blocks new work. Restoring needs ${scope === "factory" ? "two Factory Admins" : "a Project Admin"}.`}
      onClose={close}
      body={
        <div className="form-grid" id="emergency-stop">
          <LockNote decision={d.pending ? null : d} what="The emergency stop" />
          <div className="banner bad" role="note">
            <CrIcon name="stop" />
            <div className="grow">{`${n === undefined ? "Work orders" : `${n} work order${n === 1 ? "" : "s"}`} in flight will pause at their current station. Nothing is deleted.`}</div>
          </div>
          <Field label="Reason" required hint="Recorded in the audit ledger." error={err.reason}>
            <textarea className="in" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Type STOP to confirm" required error={err.confirm}>
            <input className="in mono" autoComplete="off" placeholder="STOP" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          {step ? <StepUpNotice result={step} what="an emergency stop" draft={{ kind: "kill", scope, id, values: { reason, mode: "hold", confirm } }} /> : null}
          <div className="form-err" role="alert">{err.form ?? ""}</div>
        </div>
      }
      actions={[
        { label: "Cancel" },
        { label: "Stop now", kind: "danger", submit: true, id: "emergency-stop-ok", guard: d.pending ? null : d, onClick: () => void submit() },
      ]}
    />
  );
}
