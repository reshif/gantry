/**
 * Edit the brief before confirming it (PATCH work-orders/{id}/brief): what is in scope, what is out, and for an epic its child work orders, one per line.
 * The edit carries the work order's version as If-Match: when the brief moved since this dialog opened (an agent proposed another, a colleague edited it),
 * the server refuses and the dialog says so and offers the latest brief instead of overwriting it. The server audits the change with before and after.
 */
import { useRef, useState } from "react";
import { ops } from "../../api/ops";
import { invalidateSlices } from "../../api/keys";
import { Dialog } from "../../ui/Overlay";
import { Btn, Field, LockNote, Textarea, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useTravelerWo } from "../traveler/model";

const MAX = 12;
const lines = (t: string): string[] => t.split("\n").map((x) => x.trim()).filter(Boolean);
const text = (l: string[] | undefined): string => (l ?? []).join("\n");
const same = (a: string[], b: string[] | undefined): boolean => a.length === (b ?? []).length && a.every((x, i) => x === (b ?? [])[i]);

export function EditBriefDialog({ woId, guard, onClose }: { woId: string; guard: Decision | null; onClose: () => void }) {
  const ui = useUI();
  const wo = useTravelerWo(woId).data;
  const [form, setForm] = useState<{ scopeIn: string; scopeOut: string; children: string } | null>(null);
  // the version this edit is based on: fixed when the dialog opens, so a refresh behind it cannot hide a conflict
  const opened = useRef<number | null>(null);
  const [err, setErr] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!wo) return null;
  if (opened.current === null) opened.current = wo.version;
  const b = wo.brief;
  const epic = wo.cls === "epic";
  // seeded from the brief once; "Load the latest brief" seeds it again
  const f = form ?? { scopeIn: text(b.scopeIn), scopeOut: text(b.scopeOut), children: text(b.children) };
  const base = opened.current;
  const set = (k: keyof typeof f, v: string) => { setForm({ ...f, [k]: v }); setErr(""); };

  const submit = async () => {
    if (busy) return;
    const scopeIn = lines(f.scopeIn), scopeOut = lines(f.scopeOut), children = lines(f.children);
    for (const [name, l] of [["In scope", scopeIn], ["Out of scope", scopeOut], ...(epic ? [["Child work orders", children]] : [])] as Array<[string, string[]]>) {
      if (l.length > MAX) return setErr(`${name} takes at most ${MAX} lines.`);
      if (l.some((x) => x.length > 300)) return setErr(`Each line of ${name} is at most 300 characters.`);
    }
    if (!scopeIn.length) return setErr("Say what is in scope.");
    const body = { ...(same(scopeIn, b.scopeIn) ? {} : { scopeIn }), ...(same(scopeOut, b.scopeOut) ? {} : { scopeOut }), ...(epic && !same(children, b.children) ? { children } : {}) };
    if (!Object.keys(body).length) return setErr("Nothing changed yet.");
    setBusy(true);
    const r = await ops.editBrief(wo.id, body, { ifMatch: base });
    setBusy(false);
    if (r.ok) {
      ui.toast(r.msg, "ok");
      onClose();
      return;
    }
    if (r.status === 409 || r.status === 412 || r.status === 428) {
      // refresh what the screen shows; the person's text stays until they choose to load the latest
      invalidateSlices(["workOrders", "conversations"]);
      setStale(true);
    }
    setErr(r.msg);
  };
  const reload = () => {
    setForm(null);
    opened.current = wo.version;
    setStale(false);
    setErr("");
  };

  return (
    <Dialog
      title={`Edit the brief of ${wo.id}`}
      kicker="Intake · before confirming"
      sub="Change what is in and out of scope. The change is audited, and a brief an agent proposed earlier has to be proposed again."
      wide
      onClose={onClose}
      dirty={form !== null}
      body={
        <div className="form-grid" id="brief-edit">
          <LockNote decision={guard} what="Editing the brief" />
          <Field label="In scope" htmlFor="be-in" required hint={`One item per line, up to ${MAX}.`}>
            <Textarea id="be-in" rows={5} value={f.scopeIn} onChange={(e) => set("scopeIn", e.target.value)} />
          </Field>
          <Field label="Out of scope" htmlFor="be-out" hint="One item per line. Leave empty when nothing is excluded.">
            <Textarea id="be-out" rows={3} value={f.scopeOut} onChange={(e) => set("scopeOut", e.target.value)} />
          </Field>
          {epic ? (
            <Field label="Child work orders" htmlFor="be-kids" hint="One child per line. Each becomes its own work order with its own brief.">
              <Textarea id="be-kids" rows={4} value={f.children} onChange={(e) => set("children", e.target.value)} />
            </Field>
          ) : null}
          <div className="form-err" role="alert" id="be-err">{err}</div>
          {stale ? <div className="row" style={{ gap: 8 }}><span className="small muted">The brief changed since you opened this.</span><Btn label="Load the latest brief" small id="be-reload" onClick={reload} /></div> : null}
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Save brief", kind: "primary", submit: true, id: "be-save", guard, onClick: () => void submit() }]}
    />
  );
}
