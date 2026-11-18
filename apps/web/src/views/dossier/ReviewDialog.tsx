/**
 * The approve dialog of the prototype ("Review G5"): what the gate is, the evidence the approver sees, the rule and who may decide, a
 * comment, and Cancel / Request changes / Reject / Approve. Decisions go through the same pinned-instance commands as before, so a
 * conflict refreshes and explains itself.
 */
import { useState } from "react";
import type { Gate } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { Dialog } from "../../ui/Overlay";
import { Field, Textarea } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { navigate } from "../../lib/router";
import { useGateApprovers } from "../traveler/Approvers";
import { decideGate } from "../traveler/Actions";
import type { TWo } from "../traveler/model";
import type { RecordData } from "../record/data";

const MIN = 10;

export function ReviewDialog({ wo, gate, rec, onClose }: { wo: TWo; gate: Gate; rec: RecordData | undefined; onClose: () => void }) {
  const ui = useUI();
  const actor = useActors();
  const ap = wo.allowed.approve;
  const approvers = useGateApprovers(wo.id, gate.id).data;
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!ap) return null;
  const intake = gate.id === "G0G1";
  const blocked = ap.allowed ? "" : `${ap.reason}${ap.needs ? ` Needs: ${ap.needs}.` : ""}`;
  const inst = rec?.gates.find((g) => g.gate === gate.id && g.status === "waiting") ?? rec?.gates.filter((g) => g.gate === gate.id).at(-1);
  const checks = inst?.basis.checks ?? [];
  const file = rec?.code.files.find((f) => f.preview?.length);
  const prog = wo.gateProgress[gate.id];
  const need = approvers?.progress.need ?? prog?.need ?? 1;
  const have = approvers?.progress.have ?? prog?.have ?? 0;
  const waiting = wo.gates[gate.id]?.waitingSince;

  const decide = async (kind: "approve" | "changes" | "reject") => {
    if (busy) return;
    if (kind !== "approve" && note.trim().length < MIN) {
      setErr(`Add a comment of at least ${MIN} characters${kind === "reject" ? " to reject" : ""}.`);
      return;
    }
    setBusy(true);
    const r = await decideGate(wo, gate.id, kind, note.trim());
    setBusy(false);
    if (!r.ok) {
      setErr(r.msg);
      ui.toast(r.msg, "error");
      return;
    }
    ui.toast(r.msg, kind === "approve" ? "ok" : "warn");
    onClose();
  };

  return (
    <Dialog
      title={intake ? `Confirm the brief of ${wo.id}` : `${gate.label} ${gate.name}`}
      sub={`${wo.id} · ${wo.title}`}
      wide
      onClose={onClose}
      dirty={note.length > 0}
      body={
        <div className="stack" id="review-dialog">
          {blocked ? <div className="banner warn" role="alert"><Icon name="lock" /><div className="grow">{blocked}</div></div> : null}
          <div>
            <div className="label" style={{ marginBottom: 4 }}>Evidence</div>
            <p>{gate.purpose}</p>
            {checks.length ? <ul className="plain-list small" style={{ marginTop: 6 }}>{checks.map((c) => <li key={c.name}>{`${c.ok ? "✓" : "✗"} ${c.name}`}</li>)}</ul> : null}
          </div>
          {file ? (
            <pre className="code diff" style={{ padding: 8 }} aria-label={`Diff of ${file.path}`}>
              {file.preview!.slice(0, 8).map((l, i) => <div key={i} className={l.t === "+" ? "add" : l.t === "-" ? "del" : ""}>{`${l.t} ${l.s}`}</div>)}
            </pre>
          ) : null}
          <dl className="kv">
            <dt>Rule</dt><dd>{approvers?.rule.text ?? `${need} approver${need > 1 ? "s, different people" : ""} (${have} of ${need} so far)`}</dd>
            <dt>Eligible</dt><dd>{approvers ? (approvers.eligible.map((p) => p.name).join(", ") || "nobody") : "…"}</dd>
            <dt>Waiting</dt><dd>{waiting ? `${fmt.dur(Date.now() - waiting)} ago` : "now"}</dd>
            <dt>Work order</dt><dd><a href={`#/p/${wo.project}/record/${wo.id}`} onClick={(e) => { e.preventDefault(); onClose(); navigate("record", wo.id, wo.project); }}>{wo.id}</a>{` ${wo.title}`}</dd>
            {approvers?.progress.approvals.length ? <><dt>Approved by</dt><dd>{approvers.progress.approvals.map((a) => actor(a.by).name).join(", ")}</dd></> : null}
          </dl>
          <Field label="Comment" htmlFor="rv-note" hint={`Required when rejecting or requesting changes (${MIN}+ characters).`} error={err || undefined}>
            <Textarea id="rv-note" rows={3} placeholder="Why, in a sentence" value={note} onChange={(e) => { setNote(e.target.value); setErr(""); }} />
          </Field>
        </div>
      }
      actions={[
        { label: "Cancel" },
        ...(intake ? [] : [{ label: "Request changes", id: "rv-changes", onClick: () => void decide("changes") }]),
        { label: intake ? "Decline" : "Reject", kind: "danger", id: "rv-reject", onClick: () => void decide("reject") },
        { label: blocked ? "Approve (not allowed)" : intake ? "Confirm brief" : "Approve", kind: "ok", id: "rv-approve", guard: ap, onClick: () => void decide("approve") },
      ]}
    />
  );
}
