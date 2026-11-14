/** Add integration (legacy addDialog): Type, Settings, Connection test, Scope. The connection test is a real call (the server calls the service), not a simulation. */
import { useState } from "react";
import type { Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Field, LockNote, Empty, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import type { DialogAction } from "../../ui/overlay-context";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { AUTHS, DirTags, type FormVals, Mark, ScopePicker, catName, configOf, control, emptyVals, hostOf, secretsOf, validate, type TypeRow } from "./kit";
import { INTEGRATION_CATEGORIES } from "@gantry/domain";

const STEPS = ["Type", "Settings", "Connection test", "Scope"];
interface TestOut { ok: boolean; ms: number; lines: Array<["ok" | "fail", string]> }
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
  const [step, setStep] = useState(typeId ? 1 : 0);
  const [type, setType] = useState<string | null>(typeId);
  const [q, setQ] = useState("");
  const t = types.find((x) => x.id === type) ?? null;
  const initialName = (ty: TypeRow): string => {
    const n = insts.filter((i) => i.type === ty.id).length;
    return ty.name + (n ? ` ${n + 1}` : "");
  };
  const [name, setName] = useState(() => (typeId && types.find((x) => x.id === typeId) ? initialName(types.find((x) => x.id === typeId)!) : ""));
  const [vals, setVals] = useState<FormVals>(() => (typeId && types.find((x) => x.id === typeId) ? emptyVals(types.find((x) => x.id === typeId)!) : { config: {}, secrets: {} }));
  const [targetId, setTargetId] = useState("");
  const [projectsSel, setProjectsSel] = useState<"all" | string[]>("all");
  const [enable, setEnable] = useState(false);
  const [test, setTest] = useState<TestOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const pick = (id: string) => {
    const ty = types.find((x) => x.id === id)!;
    setType(id);
    setVals(emptyVals(ty));
    setTest(null);
    setName(initialName(ty));
    setTargetId("");
    setStep(1);
  };

  const testNow = async () => {
    if (!t) return;
    const e = validate(t, vals, true);
    setBusy(true);
    setTest(null);
    if (e) {
      setBusy(false);
      setTest({ ok: false, ms: 0, lines: [["fail", e]] });
      return;
    }
    const r = await ops.testIntegrationDraft(t.id, { config: configOf(t, vals), secrets: secretsOf(vals) });
    setBusy(false);
    const out = (r as unknown as { test?: TestOut }).test;
    setTest(out ?? { ok: false, ms: 0, lines: [["fail", r.ok ? "The test returned nothing." : r.msg]] });
  };

  const next = () => {
    if (!t) return;
    if (step === 1) {
      let e = !name.trim() ? "Name this connection." : validate(t, vals, true);
      if (!e && t.id === "webhook" && !/^[a-z0-9-]{2,24}$/.test(targetId.trim())) e = "Endpoint id: 2 to 24 lowercase letters, digits or dashes.";
      if (!e && t.id === "webhook" && insts.some((i) => (i as { targetId?: string }).targetId === targetId.trim())) e = `An endpoint called ${targetId.trim()} exists.`;
      if (e) return setErr(e);
      setErr("");
      setStep(2);
      setTest(null);
      void testNow();
    } else if (step === 2) {
      setErr("");
      setStep(3);
    }
  };

  const connect = async () => {
    if (!t) return;
    if (projectsSel !== "all" && !projectsSel.length) return setErr("Pick at least one project, or all projects.");
    const r = await ops.addIntegration({ type: t.id, name: name.trim(), config: configOf(t, vals), secrets: secretsOf(vals), projects: projectsSel === "all" ? "all" : projectsSel.slice(), enable, ...(t.id === "webhook" ? { targetId: targetId.trim() } : {}) });
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg, "ok");
    close();
    const id = (r as unknown as { integration?: { id: string } }).integration?.id;
    if (id) onAdded(id);
  };

  const ql = q.trim().toLowerCase();
  const auth = (id: string) => AUTHS.find((a) => a.value === id)?.label ?? id;
  const testGuard: Decision = busy ? { allowed: false, reason: "The test is still running." } : test?.ok ? perm : { allowed: false, reason: "Pass the connection test first." };

  const actions: DialogAction[] = [
    { label: "Cancel", kind: "ghost", id: "int-add-cancel", onClick: () => close() },
    ...(step > 0 ? [{ label: "Back", id: "int-add-back", onClick: () => { setErr(""); setStep(step - 1); } }] : []),
    ...(step === 1 ? [{ label: "Next: test connection", kind: "primary", id: "int-add-next", guard: perm, onClick: next }] : []),
    ...(step === 2 ? [{ label: "Next: scope", kind: "primary", id: "int-add-next", guard: testGuard, onClick: next }] : []),
    ...(step === 3 && t ? [{ label: `Connect ${t.name}`, kind: "primary", icon: "plug", id: "int-add-go", guard: perm, onClick: () => void connect() }] : []),
  ];

  return (
    <Dialog title="Add integration" kicker="Integrations" wide actions={actions} onClose={close} body={(
      <div className="form-grid int-add">
        <LockNote decision={perm} what="Adding integrations" />
        <ol className="stepper int-stepper" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "is-on" : i < step ? "is-done" : ""} aria-current={i === step ? "step" : undefined}>
              <span>{i < step ? "✓" : String(i + 1)}</span>
              {s}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <>
            <input id="int-add-q" className="input" placeholder="Search types" value={q} aria-label="Search integration types" onChange={(e) => setQ(e.target.value)} />
            {INTEGRATION_CATEGORIES.map((c) => {
              const list = types.filter((x) => x.category === c.id && (!ql || `${x.name} ${c.name}`.toLowerCase().includes(ql)));
              if (!list.length) return null;
              return (
                <div className="int-pick-cat" key={c.id}>
                  <div className="nt-sub int-sub">{c.name}</div>
                  <div className="int-pick">
                    {list.map((x) => {
                      const n = insts.filter((i) => i.type === x.id).length;
                      const off = x.available === false;
                      return (
                        <button type="button" className="int-pick-item" id={`int-add-type-${x.id}`} key={x.id} disabled={off} title={off ? x.unavailableReason : undefined} onClick={() => pick(x.id)}>
                          <span className="int-mark int-mark-sm"><Icon name={x.icon || "plug"} /></span>
                          <span className="int-pick-main">
                            <strong>{x.name}</strong>
                            <span className="small muted">{off ? "not yet available" : `${x.source ? "source" : ""}${x.source && x.destination ? " · " : ""}${x.destination ? "destination" : ""}${n ? ` · ${n} connected` : ""}`}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {!types.some((x) => !ql || `${x.name} ${catName(x.category)}`.toLowerCase().includes(ql)) ? <Empty title="No type matches" text="Try another word, or build a custom integration." /> : null}
          </>
        ) : null}

        {step === 1 && t ? (
          <>
            <div className="int-typeline">
              <Mark icon={t.icon} small />
              <strong>{t.name}</strong>
              <span className="muted small">{catName(t.category)} · {auth(t.auth)}</span>
              <DirTags t={t} />
            </div>
            <Field label="Connection name" htmlFor="int-add-name" hint="Shown in pickers across Gantry, so make it tell two of the same type apart (for example a workspace name).">
              <input id="int-add-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {t.fields.map((f) =>
              f.type === "bool" ? (
                <div className="field" key={f.key}>{control("int-f-", f, vals, setVals, false)}</div>
              ) : (
                <Field key={f.key} label={f.label + (f.required === false ? " (optional)" : "")} htmlFor={`int-f-${f.key}`} hint={f.type === "secret" ? "Stored sealed with the platform key and shown masked. Gantry never shows it again." : f.type === "url" ? "Must start with https://." : undefined}>
                  {control("int-f-", f, vals, setVals, false)}
                </Field>
              ),
            )}
            {t.id === "webhook" ? (
              <Field label="Endpoint id" htmlFor="int-add-target" hint="Routes in Notifications pick this endpoint by id.">
                <input id="int-add-target" className="input mono" value={targetId} placeholder="audit-lake" onChange={(e) => setTargetId(e.target.value)} />
              </Field>
            ) : null}
          </>
        ) : null}

        {step === 2 && t ? (
          <>
            <div className="int-test" role="status" aria-live="polite" id="int-add-test">
              {busy ? (
                <p className="muted"><Icon name="refresh" /> Connecting to {hostOf(t, vals)}…</p>
              ) : test ? (
                <div>
                  <div className={`decision ${test.ok ? "is-allowed" : "is-denied"}`}>
                    <div className="decision-v"><Icon name={test.ok ? "check" : "x"} />{test.ok ? "Connection works" : "Connection failed"}</div>
                    {test.ok ? <div className="mono small">{test.ms} ms</div> : null}
                  </div>
                  <ul className="int-testlines">
                    {test.lines.map((l, i) => (
                      <li key={i} className={l[0] === "ok" ? "" : "neg"}><span aria-hidden="true">{l[0] === "ok" ? "✓ " : "✕ "}</span>{l[1]}</li>
                    ))}
                  </ul>
                  <div className="form-actions"><Btn label="Run the test again" small icon="refresh" id="int-add-test-again" onClick={() => void testNow()} /></div>
                  {test.ok ? null : <p className="muted small">Go back to fix the settings, then test again.</p>}
                </div>
              ) : null}
            </div>
            <p className="footnote">Gantry makes a real call to the service with these settings: nothing is saved until you connect.</p>
          </>
        ) : null}

        {step === 3 && t ? (
          <>
            <ScopePicker prefix="int-add-scope-" projects={projects} live={live} value={projectsSel} onChange={setProjectsSel} ro={false} />
            <label className="check" htmlFor="int-add-enable">
              <input type="checkbox" id="int-add-enable" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
              <span>Switch it on now. A new connection is off until someone turns it on.</span>
            </label>
            <dl className="int-kv int-review">
              {([["Type", t.name], ["Name", name.trim()], ["Host", hostOf(t, vals)], ["Projects", projectsSel === "all" ? "All" : projectsSel.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(", ") || "none"]] as const).map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          </>
        ) : null}

        <div className="form-err" role="alert" id="int-add-err">{err}</div>
      </div>
    )} />
  );
}
