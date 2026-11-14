/** Project config: Flow tab and its dialogs (legacy project-config.js flowTab, stationDialog, gateDialog, bayDialog). */
import { useState, type ReactNode } from "react";
import { flowOf, type Catalog, type Project, type WorkClass } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useAgents, useTemplates } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Btn, Field, LockNote, Panel, Select, Toggle, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { ClassChip, GateDiamond, MiniBelt, NumInput, RouteMatrix, classOf, focusLater, gateState, metricsOf, projectRoles, routeGatesOf, routeOf, useRes, type PView } from "../projects/kit";
import { flowFrom, type Tpl } from "../projects/templates-kit";
import type { PcProps } from "./ctx";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

interface StripItem {
  name: string;
  no: string;
  custom?: boolean | undefined;
  off?: boolean;
  isNew?: boolean;
  gate?: string | null;
  gateNew?: boolean;
}

/** A strip in the mini-belt style for dialogs. */
function PreviewStrip({ items, label }: { items: StripItem[]; label?: string }) {
  return (
    <div className="mbelt pcf-pv" role="img" aria-label={label || items.map((x) => x.name).join(", ")}>
      {items.map((x, i) => (
        <span key={i} style={{ display: "contents" }}>
          <span className={`mseg${x.isNew ? " is-custom is-new" : x.custom ? " is-custom" : ""}${x.off ? " is-off" : ""}`} title={`${x.no} ${x.name}`}>
            <span className="mseg-n mono">{x.isNew ? "new" : x.no.replace(/^S/, "")}</span>
          </span>
          {x.gate ? <span className={`mgate ${x.gateNew ? "pcf-pv-gnew" : "gate-clear"}`} title={x.gate} /> : null}
        </span>
      ))}
    </div>
  );
}

function stripFor(cat: Catalog, p: Project, insert?: { station?: string; after?: string; withGate?: string | null; gateAfter?: string; gateName?: string }): StripItem[] {
  const f = flowOf(cat, p);
  const out: StripItem[] = [];
  for (const s of f.stations) {
    const g = f.gates.find((x) => x.after === s.id);
    out.push({ name: s.name, no: s.no, custom: s.custom, off: !s.enabled, gate: g ? g.label : insert?.gateAfter === s.id ? (insert.gateName ?? null) : null, gateNew: !g && insert?.gateAfter === s.id });
    if (insert?.station && insert.after === s.id) out.push({ name: insert.station, no: "new", isNew: true, gate: insert.withGate ?? null, gateNew: true });
  }
  return out;
}

function RolePicker({ cat, idp, sel, onChange }: { cat: Catalog; idp: string; sel: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="check-grid">
      {projectRoles(cat).filter((r) => r.id !== "viewer").map((ro) => {
        const id = `${idp}-${ro.id}`;
        return (
          <label key={ro.id} className="check" htmlFor={id}>
            <input type="checkbox" id={id} checked={sel.includes(ro.id)} onChange={(e) => onChange(e.target.checked ? [...sel, ro.id] : sel.filter((x) => x !== ro.id))} />
            {ro.name}
            {ro.custom ? <span className="tag pcf-tag-custom">custom</span> : null}
          </label>
        );
      })}
    </div>
  );
}

const KINDS = [{ value: "human", label: "Human: approver rules" }, { value: "mixed", label: "Mixed: checks, then a person" }, { value: "auto", label: "Automatic: checks only" }];

function StationDialog({ p, cat, close }: { p: PView; cat: Catalog; close: () => void }) {
  const ui = useUI();
  const d = useCan("flow.edit", { project: p.id });
  const agents = useAgents().data ?? [];
  const order = flowOf(cat, p).stations.filter((s) => s.id !== "close");
  const [dr, setDr] = useState({ name: "", agent: "", purpose: "", wip: 5, after: (order.find((s) => s.id === "review") ?? order[order.length - 1])?.id ?? "", gate: false, gName: "", gKind: "human", gRoles: ["line_lead"] as string[] });
  const [err, setErr] = useState("");
  const agent = dr.agent || (agents.find((a) => a.id === "ag-review") ?? agents[0])?.id || "";
  const upd = (x: Partial<typeof dr>) => setDr((y) => ({ ...y, ...x }));
  const submit = async () => {
    if (dr.name.trim().length < 2) return setErr("Name the station.");
    if (dr.gate && dr.gName.trim().length < 2) return setErr("Name the gate, or untick it.");
    if (dr.gate && dr.gKind !== "auto" && !dr.gRoles.length) return setErr("Pick at least one approver role for the gate.");
    const r = await ops.addStation(p.id, { name: dr.name.trim(), agent, purpose: dr.purpose.trim(), wip: dr.wip, gate: dr.gate ? { name: dr.gName.trim(), kind: dr.gKind, roles: dr.gKind === "auto" ? [] : dr.gRoles, required: 1, purpose: `Sign-off after ${dr.name.trim()}.` } : null }, dr.after, { ifMatch: p.version });
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg + (dr.gate ? " Gate added after it." : ""), "ok");
    close();
  };
  return (
    <Dialog
      title={`Add a station to ${p.name}`} kicker="Flow · custom station" wide onClose={close}
      sub="The station appears on this project's belt, board and traveler. Work classes travel it unless their route skips it."
      actions={[{ label: "Cancel" }, { label: "Add station", kind: "primary", submit: true, id: "pcf-ns-ok", guard: d, onClick: () => void submit() }]}
      body={
        <div>
          <LockNote decision={d} what="Adding stations" />
          <div className="form-grid">
            <div className="form-row">
              <Field label="Station name" htmlFor="pcf-ns-name"><input id="pcf-ns-name" className="input" value={dr.name} placeholder="Load test" autoComplete="off" onChange={(e) => upd({ name: e.target.value })} /></Field>
              <Field label="WIP limit" htmlFor="pcf-ns-wip"><input id="pcf-ns-wip" type="number" min={1} max={30} className="input mono pcf-num" value={String(dr.wip)} onChange={(e) => upd({ wip: parseInt(e.target.value, 10) || 5 })} /></Field>
            </div>
            <div className="form-row">
              <Field label="Staffing agent" htmlFor="pcf-ns-agent"><Select id="pcf-ns-agent" options={agents.map((a) => ({ value: a.id, label: `${a.name} · ${cat.stations.find((s) => s.id === a.station)?.name ?? a.station ?? "no station"}` }))} value={agent} onChange={(v) => upd({ agent: v })} /></Field>
              <Field label="Position" htmlFor="pcf-ns-after" hint="Close always stays last."><Select id="pcf-ns-after" options={order.map((s) => ({ value: s.id, label: `After ${s.no} ${s.name}` }))} value={dr.after} onChange={(v) => upd({ after: v })} /></Field>
            </div>
            <Field label="Purpose" htmlFor="pcf-ns-purpose"><input id="pcf-ns-purpose" className="input" value={dr.purpose} placeholder="What the agent checks or produces here" onChange={(e) => upd({ purpose: e.target.value })} /></Field>
            <label className="check" htmlFor="pcf-ns-gate">
              <input type="checkbox" id="pcf-ns-gate" checked={dr.gate} onChange={(e) => { upd({ gate: e.target.checked }); focusLater("pcf-ns-gate"); }} />
              Add a gate after this station
            </label>
            {dr.gate ? (
              <div className="pcf-fs">
                <div className="form-row">
                  <Field label="Gate name" htmlFor="pcf-ns-gname"><input id="pcf-ns-gname" className="input" value={dr.gName} placeholder="Load test sign-off" onChange={(e) => upd({ gName: e.target.value })} /></Field>
                  <Field label="Kind" htmlFor="pcf-ns-gkind"><Select id="pcf-ns-gkind" options={KINDS} value={dr.gKind} onChange={(v) => upd({ gKind: v })} /></Field>
                </div>
                {dr.gKind !== "auto" ? <Field label="Approver roles"><RolePicker cat={cat} idp="pcf-ns-gr" sel={dr.gRoles} onChange={(ids) => upd({ gRoles: ids })} /></Field> : null}
              </div>
            ) : null}
            <div className="pcf-pv-wrap">
              <span className="kicker">Preview</span>
              <PreviewStrip items={stripFor(cat, p, { station: dr.name || "New station", after: dr.after, withGate: dr.gate ? dr.gName || "gate" : null })} label={`Flow with the new station after ${cat.stations.find((s) => s.id === dr.after)?.name ?? dr.after}`} />
            </div>
            <div className="form-err" role="alert">{err}</div>
          </div>
        </div>
      }
    />
  );
}

function GateDialog({ p, cat, close }: { p: PView; cat: Catalog; close: () => void }) {
  const ui = useUI();
  const d = useCan("flow.edit", { project: p.id });
  const f = flowOf(cat, p);
  const free = f.stations.filter((s) => s.id !== "close" && !f.gates.some((g) => g.after === s.id) && !cat.gates.some((g) => g.after === s.id && !(p.flow.gates[g.id]?.absent ?? true)));
  const [dr, setDr] = useState({ name: "", label: "", after: free[0]?.id ?? "", kind: "human", roles: ["line_lead"] as string[], required: 1, purpose: "" });
  const [err, setErr] = useState("");
  const upd = (x: Partial<typeof dr>) => setDr((y) => ({ ...y, ...x }));
  const guard: Decision = free.length ? d : { allowed: false, reason: "Every station already has a gate.", needs: "" };
  const submit = async () => {
    if (dr.name.trim().length < 2) return setErr("Name the gate.");
    if (dr.kind !== "auto" && !dr.roles.length) return setErr("Pick at least one approver role.");
    const r = await ops.addGate(p.id, { name: dr.name.trim(), label: dr.label || undefined, after: dr.after, kind: dr.kind, roles: dr.kind === "auto" ? [] : dr.roles, required: dr.required, purpose: dr.purpose.trim() }, { ifMatch: p.version });
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg, "ok");
    close();
  };
  return (
    <Dialog
      title={`Add a gate to ${p.name}`} kicker="Flow · custom gate" wide onClose={close}
      sub="Named approvers, conditions and escalation are edited on the Approvers tab once the gate exists."
      actions={[{ label: "Cancel" }, { label: "Add gate", kind: "primary", submit: true, id: "pcf-ng-ok", guard, onClick: () => void submit() }]}
      body={
        <div>
          <LockNote decision={d} what="Adding gates" />
          <div className="form-grid">
            {!free.length ? (
              <div className="empty empty-state" id="pcf-ng-none">
                <div className="empty-icon" aria-hidden="true"><Icon name="gate" /></div>
                <div className="empty-title">Every station already has a gate</div>
                <p>A station can have one gate after it. Add a custom station first; you can create its gate in the same step.</p>
              </div>
            ) : (
              <>
                <div className="form-row">
                  <Field label="Gate name" htmlFor="pcf-ng-name"><input id="pcf-ng-name" className="input" value={dr.name} placeholder="Load test sign-off" autoComplete="off" onChange={(e) => upd({ name: e.target.value })} /></Field>
                  <Field label="Short label" htmlFor="pcf-ng-label" hint="Shown in the diamond. Letters and digits."><input id="pcf-ng-label" className="input mono" value={dr.label} maxLength={5} placeholder="GL" onChange={(e) => upd({ label: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} /></Field>
                </div>
                <div className="form-row">
                  <Field label="After station" htmlFor="pcf-ng-after" hint="Only stations without a gate are listed."><Select id="pcf-ng-after" options={free.map((s) => ({ value: s.id, label: `${s.no} ${s.name}` }))} value={dr.after} onChange={(v) => upd({ after: v })} /></Field>
                  <Field label="Kind" htmlFor="pcf-ng-kind"><Select id="pcf-ng-kind" options={KINDS} value={dr.kind} onChange={(v) => upd({ kind: v })} /></Field>
                </div>
                {dr.kind !== "auto" ? (
                  <div className="form-row">
                    <Field label="Approver roles"><RolePicker cat={cat} idp="pcf-ng-r" sel={dr.roles} onChange={(ids) => upd({ roles: ids })} /></Field>
                    <Field label="Approvals needed" htmlFor="pcf-ng-req"><input id="pcf-ng-req" type="number" min={1} max={5} className="input mono pcf-num" value={String(dr.required)} onChange={(e) => upd({ required: parseInt(e.target.value, 10) || 1 })} /></Field>
                  </div>
                ) : null}
                <Field label="Purpose" htmlFor="pcf-ng-purpose"><input id="pcf-ng-purpose" className="input" value={dr.purpose} placeholder="What has to be true to pass" onChange={(e) => upd({ purpose: e.target.value })} /></Field>
                <div className="pcf-pv-wrap">
                  <span className="kicker">Preview</span>
                  <PreviewStrip items={stripFor(cat, p, { gateAfter: dr.after, gateName: dr.name || "new gate" })} label={`Flow with the new gate after ${cat.stations.find((s) => s.id === dr.after)?.name ?? dr.after}`} />
                </div>
              </>
            )}
            <div className="form-err" role="alert">{err}</div>
          </div>
        </div>
      }
    />
  );
}

function BayDialog({ p, close }: { p: PView; close: () => void }) {
  const ui = useUI();
  const d = useCan("flow.edit", { project: p.id });
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState("");
  return (
    <Dialog
      title={`Add a bay to ${p.name}`} kicker="Flow · custom bay" onClose={close} sub="Bays sit off the main belt. Work orders can be parked there and returned."
      actions={[{ label: "Cancel" }, {
        label: "Add bay", kind: "primary", submit: true, id: "pcf-nb-ok", guard: d,
        onClick: async () => {
          if (name.trim().length < 2) return setErr("Name the bay.");
          const r = await ops.addBay(p.id, { name: name.trim(), desc: desc.trim() }, { ifMatch: p.version });
          if (!r.ok) return setErr(r.msg);
          ui.toast(r.msg, "ok");
          close();
        },
      }]}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Adding bays" />
          <Field label="Bay name" htmlFor="pcf-nb-name"><input id="pcf-nb-name" className="input" value={name} placeholder="Vendor review" autoComplete="off" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="What waits here" htmlFor="pcf-nb-desc"><input id="pcf-nb-desc" className="input" value={desc} placeholder="Waiting for a reply from the vendor" onChange={(e) => setDesc(e.target.value)} /></Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
    />
  );
}

export function FlowTab({ p, cat, s, set }: PcProps) {
  const ui = useUI();
  const res = useRes();
  const d = useCan("project.config", { project: p.id });
  const fd = useCan("flow.edit", { project: p.id });
  const tpls = (useTemplates().data ?? []) as Tpl[];
  const agents = useAgents().data ?? [];
  const f = flowOf(cat, p);
  const m = metricsOf(p);
  const flowCls = p.flow.classes.some((c) => c.id === s.flowCls) ? s.flowCls : (p.flow.classes[0]?.id ?? "");
  const cls = classOf(cat, p, flowCls);
  const rStations = routeOf(cat, p, flowCls).map((x) => cat.stations.find((y) => y.id === x)?.name ?? x).join(" → ");
  const rGates = routeGatesOf(cat, p, flowCls).map((x) => cat.gates.find((y) => y.id === x)?.label ?? x).join(", ");
  const skipped = f.stations.filter((x) => !routeOf(cat, p, flowCls).includes(x.id)).map((x) => x.name);
  const n = f.stations.length;
  const setClasses = async (fn: (arr: WorkClass[]) => void) => {
    const arr = clone(p.flow.classes);
    fn(arr);
    res(await ops.setProject(p.id, "flow.classes", arr), "Class routes saved.");
  };
  const dialog = (render: (close: () => void) => ReactNode) => ui.open(render);
  void agents;
  return (
    <div className="pcf-stack">
      <LockNote decision={d} what="Flow settings" />
      <section className="panel pcf-preview" aria-label="Live route preview">
        <div className="pcf-preview-head">
          <span className="kicker">{`Live preview · ${f.stations.length} stations, ${f.gates.length} gates, ${f.bays.length} bays`}</span>
          <Field label="Class" htmlFor="pcf-flow-cls">
            <Select id="pcf-flow-cls" options={p.flow.classes.map((c) => ({ value: c.id, label: c.name + (c.enabled === false ? " (off)" : "") + (c.custom ? " (custom)" : "") }))} value={flowCls} onChange={(v) => set({ flowCls: v })} />
          </Field>
        </div>
        <MiniBelt cat={cat} project={p} counts={m.byPosition} cls={flowCls} labels />
        <p className="small pcf-route-t" aria-live="polite">
          <strong>{`${cls.name}: `}</strong>
          {rStations}
          <br />
          <span className="muted">{`Gates ${rGates || "none"}${skipped.length ? ` · skips ${skipped.join(", ")}` : ""}`}</span>
        </p>
      </section>
      <Panel title="Stations, WIP limits and slots" flush tools={<Btn small icon="plus" id="pcf-add-station" guard={fd} label="Add station" onClick={() => dialog((close) => <StationDialog p={p} cat={cat} close={close} />)} />}>
        <div className="table-scroll">
          <table className="table table-compact pcf-st-table">
            <thead><tr><th>No</th><th>Station</th><th>On</th><th>WIP limit</th><th className="num">WIP now</th><th>Coding slots</th><th>Order</th></tr></thead>
            <tbody>
              {f.stations.map((st, i) => {
                const cfg = p.flow.stations[st.id]!;
                const here = m.byPosition[st.id]?.n ?? 0;
                const ag = agents.find((a) => a.id === st.agent);
                const fixed = st.id === "intake" || st.id === "close";
                const upWhy = fixed ? (st.id === "intake" ? "Intake stays first." : "Close stays last.") : i <= 1 ? "Intake stays first." : null;
                const downWhy = fixed ? (st.id === "intake" ? "Intake stays first." : "Close stays last.") : i >= n - 2 ? "Close stays last." : null;
                return (
                  <tr key={st.id} className={`${cfg.enabled ? "" : "is-disabled"}${st.custom ? " is-custom" : ""}`.trim() || undefined}>
                    <td className="mono">{st.no}</td>
                    <th scope="row">
                      {st.name}
                      {st.custom ? <span className="tag pcf-tag-custom">custom</span> : null}
                      <div className="muted small">{ag ? ag.name : st.agent}</div>
                    </th>
                    <td>
                      {st.id === "intake" ? (
                        <span data-tip="Intake is always on: every work order starts there." tabIndex={0} className="muted small"><Icon name="lock" /> always on</span>
                      ) : (
                        <Toggle id={`pcf-st-${st.id}`} checked={cfg.enabled} decision={d} label={`${st.name} on`} onChange={async (v) => res(await ops.setProject(p.id, `flow.stations.${st.id}.enabled`, v), `${st.name}${v ? " turned on." : " turned off."}`)} />
                      )}
                    </td>
                    <td><NumInput id={`pcf-wip-${st.id}`} value={cfg.wip} min={1} max={30} locked={!d.allowed} label={`${st.name} WIP limit`} onCommit={async (v) => res(await ops.setProject(p.id, `flow.stations.${st.id}.wip`, v), `${st.name} WIP limit set to ${v}.`)} /></td>
                    <td className={`num mono${here > cfg.wip ? " neg" : ""}`}>{here + (here > cfg.wip ? " over" : "")}</td>
                    <td>
                      {st.id === "build" ? (
                        <div className="pcf-slots">
                          <NumInput id="pcf-slots" value={p.flow.slots} min={1} max={8} locked={!d.allowed} label="Coding slots" onCommit={async (v) => res(await ops.setProject(p.id, "flow.slots", v), `Coding slots set to ${v}.`)} />
                          <span className="small muted">{`${m.slotsUsed} in use`}</span>
                        </div>
                      ) : null}
                    </td>
                    <td className="pcf-order">
                      {fixed ? <span className="muted small pcf-fixed" data-tip={st.id === "intake" ? "Intake stays first." : "Close stays last."} tabIndex={0}><Icon name="lock" />{st.id === "intake" ? " first" : " last"}</span> : null}
                      {fixed ? null : <Btn small kind="ghost" icon="up" id={`pcf-mv-up-${st.id}`} aria={`Move ${st.name} earlier`} guard={fd} disabledReason={fd.allowed ? upWhy : null} onClick={async () => { res(await ops.moveStation(p.id, st.id, -1)); focusLater(`pcf-mv-up-${st.id}`); }} />}
                      {fixed ? null : <Btn small kind="ghost" icon="down" id={`pcf-mv-dn-${st.id}`} aria={`Move ${st.name} later`} guard={fd} disabledReason={fd.allowed ? downWhy : null} onClick={async () => { res(await ops.moveStation(p.id, st.id, 1)); focusLater(`pcf-mv-dn-${st.id}`); }} />}
                      {st.custom ? (
                        <Btn small kind="ghost" icon="x" id={`pcf-st-rm-${st.id}`} aria={`Remove ${st.name}`} label="Remove" guard={fd} disabledReason={fd.allowed && here ? `${here} work order${here > 1 ? "s are" : " is"} at ${st.name}. Move them first.` : null}
                          onClick={() => ui.typedConfirm({ title: `Remove ${st.name}`, kicker: `Flow · ${p.name}`, sub: "Its gate goes too. Routes skip it from now on. History keeps the station's past entries.", phrase: st.name, okLabel: "Remove station", guard: fd, onOk: async () => { const r = await ops.removeStation(p.id, st.id); ui.toast(r.msg, r.ok ? "ok" : "error"); return r.ok ? undefined : { ok: false, msg: r.msg }; } })} />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="two-col pcf-flow-cols">
        <Panel title="Gates" flush tools={<Btn small icon="plus" id="pcf-add-gate" guard={fd} label="Add gate" onClick={() => dialog((close) => <GateDialog p={p} cat={cat} close={close} />)} />}>
          <div className="table-scroll">
            <table className="table table-compact">
              <thead><tr><th></th><th>Gate</th><th>Kind</th><th>On</th><th></th></tr></thead>
              <tbody>
                {f.gates.map((g) => {
                  const on = p.flow.gates[g.id]!.enabled;
                  const gs = gateState(p, g.id);
                  const mode = g.mode;
                  const opts = KINDS.filter((o) => (g.id === "G0G1" ? o.value === "human" : g.id === "G6" ? o.value !== "auto" : true));
                  return (
                    <tr key={g.id} className={`${on ? "" : "is-disabled"}${g.custom ? " is-custom" : ""}`.trim() || undefined}>
                      <td><GateDiamond cat={cat} gateId={g.id} state={gs.state} count={gs.waiting || gs.failing} size="sm" /></td>
                      <th scope="row">
                        <span className="mono">{g.label}</span>{` ${g.name}`}
                        {g.custom ? <span className="tag pcf-tag-custom">custom</span> : null}
                        <div className="muted small">{`after ${cat.stations.find((x) => x.id === g.after)?.name ?? g.after}`}</div>
                      </th>
                      <td className="small">
                        <div>
                          <Select id={`pcf-gmode-${g.id}`} aria-label={`${g.label} mode`} disabled={!d.allowed || g.id === "G0G1"} options={opts} value={mode} onChange={async (v) => res(await ops.setGateMode(p.id, g.id, v))} />
                          {mode !== "human" && (g.checks ?? []).length ? <div className="muted small">{g.checks.join(", ")}</div> : null}
                        </div>
                      </td>
                      <td>
                        {g.id === "G0G1" ? (
                          <span data-tip="The brief confirmation gate cannot be turned off." tabIndex={0} className="muted small"><Icon name="lock" /> always on</span>
                        ) : (
                          <Toggle id={`pcf-gate-${g.id}`} checked={on} decision={d} label={`${g.label} on`} onChange={async (v) => res(await ops.setProject(p.id, `flow.gates.${g.id}.enabled`, v), `${g.label}${v ? " turned on." : " turned off."}`)} />
                        )}
                      </td>
                      <td>{mode === "auto" ? <span className="muted small">no approvers</span> : <Btn small kind="ghost" id={`pcf-gate-ap-${g.id}`} label="Approvers" onClick={() => set({ tab: "approvers", gate: g.id })} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Bays off the main belt" tools={<Btn small icon="plus" id="pcf-add-bay" guard={fd} label="Add bay" onClick={() => dialog((close) => <BayDialog p={p} close={close} />)} />}>
          <ul className="plain-list pcf-bays">
            {f.bays.map((b) => (
              <li key={b.id} className={`pcf-bay${b.custom ? " is-custom" : ""}`}>
                <span className="pcf-bay-n">{b.name}{b.custom ? <span className="tag pcf-tag-custom">custom</span> : null}</span>
                <span className="muted small">{b.desc || ""}</span>
                <span className="mono small">{`${m.byPosition[b.id]?.n ?? 0} parked`}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <Panel title="Class routes" flush>
        <div>
          <p className="small muted pcf-pad">
            Ticked stations are on the class's route. Select a class to preview its route on the belt above. Turning a class off stops the Intake agent from proposing it. Add or edit classes on the{" "}
            <button type="button" className="linkish" id="pcf-to-classes" onClick={() => set({ tab: "classes" })}>Work classes</button> tab.
          </p>
          <RouteMatrix
            cat={cat} project={p} classes={p.flow.classes} stationsOff={f.stations.filter((x) => !x.enabled).map((x) => x.id)} decision={d} selected={flowCls} idp="pcf-rm"
            onSelect={(id) => set({ flowCls: id })}
            onToggle={(cid, sid, travels) => { void setClasses((arr) => { const c = arr.find((x) => x.id === cid)!; c.skips = travels ? c.skips.filter((x) => x !== sid) : [...c.skips, sid]; }); set({ flowCls: cid }); }}
            onEnable={(cid, v) => {
              const open = m.byClass[cid] ?? 0;
              if (!v && open) return void ui.toast(`Open work orders use ${classOf(cat, p, cid).name}. Reclassify or finish them first.`, "error");
              void setClasses((arr) => { arr.find((x) => x.id === cid)!.enabled = v; });
            }}
          />
          <div className="pcf-pad">
            <Btn small kind="ghost" icon="undo" id="pcf-rm-reset" guard={d} label="Reset routes to the template" onClick={async () => {
              const tpl = tpls.find((t) => t.id === p.template) ?? tpls[0];
              if (!tpl) return;
              const fresh = flowFrom(cat, tpl).classes;
              for (const c of fresh) { const cur = p.flow.classes.find((x) => x.id === c.id); if (cur) c.enabled = cur.enabled; }
              for (const c of p.flow.classes.filter((x) => x.custom)) fresh.push(clone(c));
              res(await ops.setProject(p.id, "flow.classes", fresh), "Built-in class routes reset to the template. Custom classes kept.");
            }} />
          </div>
        </div>
      </Panel>
    </div>
  );
}

export { ClassChip };
