/**
 * Connect an integration, as one wide dialog (prototype: "Connect <type>", submit "Connect"): display name, the type's fields, the
 * projects that may use it, and an optional real connection test. The test calls the service; nothing is saved until Connect.
 * A new connection stays switched off until someone turns it on (spec 15.3); the dialog offers to switch it on now.
 */
import { useState } from "react";
import type { Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Empty, Field, LockNote, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { type FormVals, ScopePicker, configOf, control, emptyVals, hostOf, secretsOf, type TypeRow } from "./kit";

interface TestOut { ok: boolean; ms: number; lines: Array<["ok" | "fail", string]> }
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/** The first problem with the form as a prototype-style sentence ("<Label> is required.", "Use an https:// URL."). */
function problem(t: TypeRow, name: string, vals: FormVals, targetId: string, insts: Array<{ targetId?: string }>): { key: string; msg: string } | null {
  if (!name.trim()) return { key: "_name", msg: "Display name is required." };
  for (const f of t.fields) {
    if (f.type === "bool") continue;
    const raw = f.type === "secret" ? vals.secrets[f.key] ?? "" : String(vals.config[f.key] ?? "");
    const s = raw.trim();
    if (f.required !== false && !s) return { key: f.key, msg: `${f.label} is required.` };
    if (f.type === "url" && s && !/^https:\/\/[^\s/]+\.[^\s]+/.test(s) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(s)) return { key: f.key, msg: "Use an https:// URL." };
    if (f.type === "secret" && s && s.length < 6) return { key: f.key, msg: `${f.label} looks too short.` };
    if (f.type === "number" && s && Number.isNaN(Number(s))) return { key: f.key, msg: `${f.label} must be a number.` };
  }
  if (t.id === "webhook") {
    if (!/^[a-z0-9-]{2,24}$/.test(targetId.trim())) return { key: "_target", msg: "Endpoint id: 2 to 24 lowercase letters, digits or dashes." };
    if (insts.some((i) => i.targetId === targetId.trim())) return { key: "_target", msg: `An endpoint called ${targetId.trim()} exists.` };
  }
  return null;
}

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
  const t = types.find((x) => x.id === typeId) ?? null;
  const [name, setName] = useState(() => (t ? t.name + (insts.filter((i) => i.type === t.id).length ? ` ${insts.filter((i) => i.type === t.id).length + 1}` : "") : ""));
  const [vals, setVals] = useState<FormVals>(() => (t ? emptyVals(t) : { config: {}, secrets: {} }));
  const [targetId, setTargetId] = useState("");
  const [scope, setScope] = useState<"all" | string[]>("all");
  const [enable, setEnable] = useState(false);
  const [test, setTest] = useState<TestOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ key: string; msg: string } | null>(null);
  if (!t) return <Dialog title="Connect an integration" onClose={close} body={<Empty title="Pick a type" text="Choose an integration from the Catalogue tab." />} />;

  const check = () => problem(t, name, vals, targetId, insts as Array<{ targetId?: string }>);
  const testNow = async () => {
    const e = check();
    setErr(e);
    if (e) return;
    setBusy(true);
    setTest(null);
    const r = await ops.testIntegrationDraft(t.id, { config: configOf(t, vals), secrets: secretsOf(vals) });
    setBusy(false);
    const out = (r as unknown as { test?: TestOut }).test;
    setTest(out ?? { ok: false, ms: 0, lines: [["fail", r.ok ? "The test returned nothing." : r.msg]] });
  };
  const connect = async () => {
    const e = check();
    setErr(e);
    if (e) return;
    if (scope !== "all" && !scope.length) return setErr({ key: "_scope", msg: "Pick at least one project, or all projects." });
    const r = await ops.addIntegration({ type: t.id, name: name.trim(), config: configOf(t, vals), secrets: secretsOf(vals), projects: scope === "all" ? "all" : scope.slice(), enable, ...(t.id === "webhook" ? { targetId: targetId.trim() } : {}) });
    if (!r.ok) return setErr({ key: "_server", msg: r.msg });
    ui.toast(enable ? `${name.trim()} connected` : `${name.trim()} connected, switched off until you enable it`, "ok");
    close();
    const id = (r as unknown as { integration?: { id: string } }).integration?.id;
    if (id) onAdded(id);
  };
  const on = (k: string): string | undefined => (err?.key === k ? err.msg : undefined);
  const intro = t.auth === "app" ? `Create the app in ${t.name} first, then paste its details.` : "Credentials are stored encrypted and shown masked.";

  return (
    <Dialog title={`Connect ${t.name}`} kicker="Integrations" wide onClose={close} actions={[
      { label: "Cancel", kind: "ghost", id: "int-add-cancel", onClick: () => close() },
      { label: "Test connection", id: "int-add-test-run", guard: busy ? { allowed: false, reason: "The test is still running." } : perm, onClick: () => void testNow() },
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
        <ScopePicker prefix="int-add-scope-" projects={projects} live={live} value={scope} onChange={setScope} ro={false} />
        <label className="check" htmlFor="int-add-enable">
          <input type="checkbox" id="int-add-enable" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
          <span>Switch it on now. A new connection is off until someone turns it on.</span>
        </label>
        <div className="int-test" role="status" aria-live="polite" id="int-add-test">
          {busy ? <p className="muted"><Icon name="refresh" /> Connecting to {hostOf(t, vals)}…</p> : test ? (
            <div className={`callout ${test.ok ? "ok" : "bad"}`}>
              <b>{test.ok ? `Connection works, ${test.ms} ms` : "Connection failed"}</b>
              <ul className="int-testlines">{test.lines.map((l, i) => <li key={i} className={l[0] === "ok" ? "" : "neg"}><span aria-hidden="true">{l[0] === "ok" ? "✓ " : "✕ "}</span>{l[1]}</li>)}</ul>
            </div>
          ) : null}
        </div>
        <div className="form-err" role="alert" id="int-add-err">{err && (err.key === "_scope" || err.key === "_server") ? err.msg : ""}</div>
      </div>
    )} />
  );
}
