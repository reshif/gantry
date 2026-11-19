/**
 * Edit the brief before it is confirmed (PATCH /work-orders/:id/brief): what is in and out of scope, and, for an epic, the child work orders. The write carries
 * the work order's version as If-Match, so an edit made on top of someone else's change is refused with a 409 and the person is shown the latest brief to redo it on.
 * Who may edit comes from the server (`wo.answer`, or the requester); this form never decides it. The agent still authors the brief: this is a person's correction.
 */
import { useRef, useState } from "react";
import type { Brief } from "@gantry/domain";
import { useCan } from "../../api/can";
import { commands } from "../../api/commands";
import { useMe } from "../../api/queries";
import { useCommand } from "../../lib/useCommand";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { Btn, Field, LockNote, TextArea } from "../../ui/primitives";
import { useTravelerWo, type TWo } from "../traveler/model";

const lines = (v: string): string[] => v.split("\n").map((x) => x.trim()).filter(Boolean);
const text = (v: string[] | undefined): string => (v ?? []).join("\n");

/** Whether the brief can still be edited: open at Intake before G0+G1 passes, or an epic the plan left unsplit and parked for a person (its children are the split). */
export function briefEditable(wo: TWo): { editable: boolean; children: boolean } {
  const open = wo.station === 0 && !wo.bay && !!wo.gates?.G0G1 && wo.gates.G0G1.status !== "passed" && wo.state !== "done" && wo.state !== "killed";
  const unsplit = wo.bay === "person" && wo.cls === "epic" && wo.bayFrom === "plan" && !wo.split;
  return { editable: open || unsplit, children: wo.cls === "epic" };
}

function BriefDialog({ woId, onClose }: { woId: string; onClose: () => void }) {
  const live = useTravelerWo(woId);
  const wo = live.data;
  // The version and brief the person is editing: fixed when the form opened, replaced only by "Load the latest" after a conflict.
  const base = useRef<{ version: number; brief: Brief } | null>(null);
  if (wo && !base.current) base.current = { version: wo.version, brief: wo.brief };
  const [scopeIn, setIn] = useState<string | null>(null);
  const [scopeOut, setOut] = useState<string | null>(null);
  const [kids, setKids] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [conflict, setConflict] = useState(false);
  const save = useCommand(commands.editBrief, { toastFail: false });
  const ui = useUI();
  if (!wo || !base.current) return null;
  const { children: showKids } = briefEditable(wo);
  const b = base.current.brief;
  const vIn = scopeIn ?? text(b.scopeIn);
  const vOut = scopeOut ?? text(b.scopeOut);
  const vKids = kids ?? text(b.children);
  const submit = async () => {
    setErr("");
    const body: { scopeIn?: string[]; scopeOut?: string[]; children?: string[]; reason?: string } = {};
    if (scopeIn !== null && vIn !== text(b.scopeIn)) body.scopeIn = lines(vIn);
    if (scopeOut !== null && vOut !== text(b.scopeOut)) body.scopeOut = lines(vOut);
    if (showKids && kids !== null && vKids !== text(b.children)) body.children = lines(vKids);
    if (!Object.keys(body).length) return setErr("Nothing changed yet.");
    if (body.scopeIn && !body.scopeIn.length) return setErr("Say what is in scope.");
    if ([body.scopeIn, body.scopeOut, body.children].some((l) => l && (l.length > 12 || l.some((x) => x.length > 300)))) return setErr("At most 12 lines of up to 300 characters each.");
    if (reason.trim()) body.reason = reason.trim();
    const r = await save.run(woId, body, { ifMatch: base.current!.version });
    if (!r) return;
    if (r.ok) { ui.toast(r.msg || "Brief updated.", "ok"); onClose(); return; }
    if (r.status === 409) { setConflict(true); void live.refetch(); return; }
    setErr(r.msg);
  };
  const reload = () => {
    if (!wo) return;
    base.current = { version: wo.version, brief: wo.brief };
    setIn(null); setOut(null); setKids(null); setConflict(false); setErr("");
  };
  return (
    <Dialog
      title="Edit the brief"
      sub="Correct what is in and out of scope before the brief is confirmed. One item per line. An agent's earlier proposal of the brief has to be proposed again."
      onClose={onClose}
      body={
        <div className="form-grid">
          <Field label="In scope (required)" htmlFor="be-in"><TextArea id="be-in" rows={4} value={vIn} onChange={(e) => setIn(e.target.value)} /></Field>
          <Field label="Out of scope" htmlFor="be-out"><TextArea id="be-out" rows={3} value={vOut} onChange={(e) => setOut(e.target.value)} /></Field>
          {showKids ? <Field label="Child work orders (epic)" htmlFor="be-kids" hint="One child per line. Each becomes its own work order when the plan is split."><TextArea id="be-kids" rows={4} value={vKids} onChange={(e) => setKids(e.target.value)} /></Field> : null}
          <Field label="Why (optional)" htmlFor="be-why"><TextArea id="be-why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {conflict ? (
            <div className="callout warn" role="alert" id="be-conflict">
              <b>The brief changed while you were editing.</b>
              Someone else changed this work order, so your edit was not saved. Load the latest brief and make the change again.
              <div><Btn label="Load the latest" small id="be-reload" onClick={reload} /></div>
            </div>
          ) : null}
          {err ? <div className="form-err" role="alert">{err}</div> : null}
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Save brief", kind: "primary", submit: true, id: "be-save", onClick: () => void submit() }]}
    />
  );
}

/** The Edit button on the Brief panel; absent once the brief is confirmed. Locked, with the server's reason, for someone who may not edit. */
export function EditBriefBtn({ wo }: { wo: TWo }) {
  const ui = useUI();
  const me = useMe();
  const can = useCan("wo.answer", { project: wo.project });
  const { editable } = briefEditable(wo);
  if (!editable) return null;
  const own = !!me?.person?.id && wo.requestedBy === me.person.id;
  const guard = own ? null : { allowed: can.allowed, reason: can.reason, needs: can.needs };
  return (
    <>
      <Btn label="Edit brief" small icon="edit" id="dz-brief-edit" guard={can.pending && !own ? undefined : guard} onClick={() => void ui.open((close) => <BriefDialog woId={wo.id} onClose={close} />)} />
      {guard && !guard.allowed ? <LockNote decision={guard} what="Editing the brief" /> : null}
    </>
  );
}
