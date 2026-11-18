/**
 * The dialogs behind the work order page's Actions menu, as the prototype draws them: Edit (title, priority, class), Reassign (new owner)
 * and Stop (a reason, then "Stop work order"). The server records a work order's class and can stop it, but it has no endpoint that
 * changes a title, a priority or the person who owns it, so those saves say so instead of pretending.
 */
import { useEffect, useState } from "react";
import { useCan } from "../../api/can";
import { reclassifyFromPage, stopFromPage } from "../traveler/Actions";
import { usePeople } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Field, Select, Textarea } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { StepUpNotice, clearStepUpDraft, isStepUp, registerStepUpDraft } from "../../ui/stepup";
import { no, type TWo } from "../traveler/model";
import { classesOf, type Catalog, type Project } from "@gantry/domain";

export const NO_TITLE = "The server cannot change a work order's title or priority yet.";
export const NO_OWNER = "The server cannot change who owns a work order yet.";

export function EditDialog({ wo, cat, project, onClose }: { wo: TWo; cat: Catalog; project: Project; onClose: () => void }) {
  const ui = useUI();
  const classify = useCan("wo.classify", { project: wo.project });
  const [title, setTitle] = useState(wo.title);
  const [pri, setPri] = useState<string>(wo.priority);
  const [cls, setCls] = useState<string>(wo.cls);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const classes = classesOf(cat, project);
  const textChanged = title.trim() !== wo.title || pri !== wo.priority;
  const submit = async () => {
    if (busy) return;
    if (title.trim().length < 8) return setErr("The title needs at least 8 characters.");
    if (textChanged) return setErr(NO_TITLE);
    if (cls === wo.cls) return onClose();
    setBusy(true);
    const r = await reclassifyFromPage(wo, cls);
    setBusy(false);
    if (!r.ok) return setErr(r.msg);
    ui.toast(`Saved ${wo.id}`, "ok");
    onClose();
  };
  const g = textChanged ? no(NO_TITLE) : cls !== wo.cls && !classify.pending ? classify : null;
  return (
    <Dialog
      title={`Edit ${wo.id}`}
      onClose={onClose}
      dirty={title !== wo.title || pri !== wo.priority || cls !== wo.cls}
      body={
        <div className="form-grid" id="wo-edit">
          <Field label="Title" htmlFor="wo-edit-title" required>
            <Textarea id="wo-edit-title" rows={1} value={title} onChange={(e) => { setTitle(e.target.value); setErr(""); }} />
          </Field>
          <Field label="Priority" htmlFor="wo-edit-pri"><Select id="wo-edit-pri" options={["P1", "P2", "P3"]} value={pri} onChange={(v) => { setPri(v); setErr(""); }} /></Field>
          <Field label="Class" htmlFor="wo-edit-cls" hint={wo.station !== 0 ? "Class can only change at Intake." : undefined}>
            <Select id="wo-edit-cls" options={classes.map((c) => ({ value: c.id, label: c.name }))} value={cls} onChange={(v) => { setCls(v); setErr(""); }} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "wo-edit-save", guard: g, onClick: () => void submit() }]}
    />
  );
}

export function OwnerDialog({ wo, onClose }: { wo: TWo; onClose: () => void }) {
  const q = usePeople();
  const people = q.isSuccess ? q.data.filter((p) => p.status === "active") : [];
  const [who, setWho] = useState<string>(wo.requestedBy);
  return (
    <Dialog
      title={`Reassign ${wo.id}`}
      onClose={onClose}
      body={
        <div className="form-grid" id="wo-owner">
          <Field label="New owner" htmlFor="wo-owner-sel" hint={NO_OWNER}>
            <Select id="wo-owner-sel" options={people.map((p) => ({ value: p.id, label: p.name }))} value={who} onChange={setWho} />
          </Field>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Reassign", kind: "primary", submit: true, id: "wo-owner-save", guard: no(NO_OWNER) }]}
    />
  );
}

export function StopDialog({ wo, onClose }: { wo: TWo; onClose: () => void }) {
  const ui = useUI();
  const d = useCan("kill.workorder", { project: wo.project });
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [step, setStep] = useState<Parameters<typeof StepUpNotice>[0]["result"] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => registerStepUpDraft(() => ({ kind: "kill", scope: "workorder", id: wo.id, values: { reason, mode: "hold", confirm: "" } })), [wo.id, reason]);
  const close = () => { clearStepUpDraft(); onClose(); };
  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < 10) return setErr("Give a reason of at least 10 characters.");
    setBusy(true);
    const r = await stopFromPage(wo.id, reason.trim());
    setBusy(false);
    if (!r.ok) {
      if (isStepUp(r)) { setErr(""); setStep(r); } else setErr(r.msg);
      return;
    }
    ui.toast(`${wo.id} stopped`, "warn");
    close();
  };
  return (
    <Dialog
      title={`Stop ${wo.id}?`}
      sub="It is declined and removed from the belt. This is recorded in the audit ledger."
      onClose={close}
      dirty={reason.length > 0}
      body={
        <div className="form-grid" id="wo-stop">
          <Field label="Reason" htmlFor="wo-stop-reason" required>
            <Textarea id="wo-stop-reason" rows={3} value={reason} onChange={(e) => { setReason(e.target.value); setErr(""); }} />
          </Field>
          {step ? <StepUpNotice result={step} what="a kill" draft={{ kind: "kill", scope: "workorder", id: wo.id, values: { reason, mode: "hold", confirm: "" } }} /> : null}
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Stop work order", kind: "danger", submit: true, id: "wo-stop-ok", guard: d.pending ? null : d, onClick: () => void submit() }]}
    />
  );
}
