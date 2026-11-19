/** Project config > Flow > Work classes: the table (trust ceilings, edit) and the class dialog. The On switch joins the Flow draft; everything else here saves on its own. */
import { useState } from "react";
import { TRUST_LEVELS, flowOf, type Catalog, type TrustCeiling, type WorkClass } from "@gantry/domain";
import { commands as ops } from "../../api/commands";
import { useCan } from "../../api/can";
import { useTrustCells } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { DataTable, type Col } from "../../ui/DataTable";
import { Btn, Field, Input, LockNote, Panel, Select, Toggle } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUrlDialog } from "./url-dialog";
import { useUI } from "../../ui/overlay-context";
import { ClassChip, MiniBelt, focusLater, metricsOf, routeGatesOf, routeOf, useRes, type PView } from "../projects/kit";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const TOKENS: Array<[string, string]> = [["cls-feature", "Blue"], ["cls-bug", "Rust"], ["cls-hotfix", "Pink"], ["cls-epic", "Violet"], ["cls-chore", "Slate"], ["cls-refactor", "Teal"], ["cls-security", "Red"], ["cls-docs", "Green"], ["cls-spike", "Ochre"]];
const SHAPES: Array<[string, string]> = [["bar", "Bar"], ["arrow", "Arrow"], ["wide", "Wide bar"]];

function chipOf(c: WorkClass) {
  return <ClassChip cls={{ ...c, shape: c.shape ?? (c.custom ? "bar" : c.id === "hotfix" || c.id === "security" ? "arrow" : c.id === "epic" ? "wide" : "bar") }} small />;
}

const projectCeiling = (ceilings: TrustCeiling[], pid: string, cls: string): TrustCeiling | undefined =>
  ceilings.find((c) => c.when.project === pid && c.when.cls === cls && !c.when.gate && !c.when.regulated);

/** Ceilings that apply to (project, class): the lowest `max` wins. */
function ceilingFor(ceilings: TrustCeiling[], p: PView, cls: string): { max: number; ceilings: TrustCeiling[] } {
  const hits = ceilings.filter((c) => c.enabled !== false && !(c.when.regulated && !p.regulated) && !(c.when.cls && c.when.cls !== cls) && !(c.when.project && c.when.project !== p.id) && !c.when.gate);
  return { max: hits.reduce((m, c) => Math.min(m, c.max), 4), ceilings: hits };
}

function ClassDialog({ p, cat, c, close, onAdded }: { p: PView; cat: Catalog; c: WorkClass | null; close: () => void; onAdded: (id: string) => void }) {
  const ui = useUI();
  const d = useCan("class.edit", { project: p.id });
  const isNew = !c;
  const f = flowOf(cat, p);
  const [dr, setDr] = useState(() => {
    const base: WorkClass = c ? clone(c) : { id: "", name: "", skips: [], priority: "P2", slaH: 72, est: "M", token: "cls-chore", shape: "bar", hints: [], gates: [], enabled: true, custom: true };
    return { ...base, hints: base.hints ?? [], gates: base.gates ?? [], hintsText: (base.hints ?? []).join(", ") };
  });
  const [err, setErr] = useState("");
  const upd = (x: Partial<typeof dr>) => setDr((y) => ({ ...y, ...x }));
  const id = dr.id || "__new";
  const fp = { ...p, flow: { ...clone(p.flow), classes: [...p.flow.classes.filter((k) => k.id !== id), { ...clone(dr), id } as WorkClass] } } as PView;
  const route = routeOf(cat, fp, id);
  const gates = routeGatesOf(cat, fp, id);
  const tokenLocked = !dr.custom;
  const submit = async () => {
    if (dr.name.trim().length < 2) return setErr("Name the class.");
    const hints = dr.hintsText.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const patch: Record<string, unknown> = { skips: dr.skips, priority: dr.priority, slaH: dr.slaH, est: dr.est, hints, gates: dr.gates };
    if (dr.custom) { patch.token = dr.token; patch.shape = dr.shape; }
    const r = isNew ? await ops.addClass(p.id, { name: dr.name.trim(), ...patch }, { ifMatch: p.version }) : await ops.updateClass(p.id, c!.id, dr.custom ? { name: dr.name.trim(), ...patch } : patch, { ifMatch: p.version });
    if (!r.ok) return setErr(r.msg);
    const added = (r as unknown as { cls?: { id: string } }).cls;
    if (isNew && added) onAdded(added.id);
    ui.toast(r.msg, "ok");
    close();
  };
  return (
    <Dialog
      title={isNew ? `Add a work class to ${p.name}` : `Edit ${dr.name}`} kicker={`Work classes · ${p.name}`} wide onClose={close}
      actions={[{ label: "Cancel" }, { label: isNew ? "Add class" : "Save class", kind: "primary", submit: true, id: "pcf-cl-ok", guard: d, onClick: () => void submit() }]}
      body={
        <div>
          <LockNote decision={d} what="Editing work classes" />
          <div className="form-grid">
            <div className="form-row">
              <Field label="Class name" htmlFor="pcf-cl-name" hint={!isNew && !dr.custom ? "Built-in classes keep their name." : undefined}>
                <Input id="pcf-cl-name" value={dr.name} placeholder="Data migration" autoComplete="off" disabled={!isNew && !dr.custom} onChange={(e) => upd({ name: e.target.value })} />
              </Field>
              <Field label="Colour" htmlFor="pcf-cl-token" hint={tokenLocked ? "Built-in classes keep their colour." : undefined}>
                <Select id="pcf-cl-token" aria-label="Colour token" disabled={tokenLocked} options={TOKENS.map((t) => ({ value: t[0], label: t[1] }))} value={dr.token || `cls-${dr.id}`} onChange={(v) => upd({ token: v })} />
              </Field>
              <Field label="Mark shape" htmlFor="pcf-cl-shape">
                <Select id="pcf-cl-shape" aria-label="Mark shape" disabled={tokenLocked} options={SHAPES.map((t) => ({ value: t[0], label: t[1] }))} value={dr.shape || "bar"} onChange={(v) => upd({ shape: v })} />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Priority" htmlFor="pcf-cl-prio"><Select id="pcf-cl-prio" options={["P0", "P1", "P2", "P3"]} value={dr.priority} onChange={(v) => upd({ priority: v as WorkClass["priority"] })} /></Field>
              <Field label="SLA (hours)" htmlFor="pcf-cl-sla"><Input id="pcf-cl-sla" type="number" min={1} max={720} className="mono pcf-num" value={String(dr.slaH)} onChange={(e) => upd({ slaH: parseInt(e.target.value, 10) || 72 })} /></Field>
              <Field label="Typical size" htmlFor="pcf-cl-est"><Select id="pcf-cl-est" options={["S", "M", "L", "XL"]} value={dr.est || "M"} onChange={(v) => upd({ est: v as WorkClass["est"] })} /></Field>
            </div>
            <div className="field">
              <div className="field-label">Route: stations it travels</div>
              <div className="check-grid">
                {f.stations.map((s) => {
                  const cid = `pcf-cl-st-${s.id}`;
                  const fixed = s.id === "intake" || s.id === "close";
                  return (
                    <label key={s.id} className="check" htmlFor={cid} data-tip={fixed ? `${s.name} is on every route.` : !s.enabled ? `${s.name} is off for the whole project.` : undefined}>
                      <input type="checkbox" id={cid} checked={!dr.skips.includes(s.id)} disabled={fixed} onChange={(e) => upd({ skips: e.target.checked ? dr.skips.filter((x) => x !== s.id) : [...dr.skips, s.id] })} />
                      {`${s.no} ${s.name}`}
                      {s.custom ? <span className="tag pcf-tag-custom">custom</span> : null}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="field">
              <div className="field-label">Required human gates</div>
              <p className="small muted">Leave all unticked to require every human gate on the route. Automatic gates always run.</p>
              <div className="check-grid">
                {f.gates.filter((g) => g.id !== "G0G1" && g.kind !== "auto").map((g) => {
                  const gid = `pcf-cl-g-${g.id}`;
                  return (
                    <label key={g.id} className="check" htmlFor={gid}>
                      <input type="checkbox" id={gid} checked={dr.gates.includes(g.id)} onChange={(e) => upd({ gates: e.target.checked ? [...dr.gates, g.id] : dr.gates.filter((x) => x !== g.id) })} />
                      {`${g.label} ${g.name}`}
                    </label>
                  );
                })}
              </div>
            </div>
            <Field label="Classifier hints" htmlFor="pcf-cl-hints" hint="Comma-separated words. When a request mentions one, the Intake agent proposes this class.">
              <Input id="pcf-cl-hints" value={dr.hintsText} placeholder="migrate, backfill, schema" onChange={(e) => upd({ hintsText: e.target.value })} />
            </Field>
            <div className="pcf-pv-wrap">
              <div className="pcf-pv-head">
                <span className="kicker">Preview</span>
                <span className={`cls cls-sm ${dr.custom ? dr.token : `cls-${dr.id}`} pcf-shape-${dr.shape || "bar"}`}><span className="cls-mark" aria-hidden="true" />{dr.name || "New class"}</span>
              </div>
              <MiniBelt cat={cat} project={fp} cls={id} labels />
              <p className="small" aria-live="polite">
                {route.map((sid) => cat.stations.find((x) => x.id === sid)?.name ?? sid).join(" → ")}
                <br />
                <span className="muted">{`Gates ${gates.map((g) => cat.gates.find((x) => x.id === g)?.label ?? g).join(", ") || "none"} · SLA ${dr.slaH} h · ${dr.priority}`}</span>
              </p>
            </div>
            <div className="form-err" role="alert">{err}</div>
          </div>
        </div>
      }
    />
  );
}

export function WorkClassesPanel({ p, cat, classes, changed, onEnable, onAdded }: { p: PView; cat: Catalog; /** The classes as the draft has them. */ classes: WorkClass[]; changed: ReadonlySet<string>; onEnable: (cid: string, on: boolean) => void; onAdded: (id: string) => void }) {
  const res = useRes();
  const d = useCan("class.edit", { project: p.id });
  const fd = useCan("project.config", { project: p.id });
  const td = useCan("trust.criteria");
  const ceilings = useTrustCells().data?.ceilings ?? [];
  const m = metricsOf(p);
  const f = flowOf(cat, p);
  const on = classes.filter((c) => c.enabled !== false).length;
  const openClass = useUrlDialog("class", (cid, close) => <ClassDialog p={p} cat={cat} c={cid ? (p.flow.classes.find((x) => x.id === cid) ?? classes.find((x) => x.id === cid) ?? null) : null} close={close} onAdded={cid ? () => undefined : onAdded} />);
  const cols: Array<Col<WorkClass>> = [
    { key: "c", label: "Class", render: (c) => <span>{chipOf(c)}{c.custom ? <span className="tag pcf-tag-custom">custom</span> : null}{changed.has(c.id) ? <span className="chip chip-warn">changed</span> : null}</span> },
    { key: "on", label: "On", render: (c) => {
      const inUse = m.byClass[c.id] ?? 0;
      return (
        <Toggle id={`pcf-cl-en-${c.id}`} checked={c.enabled !== false} label={`${c.name} enabled`}
          decision={fd.allowed && c.enabled !== false && inUse ? { allowed: false, reason: `${inUse} open work order${inUse > 1 ? "s use " : " uses "}${c.name}. Reclassify or finish them first.`, needs: "" } : fd}
          onChange={(v) => onEnable(c.id, v)} />
      );
    } },
    { key: "route", label: "Route", render: (c) => {
      const route = routeOf(cat, { ...p, flow: { ...p.flow, classes } } as PView, c.id);
      const skipped = f.stations.filter((s) => !route.includes(s.id)).map((s) => s.name);
      return <span className="small">{skipped.length ? `skips ${skipped.join(", ")}` : "every station"}{c.endsAfter ? <div className="muted">{`ends after ${cat.stations.find((x) => x.id === c.endsAfter)?.name ?? c.endsAfter}`}</div> : null}</span>;
    } },
    { key: "g", label: "Human gates", render: (c) => <span className="small mono pcf-nowrap">{c.gates && c.gates.length ? c.gates.map((g) => cat.gates.find((x) => x.id === g)?.label ?? g).join(", ") : "all on route"}</span> },
    { key: "sla", label: "SLA", align: "end", render: (c) => <span className="mono">{`${c.slaH || "-"} h`}</span> },
    { key: "prio", label: "Priority", render: (c) => <span className="mono">{c.priority || "-"}</span> },
    { key: "hints", label: "Classifier hints", render: (c) => <span className="small">{c.hints && c.hints.length ? c.hints.join(", ") : <span className="muted">keyword model</span>}</span> },
    { key: "cap", label: "Trust cap", render: (c) => {
      const own = projectCeiling(ceilings, p.id, c.id);
      const ceil = ceilingFor(ceilings, p, c.id);
      const others = ceil.ceilings.filter((x) => !own || x.id !== own.id);
      return (
        <div className="pcf-ceil">
          <span {...(!td.allowed ? { "aria-disabled": "true", "data-reason": `${td.needs ? `${td.needs}. ` : ""}${td.reason}` } : {})}>
            <Select
              id={`pcf-cl-ceil-${c.id}`} aria-label={`Trust ceiling for ${c.name}`} disabled={!td.allowed}
              options={[{ value: "", label: "No project cap" }, ...[0, 1, 2, 3, 4].map((l) => ({ value: String(l), label: `Cap at L${l} ${TRUST_LEVELS[l]?.name ?? ""}` }))]}
              value={own ? String(own.max) : ""}
              onChange={async (v) => {
                const r = v === "" ? (own ? await ops.removeCeiling(own.id) : { ok: true, msg: "No project cap." }) : await ops.saveCeiling({ id: own ? own.id : undefined, text: `${c.name} on ${p.name} is capped at L${v}`, when: { project: p.id, cls: c.id }, max: +v, enabled: true });
                res(r);
                focusLater(`pcf-cl-ceil-${c.id}`);
              }}
            />
          </span>
          {others.length ? <div className="muted small" data-tip={others.map((x) => `${x.id}: ${x.text}`).join("; ")} tabIndex={0}>{`Effective L${ceil.max} (${others.map((x) => x.id).join(", ")})`}</div> : <div className="muted small">{`Effective L${ceil.max}`}</div>}
        </div>
      );
    } },
    { key: "open", label: "Open", align: "end", render: (c) => <span className="mono">{String(m.byClass[c.id] ?? 0)}</span> },
    { key: "edit", label: "", align: "end", render: (c) => <Btn small kind="ghost" id={`pcf-cl-edit-${c.id}`} aria={`Edit ${c.name}`} guard={d} label="Edit" onClick={() => openClass(c.id)} /> },
  ];
  return (
    <Panel title={`Work classes on ${p.name}`} flush id="flw-classes" tools={<Btn small icon="plus" id="pcf-add-class" guard={d} label="Add class" onClick={() => openClass()} />}>
      <LockNote decision={d} what="Work classes" />
      <p className="small muted pcf-pad">{`${on} of ${classes.length} classes on. The class decides the route, which human gates apply, the SLA and how the Intake agent recognises it. The trust cap limits how far agents may run unattended for that class here; factory-wide ceilings still apply.`}</p>
      <DataTable id="pcf-cl-table" caption="Work classes" columns={cols} rows={classes} rowKey={(c) => c.id} />
      {td.allowed ? null : <p className="small muted pcf-pad"><Icon name="lock" /> Trust caps need <span className="mono">trust.criteria</span> (Factory Admin). They are shown read-only.</p>}
    </Panel>
  );
}
