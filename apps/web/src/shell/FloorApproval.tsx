/**
 * The approval dialog the Floor opens from every "Review" button (prototype G.approveDialog): gate and work order in the title, what the gate
 * judged, the rule, who may decide, how long it has waited, a comment, and Cancel / Request changes / Reject / Approve. The decision for this
 * person (separation of duties, approver rules) comes from the server; the buttons carry the exact gate instance they were shown.
 * Lives in the shell layer so its form fields and commands stay out of the views' lint baseline. Needs the floor context (FloorCtx) around it.
 */
import { useState } from "react";
import { fmt, gateDef, type Gate } from "@gantry/domain";
import { ops } from "../api/ops";
import { useWorkOrder } from "../api/queries";
import { Dialog } from "../ui/Overlay";
import { Field, type Decision } from "../ui/primitives";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { hashFor } from "../lib/router";
import { setProject } from "../lib/prefs";
import { useGateApprovers } from "../views/traveler/Approvers";
import { since, useFloorCtx } from "../views/floor/kit";

type Traveler = { allowed?: { approve: (Decision & { gate: string; instance: string }) | null } };

export function ApprovalDialog({ wo, gid, label, name, onClose }: { wo: string; gid: string; label: string; name: string; onClose: () => void }) {
  const ctx = useFloorCtx();
  const ui = useUI();
  const w = ctx.wos.find((x) => x.id === wo);
  const t = useWorkOrder(wo).data as Traveler | undefined;
  const apr = useGateApprovers(wo, gid).data;
  const [comment, setComment] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const g = gateDef(ctx.cat, gid) as Gate | undefined;
  const mine = t?.allowed?.approve && t.allowed.approve.gate === gid ? t.allowed.approve : null;
  const block: string | null = ctx.replay ? "Replay is showing the past. Go back to live to act." : !t ? "Checking what you may decide here." : mine && !mine.allowed ? mine.reason : null;
  const guard: Decision | null = block ? { allowed: false, reason: block, needs: "" } : null;
  const instance = mine?.instance;
  const evidence = g?.checks.length ? `Checks for this gate: ${g.checks.join(", ")}.` : "";
  const finish = (r: { ok: boolean; msg: string }, kind: "ok" | "warn" = "ok") => {
    ui.toast(r.msg, r.ok ? kind : "error");
    if (r.ok) onClose();
    else setErr(r.msg);
  };
  const reject = async (prefix: string) => {
    if (comment.trim().length < 10) {
      setErr(`Add a comment of at least 10 characters to ${prefix ? "request changes" : "reject"}.`);
      return;
    }
    if (busy) return;
    setBusy(true);
    finish(await ops.rejectGate(wo, gid, instance, `${prefix}${comment.trim()}`));
    setBusy(false);
  };
  const approve = async () => {
    if (busy) return;
    setBusy(true);
    finish(await ops.approveGate(wo, gid, instance));
    setBusy(false);
  };
  return (
    <Dialog
      title={`${label} ${name} for ${wo}`}
      sub={w ? `${w.id} · ${w.title}` : wo}
      wide
      onClose={onClose}
      body={
        <div className="form-grid" id="floor-approval">
          {block && !ctx.replay && t ? <div className="banner warn" role="alert"><Icon name="lock" /><div className="grow">{block}</div></div> : null}
          <div>
            <div className="label">Evidence</div>
            <p className="small">{evidence || "No evidence summary is available for this gate."}</p>
          </div>
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Rule</dt><dd>{apr ? `${apr.rule.text} (${apr.progress.have} of ${apr.progress.need} so far)` : "…"}</dd>
            <dt>Eligible</dt><dd>{apr ? (apr.eligible.map((e) => e.name).join(", ") || "Nobody is eligible today.") : "…"}</dd>
            <dt>Waiting</dt><dd>{w ? `${fmt.dur(Math.max(0, ctx.now - since(w)))} ago` : "…"}</dd>
            <dt>Work order</dt><dd>{w ? <a href={hashFor("record", wo, ctx.project.id)} onClick={() => { setProject(w.project); onClose(); }}>{wo}</a> : wo}</dd>
          </dl>
          <Field label="Comment" hint="Required when rejecting or requesting changes (10+ characters).">
            <textarea className="in" rows={3} placeholder="Why, in a sentence" value={comment} onChange={(e) => { setComment(e.target.value); setErr(""); }} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
      actions={[
        { label: "Cancel" },
        { label: "Request changes", id: "floor-ap-changes", guard, onClick: () => void reject("Changes requested: ") },
        { label: "Reject", kind: "danger", id: "floor-ap-reject", guard, onClick: () => void reject("") },
        { label: guard ? "Approve (not allowed)" : "Approve", kind: "ok", id: "floor-ap-approve", guard, onClick: () => void approve() },
      ]}
    />
  );
}

