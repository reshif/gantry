/**
 * Add a vendor from a template (spec 10.4 Vendor templates): pick a template, fill in only what that vendor needs, connect. The server lists the
 * vendor's models with those credentials and stores them with the vendor; the last step shows what it found, with a switch for each.
 */
import { useCommand } from "../../ui/async";
import { useState } from "react";
import type { VendorField, VendorTemplate } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useVendorTemplates } from "../../api/queries";
import { Btn, Chip, Field, LockNote, Select, Toggle } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { Callout } from "./Callout";
import { ManualVendorDialog } from "./Dialogs";
import { RETENTION, dec, no } from "./kit";

interface Found { id: string; name: string; enabled: boolean; priced: boolean }
interface Result { vendorId: string; msg: string; models: Found[]; warnings: string[]; template: VendorTemplate }

export function AddVendorDialog({ close, onAdded }: { close: () => void; onAdded: (id: string) => void }) {
  const [step, setStep] = useState<{ kind: "pick" } | { kind: "form"; t: VendorTemplate } | { kind: "manual" } | { kind: "done"; r: Result }>({ kind: "pick" });
  if (step.kind === "manual") return <ManualVendorDialog close={close} onAdded={onAdded} />;
  if (step.kind === "form") return <TemplateForm t={step.t} close={close} back={() => setStep({ kind: "pick" })} done={(r) => setStep({ kind: "done", r })} />;
  if (step.kind === "done") return <Discovered r={step.r} close={() => { close(); onAdded(step.r.vendorId); }} />;
  return <Picker close={close} pick={(t) => setStep({ kind: "form", t })} manual={() => setStep({ kind: "manual" })} />;
}

/** Product copy, not agent voice: the server's tagline for the generic endpoint does not say "local", so the card carries a small hint. */
const mentionsLocal = (t: VendorTemplate): boolean => /\b(local|self-hosted)\b/i.test(t.tagline);
export const localHint = (t: VendorTemplate): string => (t.id === "openai-compatible" && !mentionsLocal(t) ? "Local or self-hosted models (Ollama, vLLM)" : "");

function Picker({ close, pick, manual }: { close: () => void; pick: (t: VendorTemplate) => void; manual: () => void }) {
  const perm = dec(useCan("model.edit"));
  const q = useVendorTemplates();
  return (
    <Dialog title="Add a model vendor" kicker="Models · vendor" wide onClose={close}
      sub="Pick the vendor. You enter only what it needs, and the models it offers are listed for you."
      actions={[{ label: "Cancel" }]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Vendors" />
          {q.isError ? <div className="form-err" role="alert">The vendor templates could not be loaded.</div> : null}
          <div className="vt-grid" role="list">
            {(q.data ?? []).map((t) => (
              <button key={t.id} type="button" role="listitem" id={`vt-pick-${t.id}`} className="vt-card" disabled={!perm.allowed} onClick={() => pick(t)}>
                <span className="vt-name">{t.name}</span>
                <span className="small muted">{t.tagline}</span>
                <span className="vt-needs small muted"><span className="vt-needs-k">Needs</span> {t.auth}</span>
                {localHint(t) ? <span className="vt-local small" data-testid="vt-local">{localHint(t)}</span> : null}
              </button>
            ))}
          </div>
          <div><Btn small kind="ghost" label="Add a vendor by hand instead" id="va-manual" guard={perm} onClick={() => manual()} /></div>
        </div>
      )} />
  );
}

const initial = (t: VendorTemplate): Record<string, string> => Object.fromEntries(t.fields.map((f) => [f.key, f.default ?? (f.type === "select" ? f.options?.[0] ?? "" : "")]));

function FieldInput({ f, value, set, off }: { f: VendorField; value: string; set: (v: string) => void; off: boolean }) {
  const id = `vt-f-${f.key}`;
  if (f.type === "select") return <Select id={id} disabled={off} options={f.options ?? []} value={value} onChange={set} />;
  if (f.type === "bool") return <label className="check"><input id={id} type="checkbox" disabled={off} checked={value === "true"} onChange={(e) => set(e.target.checked ? "true" : "")} /> {f.label}</label>;
  if (f.key === "serviceAccount") return <textarea id={id} className="input mono" rows={5} autoComplete="off" disabled={off} value={value} placeholder='{"type": "service_account", ...}' onChange={(e) => set(e.target.value)} />;
  return <input id={id} className={`input${f.type === "text" && f.key !== "apiVersion" ? "" : " mono"}`} type={f.type === "secret" ? "password" : "text"} autoComplete="off" value={value} disabled={off} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />;
}

function TemplateForm({ t, close, back, done }: { t: VendorTemplate; close: () => void; back: () => void; done: (r: Result) => void }) {
  const perm = dec(useCan("model.edit"));
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() => initial(t));
  const [retention, setRetention] = useState("standard");
  const [err, setErr] = useState("");
  /** Refusals are shown inline in the dialog, so the command only toasts success. */
  const connect = useCommand((body: Parameters<typeof ops.addVendorFromTemplate>[0]) => ops.addVendorFromTemplate(body), { toastFail: false });
  const busy = connect.busy;
  const off = !perm.allowed || busy;

  const submit = async () => {
    for (const f of t.fields) {
      const v = (values[f.key] ?? "").trim();
      if (f.required && !v) return setErr(`${f.label} is required.`);
      if (v && f.pattern && !new RegExp(f.pattern).test(v)) return setErr(f.patternMsg ?? `${f.label} is not valid.`);
      if (v && f.type === "url" && !/^https:\/\/\S+$/.test(v)) return setErr(`${f.label} must start with https://`);
    }
    setErr("");
    const fields = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
    const r = await connect.run({ template: t.id, ...(name.trim() ? { name: name.trim() } : {}), fields, retention });
    if (!r) return;
    if (!r.ok) return setErr(r.msg);
    const x = r as unknown as { vendor?: { id: string }; discovery?: { models?: Found[]; warnings?: string[] } };
    done({ vendorId: x.vendor?.id ?? "", msg: r.msg, models: x.discovery?.models ?? [], warnings: x.discovery?.warnings ?? [], template: t });
  };

  return (
    <Dialog title={`Connect ${t.name}`} kicker="Models · vendor" wide onClose={close}
      sub="Secrets are sealed with the data key and shown masked from now on. Connecting checks them by listing the vendor's models."
      actions={[
        { label: "Back", onClick: () => back() },
        { label: busy ? "Connecting…" : "Connect and find models", kind: "primary", submit: true, id: "vt-submit", guard: busy ? no("Connecting.") : perm, onClick: () => void submit() },
      ]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Vendors" />
          {t.invocationNote ? <Callout warn icon="alert">{t.invocationNote}</Callout> : null}
          {t.fields.map((f) => f.type === "bool" ? (
            <div key={f.key}><FieldInput f={f} value={values[f.key] ?? ""} off={off} set={(v) => setValues((o) => ({ ...o, [f.key]: v }))} />{f.help ? <div className="field-hint">{f.help}</div> : null}</div>
          ) : (
            <Field key={f.key} label={f.label + (f.required ? "" : " (optional)")} htmlFor={`vt-f-${f.key}`} hint={f.help}>
              <FieldInput f={f} value={values[f.key] ?? ""} off={off} set={(v) => setValues((o) => ({ ...o, [f.key]: v }))} />
            </Field>
          ))}
          <div className="form-row">
            <Field label="Name (optional)" htmlFor="vt-name" hint={`Shown on the card. Default: ${t.name}.`}><input id="vt-name" className="input" value={name} disabled={off} placeholder={t.name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Data retention" htmlFor="vt-retention" hint="Projects can allow only some retention modes."><Select id="vt-retention" disabled={off} options={RETENTION} value={retention} onChange={setRetention} /></Field>
          </div>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}

/** What discovery found, with a switch per model. Models the gateway cannot call, or that have no price yet, start off. */
function Discovered({ r, close }: { r: Result; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(r.models.map((m) => [m.id, m.enabled])));
  const invocable = r.template.invocable || r.models.some((m) => m.enabled);
  return (
    <Dialog title={`${r.template.name} connected`} kicker="Models · vendor" wide onClose={close}
      sub={r.msg}
      actions={[{ label: "Done", kind: "primary", id: "vt-done", onClick: () => close() }]}
      body={(
        <div className="form-grid">
          {r.warnings.map((w) => <Callout key={w} warn icon="alert">{w}</Callout>)}
          {!invocable ? <Callout warn icon="alert">{r.template.invocationNote}</Callout> : null}
          {r.models.length ? (
            <div className="table-scroll">
              <table className="table table-compact" id="vt-found">
                <thead><tr><th scope="col">Model</th><th scope="col">On</th><th scope="col">Price</th></tr></thead>
                <tbody>
                  {r.models.map((m) => (
                    <tr key={m.id}>
                      <td><div>{m.name}</div><div className="mono muted small">{m.id}</div></td>
                      <td>
                        <Toggle id={`vt-m-${m.id}`} checked={on[m.id] ?? false} label={`Enable ${m.name}`}
                          decision={!perm.allowed ? perm : !r.template.invocable && !invocable ? no("The gateway cannot call this vendor yet.") : !m.priced ? no("No known price. Publish one on the Prices panel first.") : null}
                          onChange={(v) => void (async () => { const x = await ops.setModelEnabled(m.id, v); if (x.ok) setOn((o) => ({ ...o, [m.id]: v })); ui.toast(x.msg, x.ok ? "ok" : "error"); })()} />
                      </td>
                      <td>{m.priced ? <Chip text="from catalogue" cls="chip-ok" /> : <Chip text="needs a price" cls="chip-warn" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="small muted">No models were found.</p>}
        </div>
      )} />
  );
}
