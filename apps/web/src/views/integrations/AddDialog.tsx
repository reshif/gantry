/**
 * Add integration, the prototype form: Type, Name and "Token or webhook secret". The type's other settings follow below the secret
 * (the connector schema decides which), and the scope and the switch-on choice sit in a disclosure. The connection is saved switched off
 * unless "Switch it on now" is ticked (spec 15.3); the server calls the service on Test connection in the drawer.
 */
import { useState } from "react";
import type { Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Field, LockNote, Select, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { type FormVals, ScopePicker, configOf, control, emptyVals, secretsOf, validate, type TypeRow } from "./kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export function AddIntegration({ typeId, types, insts, live, projects, close, onAdded }: {
  typeId: string | null;
  types: TypeRow[];
  insts: Array<{ id: string; type: string }>;
  live: Project[];
  projects: Project[];
  close: () => void;
  onAdded: (id: string) => void;
}) {
  const ui = useUI();
  const perm = dec(useCan("integration.add"));
  const usable = types.filter((t) => t.available !== false);
  const first = types.find((t) => t.id === typeId) ?? usable[0] ?? types[0];
  const nameFor = (ty: TypeRow): string => {
    const n = insts.filter((i) => i.type === ty.id).length;
    return ty.name + (n ? ` ${n + 1}` : "");
  };
  const [type, setType] = useState(first?.id ?? "");
  const t = types.find((x) => x.id === type) ?? null;
  const [name, setName] = useState(first ? nameFor(first) : "");
  const [vals, setVals] = useState<FormVals>(() => (first ? emptyVals(first) : { config: {}, secrets: {} }));
  const [targetId, setTargetId] = useState("");
  const [scope, setScope] = useState<"all" | string[]>("all");
  const [enable, setEnable] = useState(false);
  const [err, setErr] = useState("");
  const [dirty, setDirty] = useState(false);
  const secretKey = t?.fields.find((f) => f.type === "secret")?.key;
  const others = t?.fields.filter((f) => f.key !== secretKey) ?? [];

  const pickType = (id: string): void => {
    const ty = types.find((x) => x.id === id);
    if (!ty) return;
    setType(id);
    setVals(emptyVals(ty));
    setName(nameFor(ty));
    setTargetId("");
    setErr("");
  };

  const connect = async (): Promise<void> => {
    if (!t) return;
    let e = name.trim().length < 3 ? "Name must be at least 3 characters." : validate(t, vals, true);
    if (!e && t.id === "webhook" && !/^[a-z0-9-]{2,24}$/.test(targetId.trim())) e = "Endpoint id: 2 to 24 lowercase letters, digits or dashes.";
    if (!e && scope !== "all" && !scope.length) e = "Pick at least one project, or all projects.";
    if (e) { setErr(e); return; }
    const r = await ops.addIntegration({ type: t.id, name: name.trim(), config: configOf(t, vals), secrets: secretsOf(vals), projects: scope === "all" ? "all" : scope.slice(), enable, ...(t.id === "webhook" ? { targetId: targetId.trim() } : {}) });
    if (!r.ok) { setErr(r.msg); return; }
    ui.toast(`Connected ${name.trim()}${enable ? "" : ". It is switched off until you turn it on"}`, "ok");
    close();
    const id = (r as unknown as { integration?: { id: string } }).integration?.id;
    if (id) onAdded(id);
  };

  return (
    <Dialog
      title="Add integration" dirty={dirty} onClose={close}
      actions={[{ label: "Cancel", id: "int-add-cancel" }, { label: "Connect", kind: "primary", submit: true, id: "int-add-go", guard: perm, onClick: () => { void connect(); } }]}
      body={(
        <div className="form-grid int-add" onChange={() => setDirty(true)}>
          <LockNote decision={perm} what="Adding integrations" />
          <Field label="Type" htmlFor="int-add-type">
            <Select id="int-add-type" value={type} options={types.map((x) => ({ value: x.id, label: x.id + (x.available === false ? " (not yet available)" : "") }))} onChange={(v) => { pickType(v); setDirty(true); }} />
          </Field>
          <Field label="Name" htmlFor="int-add-name">
            <input id="int-add-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {secretKey && t ? (
            <Field label="Token or webhook secret" htmlFor={`int-f-${secretKey}`} hint="Stored encrypted; never shown again.">
              {control("int-f-", t.fields.find((f) => f.key === secretKey)!, vals, setVals, false)}
            </Field>
          ) : null}
          {others.map((f) =>
            f.type === "bool" ? (
              <div className="field" key={f.key}>{control("int-f-", f, vals, setVals, false)}</div>
            ) : (
              <Field key={f.key} label={f.label + (f.required === false ? " (optional)" : "")} htmlFor={`int-f-${f.key}`} hint={f.type === "url" ? "Must start with https://." : undefined}>
                {control("int-f-", f, vals, setVals, false)}
              </Field>
            ),
          )}
          {t?.id === "webhook" ? (
            <Field label="Endpoint id" htmlFor="int-add-target" hint="Routes in Notifications pick this endpoint by id.">
              <input id="int-add-target" className="input mono" value={targetId} placeholder="audit-lake" onChange={(e) => setTargetId(e.target.value)} />
            </Field>
          ) : null}
          <details className="int-more">
            <summary>Projects and switch-on</summary>
            <ScopePicker prefix="int-add-scope-" projects={projects} live={live} value={scope} onChange={setScope} ro={false} />
            <label className="check" htmlFor="int-add-enable">
              <input type="checkbox" id="int-add-enable" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
              <span>Switch it on now. A new connection is off until someone turns it on.</span>
            </label>
          </details>
          <div className="form-err" role="alert" id="int-add-err">{err}</div>
        </div>
      )}
    />
  );
}
