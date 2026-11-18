/** Accept and verify dialogs (legacy acceptDialog and verifyDialog). Accepting applies the change through its own ordinary command; verifying is a measurement the server makes. */
import { useState } from "react";
import type { LearningProposal } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import { ops } from "../../api/ops";
import { Field, LockNote } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { dec } from "../mcp/kit";
import { ChangeView, KINDS, PlainDiff, sigName } from "./kit";

export function AcceptDialog({ lp, close }: { lp: LearningProposal; close: () => void }) {
  const ui = useUI();
  const project = (lp.change as { project?: string }).project;
  const perm = dec(useCan("learning.apply", project ? { project } : {}));
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    const r = await ops.acceptLearning(lp.id, note.trim() || undefined);
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg, "ok");
    close();
  };
  return (
    <Dialog title={`Adopt: ${lp.title}`} kicker={`Learning · ${KINDS[lp.kind]?.name ?? lp.kind}`} wide onClose={close}
      sub={`This updates ${lp.kind === "skill" ? ((lp.change as { skill?: string }).skill ?? "the skill") : "the factory"} as a new version through its own command, with its own permission check and audit entry. It can be rolled back.`}
      actions={[{ label: "Cancel" }, { label: "Adopt change", kind: "primary", submit: true, id: "ln-acc-ok", guard: perm, onClick: () => void submit() }]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Applying learning proposals" />
          {lp.kind === "skill" && (lp.change as { before?: string }).before != null ? <PlainDiff lp={lp} /> : <ChangeView lp={lp} />}
          {lp.metric && lp.windowDays ? <p className="small"><strong>Verified when: </strong>{`at most ${lp.metric.target} ${sigName(lp.metric.signal)} signal${lp.metric.target === 1 ? "" : "s"} in the ${lp.windowDays} days after this is applied.`}</p> : null}
          <Field label="Note (optional)" htmlFor="ln-acc-note"><input id="ln-acc-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}

export function VerifyDialog({ lp, close }: { lp: LearningProposal; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("learning.apply"));
  const [err, setErr] = useState("");
  const due = lp.appliedAt && lp.windowDays ? lp.appliedAt + lp.windowDays * 86_400_000 : null;
  const submit = async () => {
    const r = await ops.verifyLearning(lp.id);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) close();
    else setErr(r.msg);
  };
  return (
    <Dialog title={`Verify ${lp.id}`} kicker="Learning · verification" onClose={close}
      sub="Records that the expected effect showed up. The check is a count of the signals declared before the change, over the window declared before it, taken from the live records."
      actions={[{ label: "Cancel" }, { label: "Mark verified", kind: "primary", submit: true, id: "ln-ver-ok", guard: perm, onClick: () => void submit() }]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Verifying proposals" />
          <p className="small"><strong>Expected: </strong>{lp.expected}</p>
          {lp.metric && lp.windowDays ? (
            <p className="small">
              <strong>Declared: </strong>{`at most ${lp.metric.target} ${sigName(lp.metric.signal)} signal${lp.metric.target === 1 ? "" : "s"} in the ${lp.windowDays} days after it was applied`}
              {lp.baseline ? `; before it there were ${lp.baseline.count} in ${lp.windowDays} days` : ""}
              {due ? `. The window ${Date.now() < due ? "runs until" : "ended"} ${fmt.istDate(due)}.` : "."}
            </p>
          ) : <p className="small muted">No metric was declared, so this cannot be verified.</p>}
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}
