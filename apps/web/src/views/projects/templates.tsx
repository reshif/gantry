/** Templates tab (legacy projects.js templatesTab, saveFromProject, editTemplate). */
import { useState } from "react";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useTemplates } from "../../api/queries";
import { Btn, Field, LockNote } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { gateExplain, gateLock, type Catalog, type Project, type WorkClass } from "@gantry/domain";
import { MiniBelt, RouteMatrix, useCatalog, useRes, type PView } from "./kit";
import { catalogWithCustom, tplCustom, tplCustomCount, tplCustomText, tplFlowProject, customText, type Tpl, type TplCustom } from "./templates-kit";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function TplBelt({ cat, t }: { cat: Catalog; t: Tpl }) {
  const c2 = catalogWithCustom(cat, t);
  return <MiniBelt cat={c2} project={null} flowProject={tplFlowProject(c2, t)} stationsOff={t.stationsOff} gatesOff={t.gatesOff} />;
}

const builtOff = (cat: Catalog, list: string[] | undefined, kind: "s" | "g"): string[] =>
  (list ?? []).filter((id) => (kind === "s" ? cat.stations.find((s) => s.id === id) : cat.gates.find((g) => g.id === id))?.custom !== true && (kind === "s" ? cat.stations.some((s) => s.id === id) : cat.gates.some((g) => g.id === id)));

function classesText(cat: Catalog, t: Tpl): string {
  const keys = Object.keys(t.classesSkip || {});
  if (!keys.length) return "Default class routes";
  return keys
    .map((k) => {
      const c = cat.classes.find((x) => x.id === k);
      const sk = t.classesSkip[k] ?? [];
      return `${c ? c.name : k}${sk.length ? ` skips ${sk.map((s) => cat.stations.find((x) => x.id === s)?.name ?? s).join(", ")}` : " travels every station"}`;
    })
    .join("; ");
}

/** The dialog that saves a project as a template (Templates tab and Project config > Overview). */
export function useSaveFromProject(): (p: Pick<PView, "id" | "name"> & Partial<PView>) => void {
  const ui = useUI();
  const cat = useCatalog();
  return (p) => {
    let name = `${p.name} template`;
    let errEl: HTMLDivElement | null = null;
    const custom = p.flow && cat ? tplCustomFromProject(cat, p as Project) : null;
    ui.dialog({
      title: `Save ${p.name} as a template`,
      kicker: "Templates",
      sub: `Copies its stations, gates, bays, slots and class routes, custom entries included (${custom ? customText(custom) || "none here" : "none here"}). Members, repos and budgets are not copied.`,
      body: (
        <div className="form-grid">
          <Field label="Template name" htmlFor="prj-tplp-name">
            <input id="prj-tplp-name" className="input" defaultValue={name} onChange={(e) => (name = e.target.value)} />
          </Field>
          <div className="form-err" role="alert" ref={(el) => { errEl = el; }} />
        </div>
      ),
      actions: [
        { label: "Cancel" },
        {
          label: "Save template", kind: "primary", submit: true, id: "prj-tplp-ok",
          onClick: async (close) => {
            if (name.trim().length < 3) { if (errEl) errEl.textContent = "Name the template (3+ characters)."; return; }
            const r = await ops.saveTemplate({ fromProject: p.id, name: name.trim() });
            if (!r.ok) { if (errEl) errEl.textContent = r.msg; return; }
            ui.toast(r.msg, "ok");
            close();
          },
        },
      ],
    });
  };
}

/** The custom flow entries a project carries (display only; the server records them when saving). */
export function tplCustomFromProject(cat: Catalog, p: Project): TplCustom {
  const order = p.flow.order;
  return {
    stations: cat.stations.filter((s) => s.custom && order.includes(s.id)).map((s) => ({ id: s.id, name: s.name, agent: s.agent, after: order[order.indexOf(s.id) - 1] ?? "review" })),
    gates: cat.gates.filter((g) => g.custom && p.flow.gates[g.id] && !p.flow.gates[g.id]!.absent).map((g) => ({ id: g.id, label: g.label, name: g.name, after: g.after })),
    bays: cat.bays.filter((b) => b.custom && p.flow.bays.includes(b.id)).map((b) => ({ id: b.id, name: b.name })),
    classes: p.flow.classes.filter((c) => c.custom),
  };
}

export function TemplatesTab({ projects, current, onUse }: { projects: PView[]; current: PView | null; onUse: (tplId: string) => void }) {
  const ui = useUI();
  const res = useRes();
  const cat = useCatalog();
  const tpls = (useTemplates().data ?? []) as Tpl[];
  const d = useCan("template.edit");
  const create = useCan("project.create");
  const saveFrom = useSaveFromProject();
  if (!cat) return null;
  const used: Record<string, number> = {};
  for (const p of projects) used[p.template] = (used[p.template] ?? 0) + 1;
  return (
    <div className="prj-stack">
      <LockNote decision={d} what="Templates" />
      <div className="toolbar">
        <p className="muted small">A template sets stations, gates, coding slots, class routes, approver preset and notification preset for new projects. Changing a template does not change projects already created from it.</p>
        {current ? <Btn icon="copy" id="prj-tpl-from-cur" guard={d} label={`Save ${current.name} as template`} onClick={() => saveFrom(current)} /> : null}
      </div>
      <div className="prj-tpl-grid">
        {tpls.map((t) => {
          const so = builtOff(cat, t.stationsOff, "s");
          const go = builtOff(cat, t.gatesOff, "g");
          const n = used[t.id] ?? 0;
          return (
            <article key={t.id} className="prj-tpl" aria-label={t.name}>
              <div className="prj-tpl-head">
                <h3>{t.name}</h3>
                {t.builtIn ? <span className="tag">built-in</span> : <span className="tag prj-tag-custom">custom</span>}
              </div>
              <p className="small">{t.desc}</p>
              <TplBelt cat={cat} t={t} />
              <dl className="prj-tpl-facts small">
                <div><dt>Stations off</dt><dd>{so.length ? so.map((s) => cat.stations.find((x) => x.id === s)?.name ?? s).join(", ") : "none"}</dd></div>
                <div><dt>Gates off</dt><dd>{go.length ? go.map((g) => { const x = cat.gates.find((y) => y.id === g); return x ? `${x.name} · ${x.label}` : g; }).join(", ") : "none"}</dd></div>
                {tplCustomCount(t) ? <div className="prj-tpl-custom"><dt>Custom entries</dt><dd>{tplCustomText(t)}</dd></div> : null}
                <div><dt>Slots</dt><dd>{String(t.slots)}</dd></div>
                <div><dt>Approvers</dt><dd>{t.approverPreset}</dd></div>
                <div><dt>Routes</dt><dd>{classesText(cat, t)}</dd></div>
                <div><dt>Used by</dt><dd>{`${n} project${n === 1 ? "" : "s"}`}</dd></div>
              </dl>
              <div className="prj-tpl-acts">
                <Btn small kind="primary" id={`prj-tpl-use-${t.id}`} guard={create} aria={`New project from ${t.name}`} label="Use" onClick={() => onUse(t.id)} />
                <Btn small id={`prj-tpl-dup-${t.id}`} guard={d} aria={`Duplicate ${t.name}`} label="Duplicate" onClick={async () => res(await ops.saveTemplate({ fromTemplate: t.id }))} />
                <Btn small kind="ghost" id={`prj-tpl-edit-${t.id}`} aria={`Edit ${t.name}`} guard={d} disabledReason={d.allowed && t.builtIn ? "Built-in templates are read-only. Duplicate it to change it." : null} label="Edit" onClick={() => ui.open((close) => <TemplateEditor t={t} cat={cat} close={close} />)} />
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** Edit-a-template dialog (legacy editTemplate). */
function TemplateEditor({ t, cat, close }: { t: Tpl; cat: Catalog; close: () => void }) {
  const ui = useUI();
  const d = useCan("template.edit");
  const [dr, setDr] = useState(() => ({ name: t.name, desc: t.desc, stationsOff: t.stationsOff.slice(), gatesOff: t.gatesOff.slice(), slots: t.slots, classesSkip: clone(t.classesSkip || {}) as Record<string, string[]>, custom: clone(tplCustom(t)) }));
  const [err, setErr] = useState("");
  const now: Tpl = { ...t, stationsOff: dr.stationsOff, gatesOff: dr.gatesOff, classesSkip: dr.classesSkip, custom: dr.custom, slots: dr.slots };
  const c2 = catalogWithCustom(cat, now);
  const builtinClasses: WorkClass[] = cat.classes.filter((c) => !c.custom).map((c) => ({ ...clone(c), skips: dr.classesSkip[c.id] ? dr.classesSkip[c.id]!.slice() : c.skips }));
  const upd = (p: Partial<typeof dr>) => setDr((x) => ({ ...x, ...p }));
  const save = async () => {
    if (dr.name.trim().length < 3) return setErr("Name the template (3+ characters).");
    const r = await ops.updateTemplate(t.id, { name: dr.name.trim(), desc: dr.desc.trim(), stationsOff: dr.stationsOff, gatesOff: dr.gatesOff, slots: dr.slots, classesSkip: dr.classesSkip, custom: dr.custom }, { ifMatch: t.version ?? 1 });
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg, "ok");
    close();
  };
  const custom = dr.custom;
  const rows: Array<[keyof TplCustom, string, string, string]> = [];
  for (const x of custom.stations) rows.push(["stations", "Station", x.id, `${x.name} after ${cat.stations.find((s) => s.id === x.after)?.name ?? x.after}`]);
  for (const x of custom.gates) rows.push(["gates", "Gate", x.id, `${x.label} ${x.name} after ${cat.stations.find((s) => s.id === x.after)?.name ?? x.after}`]);
  for (const x of custom.bays) rows.push(["bays", "Bay", x.id, x.name]);
  for (const x of custom.classes) rows.push(["classes", "Class", x.id, x.name]);
  const dropCustom = (k: keyof TplCustom, id: string) => {
    const c = clone(dr.custom);
    (c[k] as Array<{ id: string }>) = (c[k] as Array<{ id: string }>).filter((y) => y.id !== id) as never;
    if (k === "stations") c.gates = c.gates.filter((g) => g.after !== id);
    upd({ custom: c });
    setTimeout(() => document.getElementById("prj-te-name")?.focus(), 40);
  };
  return (
    <TemplateDialog title={`Edit template ${t.name}`} onClose={close} onSave={save} guard={d}>
      <div className="form-grid">
        <div className="form-row">
          <Field label="Name" htmlFor="prj-te-name"><input id="prj-te-name" className="input" value={dr.name} onChange={(e) => upd({ name: e.target.value })} /></Field>
          <Field label="Coding slots" htmlFor="prj-te-slots">
            <select id="prj-te-slots" className="input" value={String(dr.slots)} onChange={(e) => upd({ slots: parseInt(e.target.value, 10) })}>
              {["1", "2", "3", "4", "6"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Description" htmlFor="prj-te-desc"><input id="prj-te-desc" className="input" value={dr.desc} onChange={(e) => upd({ desc: e.target.value })} /></Field>
        <div className="prj-te-preview"><span className="kicker">Preview</span><TplBelt cat={cat} t={now} /></div>
        <div className="field">
          <div className="field-label">Stations on</div>
          <div className="check-grid">
            {cat.stations.filter((s) => !s.custom).map((s) => {
              const id = `prj-te-st-${s.id}`;
              return (
                <label key={s.id} className="check" htmlFor={id} data-tip={s.id === "intake" ? "Intake is always on." : undefined}>
                  <input type="checkbox" id={id} checked={!dr.stationsOff.includes(s.id)} disabled={s.id === "intake"} onChange={(e) => upd({ stationsOff: e.target.checked ? dr.stationsOff.filter((x) => x !== s.id) : [...dr.stationsOff, s.id] })} />
                  {`${s.no} ${s.name}`}
                </label>
              );
            })}
          </div>
        </div>
        <div className="field">
          <div className="field-label">Gates on</div>
          <div className="check-grid">
            {cat.gates.filter((g) => !g.custom).map((g) => {
              const id = `prj-te-g-${g.id}`;
              return (
                <label key={g.id} className="check" htmlFor={id} title={gateLock(g).locked ? `Always on. ${gateLock(g).reason}` : gateExplain(g)}>
                  <input type="checkbox" id={id} checked={!dr.gatesOff.includes(g.id)} disabled={gateLock(g).locked} onChange={(e) => upd({ gatesOff: e.target.checked ? dr.gatesOff.filter((x) => x !== g.id) : [...dr.gatesOff, g.id] })} />
                  {`${g.name} · ${g.label}`}
                  {gateLock(g).locked ? <span className="muted small">{" (always on)"}</span> : null}
                </label>
              );
            })}
          </div>
        </div>
        <div className="field">
          <div className="field-label">Default class routes</div>
          <RouteMatrix
            cat={c2} project={tplFlowProject(c2, now)} classes={builtinClasses} stationsOff={dr.stationsOff} idp="prj-te-rm"
            onToggle={(cid, sid, travels) => {
              const def = cat.classes.find((c) => c.id === cid)!;
              let base = (dr.classesSkip[cid] ?? def.skips).slice();
              base = travels ? base.filter((x) => x !== sid) : [...base, sid];
              const next = { ...dr.classesSkip };
              if (JSON.stringify(base.slice().sort()) === JSON.stringify(def.skips.slice().sort())) delete next[cid];
              else next[cid] = base;
              upd({ classesSkip: next });
              setTimeout(() => document.getElementById(`prj-te-rm-${cid}-${sid}`)?.focus(), 40);
            }}
          />
        </div>
        <div className="field">
          <div className="field-label">Custom flow entries</div>
          {rows.length ? (
            <ul className="plain-list">
              {rows.map(([k, label, id, text]) => (
                <li key={`${k}-${id}`} className="prj-te-cust">
                  <span className="tag">{label}</span>
                  <span>{text}</span>
                  <Btn small kind="ghost" icon="x" id={`prj-te-cx-${k}-${id}`} aria={`Drop ${label.toLowerCase()} ${text} from the template`} label="Drop" onClick={() => dropCustom(k, id)} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None. Save a project with custom stations, gates, bays or classes as a template to carry them.</p>
          )}
        </div>
        {err ? <div className="form-err" role="alert">{err}</div> : <div className="form-err" role="alert" />}
      </div>
    </TemplateDialog>
  );
}

import { Dialog } from "../../ui/Overlay";
import type { Decision } from "../../ui/primitives";

function TemplateDialog({ title, children, onClose, onSave, guard }: { title: string; children: React.ReactNode; onClose: () => void; onSave: () => void; guard: Decision }) {
  return (
    <Dialog title={title} kicker="Templates" wide body={children} onClose={onClose} actions={[{ label: "Cancel" }, { label: "Save template", kind: "primary", submit: true, id: "prj-te-ok", guard, onClick: () => onSave() }]} />
  );
}
