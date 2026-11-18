/**
 * The approval decision, one dialog for Home and the Inbox (prototype `approveDialog`): a warning when this person may not decide, the evidence, the rule,
 * who else can decide, how long it has waited, the work order, and a comment; footer Cancel, Request changes, Reject, Approve.
 * Reads the rule and the eligible people from the server for this gate and pins every decision to the gate instance and the work order version it returned.
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useMe } from "../../api/queries";
import { useCan } from "../../api/can";
import { recordDecision } from "../../lib/decided";
import { hashFor } from "../../lib/router";
import { makeStopActions } from "../../shell/stopActions";
import { useOpenTraveler } from "../../shell/useTraveler";
import { CrIcon } from "../../ui/cr";
import { Btn, type Decision } from "../../ui/primitives";
import { useCommand } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { goAttention } from "../home/data";
import { dec, useTravelerWo } from "../traveler/model";
import { useGateApprovers } from "../traveler/Approvers";
import { titleOf, type Item } from "./kit";

const CHECKING: Decision = { allowed: false, reason: "Checking what you may decide here.", needs: "" };
const MIN_NOTE = 10;

function GateBody({ it, close }: { it: Extract<Item, { kind: "gate" }>; close: () => void }) {
  const ui = useUI();
  const a = it.a;
  const wo = a.wo ?? "";
  const gate = a.gate ?? "";
  const brief = gate === "G0G1";
  const [note, setNote] = useState("");
  const rule = useGateApprovers(wo, gate);
  const q = useTravelerWo(wo);
  const t = q.data;
  const ap = t?.allowed?.approve;
  // Locked, with the reason, until the server's decision for this person is known.
  const base: Decision = !t
    ? q.isError ? { allowed: false, reason: "Could not check what you may decide. Open the work order to decide there.", needs: "" } : CHECKING
    : ap && ap.gate === gate ? { allowed: ap.allowed, reason: ap.reason, needs: ap.needs } : { allowed: false, reason: `${wo} is no longer waiting at this gate.`, needs: "" };
  const back: Decision = brief && t && base.allowed ? dec(t, "decline") : base;
  const ifm = t ? { ifMatch: t.version } : undefined;
  const inst = ap?.instance ?? a.instance;
  const title = String(titleOf(it).title);
  const done = (decision: "approved" | "rejected" | "changes", n: string) => { recordDecision({ key: it.key, title, decision, note: n, at: Date.now() }); close(); };
  const approve = useCommand(() => (brief ? ops.confirmBrief(wo, undefined, ifm) : ops.approveGate(wo, gate, inst, undefined, ifm)), {});
  const send = useCommand((kind: "rejected" | "changes") => {
    const reason = kind === "rejected" ? `Rejected: ${note.trim()}` : note.trim();
    return brief ? ops.decline(wo, reason, undefined, ifm) : ops.rejectGate(wo, gate, inst, reason, undefined, ifm);
  }, {});
  const needNote = (what: string): boolean => {
    if (note.trim().length >= MIN_NOTE) return true;
    ui.toast(`Add a comment of at least ${MIN_NOTE} characters${what}.`, "warn");
    return false;
  };
  const rejectGuard: Decision = back;
  const changesGuard: Decision = brief ? { allowed: false, reason: "The brief is confirmed or declined; use Reject to decline it.", needs: "" } : back;
  // The rule read can come back without its progress (a gate with no votes yet, an older server): show what is there, never throw.
  const r = rule.data && rule.data.rule && rule.data.progress ? rule.data : undefined;
  const readFailed = rule.isError || (!!rule.data && !r);
  return (
    <>
      <div className="dlg-b">
        {!base.allowed && t ? (
          <div className="banner warn"><CrIcon name="lock" /><div className="grow">{base.reason || "You are not allowed to decide this."}</div></div>
        ) : null}
        <div><div className="label" style={{ marginBottom: 4 }}>Evidence</div><p>{a.title ?? ""}{r ? ` Progress: ${r.progress.have} of ${r.progress.need} approvals${r.progress.approvals?.length ? `, by ${(r.progress.approvals ?? []).map((x) => x.name).join(", ")}` : ""}.` : ""}</p></div>
        <dl className="kv" style={{ margin: 0 }}>
          <dt>Rule</dt>
          <dd>{r ? `${r.rule.text}${typeof r.rule.classOverride === "number" ? ` This class needs ${r.rule.classOverride} instead of the gate's base ${r.rule.base}.` : ""} (${r.progress.have} of ${r.progress.need} so far)` : (readFailed ? "Could not read the rule." : "Reading the rule…")}</dd>
          <dt>Eligible</dt>
          <dd>{r ? (r.eligible?.length ? (r.eligible ?? []).map((e) => e.name + (e.away ? " (away)" : "")).join(", ") : "Nobody is eligible today.") : "…"}{r && r.satisfiable === false ? <span className="inb-warn" role="alert"> {r.warning}</span> : null}</dd>
          <dt>Waiting</dt>
          <dd>{a.waitMs ? fmt.ago(Date.now() - a.waitMs, Date.now()) : "just now"}</dd>
          <dt>Work order</dt>
          <dd><a href={hashFor("record", wo)} onClick={close}>{wo}</a> {a.title}</dd>
        </dl>
        <div className="field">
          <label className="lbl" htmlFor={`apd-note-${it.key}`}>Comment</label>
          <textarea id={`apd-note-${it.key}`} className="input" rows={3} placeholder="Why, in a sentence" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="hint">Required when rejecting or requesting changes ({MIN_NOTE}+ characters).</div>
        </div>
      </div>
      <div className="dlg-f">
        <Btn label="Cancel" kind="ghost" id={`apd-cancel-${it.key}`} onClick={close} />
        <Btn label="Request changes" id={`apd-changes-${it.key}`} guard={changesGuard} onClick={() => { if (needNote("")) void send.run("changes").then((r2) => { if (r2?.ok) done("changes", note.trim()); }); }} />
        <Btn label="Reject" kind="danger" id={`apd-reject-${it.key}`} guard={rejectGuard} onClick={() => { if (needNote(" to reject")) void send.run("rejected").then((r2) => { if (r2?.ok) done("rejected", note.trim()); }); }} />
        <Btn label={base.allowed || !t ? (gate === "G6" ? "Confirm release" : brief ? "Confirm brief" : "Approve") : "Approve (not allowed)"} kind="primary" id={`apd-approve-${it.key}`} guard={base} onClick={() => void approve.run().then((r2) => { if (r2?.ok) done("approved", note.trim()); })} />
      </div>
    </>
  );
}

function OtherBody({ it, close }: { it: Extract<Item, { kind: "other" }>; close: () => void }) {
  const ui = useUI();
  const me = useMe();
  const open = useOpenTraveler();
  const x = it.x;
  const r = x.restore;
  const d = useCan(r?.scope === "factory" ? "restore.factory" : "restore.project", r?.scope === "project" ? { project: r.id } : {});
  const doneN = r?.approvals?.length ?? 0;
  const already = !!(me && r?.approvals?.some((a) => a.by === me.person.id));
  return (
    <>
      <div className="dlg-b">
        <div><div className="label" style={{ marginBottom: 4 }}>Evidence</div><p>{x.sub || x.title}</p></div>
        <dl className="kv" style={{ margin: 0 }}><dt>Where</dt><dd>{x.where}</dd>{r ? <><dt>Rule</dt><dd>{`${doneN} of ${r.needs ?? 2} approvals so far`}</dd></> : null}</dl>
      </div>
      <div className="dlg-f">
        <Btn label="Cancel" kind="ghost" onClick={close} />
        {r && me && !d.pending && d.allowed ? (
          <Btn
            label={r.scope === "factory" ? (doneN ? `Approve restore (${doneN + 1} of ${r.needs ?? 2})` : "Restore factory") : "Restore project"}
            kind="primary" id={`inb-restore-${r.scope}${r.id ? `-${r.id}` : ""}`}
            disabledReason={already ? "You approved this restore already. A second Factory Admin must approve." : null}
            onClick={() => { close(); makeStopActions(ui, me).restore(r.scope, r.id); }}
          />
        ) : null}
        <Btn label={x.act.label} kind={r ? "ghost" : "primary"} id={`inb-act-${x.id}`} onClick={() => { close(); goAttention(x.act, open); }} />
      </div>
    </>
  );
}

/** Opens the decision for an item. Onboarding merges and questions are decided in their own session, so they navigate there. */
export function useReviewApproval(): (it: Item) => void {
  const ui = useUI();
  return (it) => {
    if (it.kind !== "gate" && it.kind !== "other") return;
    const t = titleOf(it);
    ui.dialog({
      title: t.title, kicker: it.projectName || "Factory", sub: t.sub, wide: true, actions: [],
      body: (close) => it.kind === "gate" ? <GateBody it={it} close={close} /> : <OtherBody it={it} close={close} />,
    });
  };
}

