/**
 * Connect an integration, as one wide dialog (prototype: "Connect <type>", submit "Connect"): display name, the type's fields, the
 * and nothing else. A new connection stays switched off until someone turns it on from its page (spec 15.3); the project scope and the
 * connection test live there too. Every missing field is reported at once.
 */
import { useState } from "react";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Empty, Field, LockNote, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { type FormVals, configOf, control, emptyVals, secretsOf, type TypeRow } from "./kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/** Every problem with the form as prototype-style sentences ("<Label> is required.", "Use an https:// URL."), all at once. */
function problems(t: TypeRow, name: string, vals: FormVals, targetId: string, insts: Array<{ targetId?: string }>): Array<{ key: string; msg: string }> {
  const out: Array<{ key: string; msg: string }> = [];
  if (!name.trim()) out.push({ key: "_name", msg: "Display name is required." });
  for (const f of t.fields) {
    if (f.type === "bool") continue;
    const raw = f.type === "secret" ? vals.secrets[f.key] ?? "" : String(vals.config[f.key] ?? "");
    const s = raw.trim();
    if (f.required !== false && !s) out.push({ key: f.key, msg: `${f.label} is required.` });
    else if (f.type === "url" && s && !/^https:\/\/[^\s/]+\.[^\s]+/.test(s) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(s)) out.push({ key: f.key, msg: "Use an https:// URL." });
    else if (f.type === "secret" && s && s.length < 6) out.push({ key: f.key, msg: `${f.label} looks too short.` });
    else if (f.type === "number" && s && Number.isNaN(Number(s))) out.push({ key: f.key, msg: `${f.label} must be a number.` });
  }
  if (t.id === "webhook") {
    if (!/^[a-z0-9-]{2,24}$/.test(targetId.trim())) out.push({ key: "_target", msg: "Endpoint id: 2 to 24 lowercase letters, digits or dashes." });
    else if (insts.some((i) => i.targetId === targetId.trim())) out.push({ key: "_target", msg: `An endpoint called ${targetId.trim()} exists.` });
  }
  return out;
}

export function AddIntegration({ typeId, types, insts, close, onAdded }: {
  typeId: string | null;
  types: TypeRow[];
  insts: Array<{ id: string; type: string }>;
  close: () => void;
  onAdded: (id: string) => void;
}) {
  const ui = useUI();
  const perm = dec(useCan("integration.add"));
  const t = types.find((x) => x.id === typeId) ?? null;
  const [name, setName] = useState(() => t?.name ?? "");
  const [vals, setVals] = useState<FormVals>(() => (t ? emptyVals(t) : { config: {}, secrets: {} }));
  const [targetId, setTargetId] = useState("");
  const [errs, setErrs] = useState<Array<{ key: string; msg: string }>>([]);
  const [serverErr, setServerErr] = useState("");
  if (!t) return <Dialog title="Connect an integration" onClose={close} body={<Empty title="Pick a type" text="Choose an integration from the Catalogue tab." />} />;

  const connect = async () => {
    const e = problems(t, name, vals, targetId, insts as Array<{ targetId?: string }>);
    setErrs(e);
    setServerErr("");
    if (e.length) return;
    const r = await ops.addIntegration({ type: t.id, name: name.trim(), config: configOf(t, vals), secrets: secretsOf(vals), projects: "all", enable: false, ...(t.id === "webhook" ? { targetId: targetId.trim() } : {}) });
    if (!r.ok) return setServerErr(r.msg);
    ui.toast(`${name.trim()} connected, switched off until you enable it`, "ok");
    close();
    const id = (r as unknown as { integration?: { id: string } }).integration?.id;
    if (id) onAdded(id);
  };
  const on = (k: string): string | undefined => errs.find((e) => e.key === k)?.msg;
  const intro = t.auth === "app" ? `Create the app in ${t.name} first, then paste its details.` : "Credentials are stored encrypted and shown masked.";

  return (
    <Dialog title={`Connect ${t.name}`} kicker="Integrations" wide onClose={close} actions={[
      { label: "Cancel", kind: "ghost", id: "int-add-cancel", onClick: () => close() },
      { label: "Connect", kind: "primary", submit: true, id: "int-add-go", guard: perm, onClick: () => void connect() },
    ]} body={(
      <div className="form-grid int-add">
        <LockNote decision={perm} what="Adding integrations" />
        <p className="muted small">{intro}</p>
        <Field label="Display name (required)" htmlFor="int-add-name" error={on("_name")}>
          <input id="int-add-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {t.fields.map((f) =>
          f.type === "bool" ? (
            <div className="field" key={f.key}>{control("int-f-", f, vals, setVals, false)}</div>
          ) : (
            <Field key={f.key} label={f.label + (f.required === false ? "" : " (required)")} htmlFor={`int-f-${f.key}`} error={on(f.key)} hint={f.type === "secret" ? "Stored sealed with the platform key and shown masked." : undefined}>
              {control("int-f-", f, vals, setVals, false)}
            </Field>
          ),
        )}
        {t.id === "webhook" ? (
          <Field label="Endpoint id (required)" htmlFor="int-add-target" error={on("_target")} hint="Routes in Notifications pick this endpoint by id.">
            <input id="int-add-target" className="input mono" value={targetId} placeholder="audit-lake" onChange={(e) => setTargetId(e.target.value)} />
          </Field>
        ) : null}
        <div className="form-err" role="alert" id="int-add-err">{serverErr}</div>
      </div>
    )} />
  );
}
