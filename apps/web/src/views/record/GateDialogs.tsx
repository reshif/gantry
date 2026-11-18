/** The work order page's own dialogs (Blueprint prototype): Approve with an optional note, Reject with a required reason, Edit title and Change priority. */
import { useState } from "react";
import { Dialog } from "../../ui/Overlay";
import { Field, LockNote, Select } from "../../ui/primitives";
import { TextArea, TextInput } from "../../ui/TextControls";
import { useUI } from "../../ui/overlay-context";
import type { TDecision, TWo } from "../traveler/model";

const Err = ({ text }: { text: string }) => <div className="form-err" role="alert">{text}</div>;

type Res = { ok: boolean; msg: string };
interface Gate { id: string; label: string; purpose?: string }

/** Approve {gate} for {wo}: the gate's purpose, one optional note, then Approve. */
export function ApproveGateDialog({ wo, gate, guard, run, onClose }: { wo: TWo; gate: Gate; guard: TDecision; run: (note: string) => Promise<Res>; onClose: () => void }) {
  const ui = useUI();
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const r = await run(note.trim());
    setBusy(false);
    if (!r.ok) { setErr(r.msg); return; }
    ui.toast(r.msg, "ok");
    onClose();
  };
  return (
    <Dialog
      title={`Approve ${gate.id} for ${wo.id}`}
      sub={gate.purpose}
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={guard} what="Approving" />
          <Field label="Note (optional)" htmlFor="ap-note"><TextInput id="ap-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Approve", kind: "primary", submit: true, id: "ap-submit", guard, onClick: () => void submit() }]}
    />
  );
}

/** Reject {gate} for {wo}: a required reason (at least 8 characters). */
export function RejectGateDialog({ wo, gate, guard, run, onClose }: { wo: TWo; gate: Gate; guard: TDecision; run: (reason: string) => Promise<Res>; onClose: () => void }) {
  const ui = useUI();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < 8) { setErr("Give a reason of at least 8 characters."); return; }
    setBusy(true);
    const r = await run(reason.trim());
    setBusy(false);
    if (!r.ok) { setErr(r.msg); return; }
    ui.toast(r.msg, "ok");
    onClose();
  };
  return (
    <Dialog
      title={`Reject ${gate.id} for ${wo.id}`}
      sub='The work order is parked in "Needs a person" until someone picks it up. The reason is shown to the agent and recorded.'
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={guard} what="Rejecting" />
          <Field label="Reason (required)" htmlFor="rj-reason" hint="Say what must change."><TextArea id="rj-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Reject", kind: "danger", submit: true, id: "rj-submit", guard, onClick: () => void submit() }]}
    />
  );
}

/** The server has no command that edits a title or a priority (backend gap): the dialog validates, then says so instead of pretending to save. */
const NO_COMMAND = "The server has no command to change this yet, so nothing was saved.";

export function EditTitleDialog({ wo, onClose }: { wo: TWo; onClose: () => void }) {
  const [title, setTitle] = useState(wo.title);
  const [err, setErr] = useState("");
  const d = wo.allowed?.can?.["edit"];
  const submit = () => setErr(title.trim().length < 6 ? "Title needs at least 6 characters." : NO_COMMAND);
  return (
    <Dialog
      title="Edit title"
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Editing the title" />
          <Field label="Title (required)" htmlFor="et-title"><TextInput id="et-title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "et-submit", guard: d, onClick: submit }]}
    />
  );
}

export function PriorityDialog({ wo, onClose }: { wo: TWo; onClose: () => void }) {
  const [prio, setPrio] = useState<string>(wo.priority);
  const [why, setWhy] = useState("");
  const [err, setErr] = useState("");
  const d = wo.allowed?.can?.["edit"];
  const submit = () => setErr(why.trim().length < 4 ? "Give a reason of at least 4 characters." : NO_COMMAND);
  return (
    <Dialog
      title="Change priority"
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Changing the priority" />
          <Field label="Priority" htmlFor="cp-prio"><Select id="cp-prio" options={["P0", "P1", "P2", "P3"]} value={prio} onChange={setPrio} /></Field>
          <Field label="Reason (required)" htmlFor="cp-why"><TextInput id="cp-why" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "cp-submit", guard: d, onClick: submit }]}
    />
  );
}
