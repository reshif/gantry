/** The prototype's one-form dialog: labelled fields, inline errors, submit validates all, focus the first invalid, stays open on error, dirty check on close. */
import { useRef, useState, type ReactNode } from "react";
import { Dialog } from "../../ui/Overlay";
import { Field, Input, Select, Toggle, focusFirstInvalid } from "../../ui/primitives";

export interface FormField {
  k: string;
  label: string;
  type?: "text" | "number" | "select" | "switch";
  req?: boolean;
  minLen?: number;
  min?: number;
  hint?: ReactNode;
  opts?: Array<[string, string]>;
  validate?: (v: unknown, all: Record<string, unknown>) => string;
}

export function FormDialog({ title, submit, intro, fields, values, danger, onSubmit, close, cls }: {
  title: string;
  submit: string;
  intro?: ReactNode;
  fields: FormField[];
  values: Record<string, unknown>;
  danger?: boolean;
  /** Return an error string to keep the dialog open, or nothing to close it. */
  onSubmit: (v: Record<string, unknown>) => Promise<string | void> | string | void;
  close: () => void;
  cls?: string;
}) {
  const [v, setV] = useState<Record<string, unknown>>(values);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(v) !== JSON.stringify(values);
  const check = (): Record<string, string> => {
    const e: Record<string, string> = {};
    for (const f of fields) {
      const x = v[f.k];
      const s = typeof x === "string" ? x.trim() : x;
      if (f.req && (s === "" || s == null)) e[f.k] = `${f.label.replace(/ \(.*/, "")} is required.`;
      else if (f.minLen && typeof s === "string" && s.length < f.minLen) e[f.k] = `${f.label} needs at least ${f.minLen} characters.`;
      else if (f.min != null && f.type === "number" && s !== "" && Number(s) < f.min) e[f.k] = `Must be at least ${f.min}.`;
      if (!e[f.k] && f.validate) { const m = f.validate(x, v); if (m) e[f.k] = m; }
    }
    return e;
  };
  const go = async (done: () => void) => {
    if (busy) return;
    const e = check();
    setErr(e);
    if (Object.keys(e).length) { setTimeout(() => root.current && focusFirstInvalid(root.current), 30); return; }
    setBusy(true);
    const m = await onSubmit(v);
    setBusy(false);
    if (m) { setErr({ _form: m }); return; }
    done();
  };
  const set = (k: string, x: unknown) => { setV((o) => ({ ...o, [k]: x })); if (err[k]) setErr((o) => ({ ...o, [k]: "" })); };
  return (
    <Dialog
      title={title} dirty={dirty} cls={cls ?? (danger ? "danger" : undefined)} onClose={close}
      actions={[{ label: "Cancel" }, { label: submit, kind: danger ? "danger" : "primary", submit: true, onClick: () => { void go(close); } }]}
      body={
        <div ref={root} className="stack">
          {intro ? <p className="muted">{intro}</p> : null}
          {fields.map((f) => (
            <Field key={f.k} label={<>{f.label}{f.req && f.type !== "switch" ? <span className="muted"> (required)</span> : null}</>} hint={f.hint} error={err[f.k]}>
              {f.type === "select" ? (
                <Select id={`fd-${f.k}`} value={String(v[f.k] ?? "")} onChange={(x) => set(f.k, x)} options={(f.opts ?? []).map(([value, label]) => ({ value, label }))} />
              ) : f.type === "switch" ? (
                <Toggle id={`fd-${f.k}`} checked={!!v[f.k]} onChange={(x) => set(f.k, x)} label={f.label} />
              ) : (
                <Input id={`fd-${f.k}`} aria-required={f.req ? true : undefined} type={f.type === "number" ? "number" : "text"} min={f.min} value={String(v[f.k] ?? "")} onChange={(e) => set(f.k, f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />
              )}
            </Field>
          ))}
          {err._form ? <div className="form-err" role="alert">{err._form}</div> : null}
        </div>
      }
    />
  );
}
