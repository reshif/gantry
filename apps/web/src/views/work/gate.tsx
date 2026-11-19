/**
 * Approve / Reject for one waiting gate, as the prototype's two buttons with their two dialogs. Home and Inbox share it.
 * The decision is pinned to the gate opening the person was shown (`instance`) and to the work order version, so a
 * conflict refreshes instead of deciding on stale data. Locked, with the reason, until the server's decision is known.
 */
import { gateLabelOf } from "../../lib/gate-label";
import { useState } from "react";
import { gateOps } from "../../api/queries";
import { useCommand } from "../../ui/async";
import { dec, useTravelerWo } from "../traveler/model";
import { Btn, Field, TextArea, TextInput, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { OVERRIDE_MIN, OverrideReason, anywayLabel, overrideKindOf, overrideWhy } from "./override";
import { useUI } from "../../ui/overlay-context";
import { useCatalog } from "../projects/kit";
import { gatePendingName, gatePendingTitle } from "@gantry/domain";
import type { Approval } from "../home/data";

/** What a person does at a waiting gate ("Approve spec"), from the domain wording, for the approval's gate. */
export const pendingName = (a: Pick<Approval, "gate" | "gateName">): string => gatePendingName({ id: a.gate ?? "", name: a.gateName ?? a.gate ?? "" });
/** "Approve spec · G2": the pending title of the approval's gate. */
export const pendingTitle = (a: Pick<Approval, "gate" | "gateName" | "gateLabel">): string => gatePendingTitle({ id: a.gate ?? "", name: a.gateName ?? a.gate ?? "", label: gateLabelOf(a.gateLabel, a.gate) });

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
      ? { allowed: ap.allowed, reason: ap.reason, needs: ap.needs, override: ap.override, overrideKind: ap.overrideKind }
      : { allowed: false, reason: `${wo} is no longer waiting at this gate.`, needs: "" };
  const decideBack: Decision = brief && t && base.allowed ? dec(t, "decline") : base;
  const ifm = t ? { ifMatch: t.version } : undefined;
  const instance = ap?.instance ?? a.instance;
  const decide = useCommand(
    (kind: "approve" | "reject", text: string) =>
      kind === "approve"
        ? brief ? gateOps.confirmBrief(wo, undefined, ifm, text || undefined) : gateOps.approveGate(wo, gate, instance, undefined, ifm, text || undefined)
        : brief ? gateOps.decline(wo, text, undefined, ifm) : gateOps.rejectGate(wo, gate, instance, text, undefined, ifm),
    { ok: false, toastFail: false },
  );
  const [busy, setBusy] = useState(false);
  const purpose = cat?.gates.find((g) => g.id === gate)?.purpose;
  const label = gateLabelOf(a.gateLabel, gate);
  const anyway = overrideKindOf(base);
  const open = (kind: "approve" | "reject") =>
    ui.open((close) => (
      <DecisionDialog
        title={kind === "approve" ? `${pendingTitle(a)} for ${wo}` : `Reject ${label} for ${wo}`}
        danger={kind === "reject" || (kind === "approve" && !!anyway)}
        intro={kind === "approve" ? (purpose ?? `${a.gateName ?? "This gate"} passes and the work order moves on.`) : brief ? "The work order moves to Declined and the submitter is told why. The reason is recorded." : 'The work order is parked in "Needs a person" until someone picks it up. The reason is shown to the agent and recorded.'}
        {...(kind === "approve" && anyway ? { ovrWhy: overrideWhy(anyway) } : {})}
        field={kind === "approve" && anyway ? { label: "Reason", min: OVERRIDE_MIN, area: true } : kind === "approve" ? { label: "Note (optional)", min: 0, area: false } : { label: "Reason", min: 8, area: true, hint: "Say what must change." }}
        submit={kind === "approve" ? (anyway ? anywayLabel(gate) : "Approve") : brief ? "Reject" : "Reject and park"}
        onClose={close}
        onSubmit={async (text) => {
          setBusy(true);
          try {
            const r = await decide.run(kind, text);
            if (r?.ok) ui.toast(kind === "approve" ? `${wo} approved and moved on` : `${wo} rejected${brief ? " and declined" : " and parked"}`, kind === "approve" ? "ok" : "error");
            return r ?? undefined;
          } finally { setBusy(false); }
        }}
      />
    ));
  const cls = size === "sm" ? { small: true } : {};
  return (
    <>
      <Btn label={anyway ? anywayLabel(gate) : "Approve"} aria={`${anyway ? anywayLabel(gate) : "Approve"} ${wo} at ${label}`} kind="primary" {...cls} id={`${idPrefix}-ok-${wo}-${gate}`} guard={anyway ? null : base} disabledReason={busy ? "Deciding…" : null} onClick={() => open("approve")} />
      {brief ? null : <RequestChangesBtn wo={wo} gate={gate} label={label} instance={instance} guard={base} {...(ifm ? { ifMatch: ifm.ifMatch } : {})} id={`${idPrefix}-chg-${wo}-${gate}`} small={size === "sm"} />}
      <Btn label="Reject" aria={`Reject ${wo} at ${label}`} kind="danger" {...cls} id={`${idPrefix}-back-${wo}-${gate}`} guard={decideBack} onClick={() => open("reject")} />
    </>
  );
}

/**
 * "Request changes" at a waiting gate: the same pinned gate-instance command as Reject (the server's only verb that sends work back with a
 * reason), worded as a request. A stale or unpinned instance refreshes and says nothing was decided, as for Approve and Reject.
 */
export function RequestChangesBtn({ wo, gate, label, instance, guard, ifMatch, id, small }: { wo: string; gate: string; label: string; instance: string | undefined; guard: Decision | null; ifMatch?: number; id: string; small?: boolean }) {
  const ui = useUI();
  const send = useCommand(
    (text: string) => gateOps.rejectGate(wo, gate, instance, text, undefined, ifMatch ? { ifMatch } : undefined),
    { ok: false, toastFail: false },
  );
  return (
    <Btn
      label="Request changes" aria={`Request changes on ${wo} at ${label}`} small={!!small} id={id} guard={guard}
      onClick={() =>
        ui.open((close) => (
          <DecisionDialog
            title={`Request changes at ${label} for ${wo}`}
            danger={false}
            intro="The work order goes back to the agent with what you ask for and waits in Needs a person. Nothing is approved. The request is recorded."
            field={{ label: "What should change", min: 8, area: true, hint: "Say what must change before this gate can pass." }}
            submit="Request changes"
            onClose={close}
            onSubmit={async (text) => {
              const r = await send.run(text);
              if (r?.ok) ui.toast(`Changes requested on ${wo} at ${label}`, "ok");
              return r ?? undefined;
            }}
          />
        ))}
    />
  );
}

/**
 * The prototype's decision dialog: an intro line, one field with its hint, the inline reason for a refusal, Cancel and the submit.
 * An empty required field says "<Label> is required."; one that is too short says how many characters it needs.
 */
export function DecisionDialog({ title, intro, field, submit, danger, onSubmit, onClose, ovrWhy }: {
  title: string; intro: string; submit: string; danger: boolean; onClose: () => void; /** a Factory Admin override: why the gate is held; the field is then the audited reason */ ovrWhy?: string;
  field: { label: string; min: number; area: boolean; hint?: string };
  onSubmit: (text: string) => Promise<{ ok: boolean; msg?: string } | void>;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    const v = text.trim();
    if (field.min && !v) return setErr(`${field.label} is required.`);
    if (field.min && v.length < field.min) return setErr(`${field.label} needs at least ${field.min} characters.`);
    setBusy(true);
    const r = await onSubmit(v);
    setBusy(false);
    if (r && r.ok === false) return setErr(r.msg ?? "That did not work.");
    onClose();
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      dirty={text.trim() !== ""}
      body={
        <div className="dlg-body">
          <p style={{ marginBottom: 12 }}>{intro}</p>
          {ovrWhy ? <OverrideReason id="gd-text" value={text} onChange={(v) => { setText(v); setErr(""); }} why={ovrWhy} error={err} /> : <Field label={field.min ? `${field.label} (required)` : field.label} htmlFor="gd-text" {...(field.hint ? { hint: field.hint } : {})} error={err || undefined}>
            {field.area
              ? <TextArea id="gd-text" rows={4} value={text} onChange={(e) => { setText(e.target.value); setErr(""); }} />
              : <TextInput id="gd-text" autoComplete="off" value={text} onChange={(e) => { setText(e.target.value); setErr(""); }} />}
          </Field>}
        </div>
      }
      actions={[{ label: "Cancel" }, { label: submit, kind: danger ? "danger" : "primary", submit: true, id: "gd-ok", onClick: () => void go() }]}
    />
  );
}
