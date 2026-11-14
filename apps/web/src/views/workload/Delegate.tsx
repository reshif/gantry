/** Delegate dialog (legacy delegateDialog): while away, the delegate may decide the gates the person could. Approver rules do not change. Real command: PUT /people/{id}/away. */
import { useState } from "react";
import { istToday, istTime, IST_OFFSET_MS } from "@gantry/domain";
import { ops } from "../../api/ops";
import { usePeople } from "../../api/queries";
import { Field, LockNote, Select } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { useDelegateGuard, useDelegateProject } from "./kit";

export function DelegateDialog({ pid, away, close }: { pid: string; away: { to: number; delegate: string | null } | null; close: () => void }) {
  const ui = useUI();
  const people = usePeople().data ?? [];
  const p = people.find((x) => x.id === pid);
  const guard = useDelegateGuard(pid);
  const projectId = useDelegateProject(pid);
  const mates = people.filter((x) => x.status === "active" && x.id !== pid);
  const cur = away && away.to > Date.now() ? away : null;
  const [del, setDel] = useState(cur?.delegate ?? mates.find((x) => (x.teams ?? []).some((t) => (p?.teams ?? []).includes(t)))?.id ?? mates[0]?.id ?? "");
  const [until, setUntil] = useState(cur ? new Date(cur.to + IST_OFFSET_MS).toISOString().slice(0, 10) : istToday(Date.now(), 3));
  const [err, setErr] = useState("");
  if (!p) return null;
  const first = p.name.split(" ")[0];
  const end = async () => {
    const r = await ops.setAway(pid, null, projectId ?? undefined);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) close();
    else setErr(r.msg);
  };
  const save = async () => {
    const to = istTime(until, "23:59");
    if (!(to > Date.now())) return setErr("Pick a date in the future.");
    if (!del) return setErr("Pick a delegate.");
    const r = await ops.setAway(pid, { from: Date.now(), to, delegate: del }, projectId ?? undefined);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (!r.ok) return setErr(r.msg);
    close();
  };
  return (
    <Dialog title={`Delegate approvals for ${p.name}`} kicker="Workload · delegation" onClose={close}
      sub={`While away, the delegate may decide the gates ${first} could decide. Approver rules do not change.`}
      actions={[
        { label: "Cancel" },
        ...(cur ? [{ label: "End delegation", id: "wl-dl-end", guard, onClick: () => void end() }] : []),
        { label: "Set delegate", kind: "primary", submit: true, id: "wl-dl-save", guard, onClick: () => void save() },
      ]}
      body={(
        <div className="form-grid">
          <LockNote decision={guard} what="Delegation" />
          <div className="form-row">
            <Field label="Delegate" htmlFor="wl-dl-person"><Select id="wl-dl-person" options={mates.map((x) => ({ value: x.id, label: `${x.name} · ${x.title}` }))} value={del} onChange={setDel} /></Field>
            <Field label="Away until (IST)" htmlFor="wl-dl-until"><input id="wl-dl-until" className="input mono" type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
          </div>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}
