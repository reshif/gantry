/**
 * Project config > Flow > "Advanced: structure": add a station, gate or bay, move stations, remove a custom one, and the coding slots.
 * Structure changes are their own requests (each carries If-Match); the coding slots join the Flow draft with the WIP limits and gate modes.
 */
import { useState } from "react";
import { flowOf, type Catalog, type Project } from "@gantry/domain";
import { commands as ops } from "../../api/commands";
import { useCan } from "../../api/can";
import { useAgents } from "../../api/queries";
import { DataTable, type Col } from "../../ui/DataTable";
import { Dialog } from "../../ui/Overlay";
import { Btn, Empty, Field, Input, LockNote, Select, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { NumInput, focusLater, metricsOf, projectRoles, useRes, type PView } from "../projects/kit";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
void clone;
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
              <Field label="Station name" htmlFor="pcf-ns-name"><Input id="pcf-ns-name" value={dr.name} placeholder="Load test" autoComplete="off" onChange={(e) => upd({ name: e.target.value })} /></Field>
              <Field label="WIP limit" htmlFor="pcf-ns-wip"><Input id="pcf-ns-wip" type="number" min={1} max={30} className="mono pcf-num" value={String(dr.wip)} onChange={(e) => upd({ wip: parseInt(e.target.value, 10) || 5 })} /></Field>
            </div>
            <div className="form-row">
              <Field label="Staffing agent" htmlFor="pcf-ns-agent"><Select id="pcf-ns-agent" options={agents.map((a) => ({ value: a.id, label: `${a.name} · ${cat.stations.find((s) => s.id === a.station)?.name ?? a.station ?? "no station"}` }))} value={agent} onChange={(v) => upd({ agent: v })} /></Field>
              <Field label="Position" htmlFor="pcf-ns-after" hint="Close always stays last."><Select id="pcf-ns-after" options={order.map((s) => ({ value: s.id, label: `After ${s.no} ${s.name}` }))} value={dr.after} onChange={(v) => upd({ after: v })} /></Field>
            </div>
            <Field label="Purpose" htmlFor="pcf-ns-purpose"><Input id="pcf-ns-purpose" value={dr.purpose} placeholder="What the agent checks or produces here" onChange={(e) => upd({ purpose: e.target.value })} /></Field>
            <label className="check" htmlFor="pcf-ns-gate">
              <input type="checkbox" id="pcf-ns-gate" checked={dr.gate} onChange={(e) => { upd({ gate: e.target.checked }); focusLater("pcf-ns-gate"); }} />
              Add a gate after this station
            </label>
            {dr.gate ? (
              <div className="pcf-fs">
                <div className="form-row">
                  <Field label="Gate name" htmlFor="pcf-ns-gname"><Input id="pcf-ns-gname" value={dr.gName} placeholder="Load test sign-off" onChange={(e) => upd({ gName: e.target.value })} /></Field>
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
                  <Field label="Gate name" htmlFor="pcf-ng-name"><Input id="pcf-ng-name" value={dr.name} placeholder="Load test sign-off" autoComplete="off" onChange={(e) => upd({ name: e.target.value })} /></Field>
                  <Field label="Short label" htmlFor="pcf-ng-label" hint="Shown in the diamond. Letters and digits."><Input id="pcf-ng-label" className="mono" value={dr.label} maxLength={5} placeholder="GL" onChange={(e) => upd({ label: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} /></Field>
                </div>
                <div className="form-row">
                  <Field label="After station" htmlFor="pcf-ng-after" hint="Only stations without a gate are listed."><Select id="pcf-ng-after" options={free.map((s) => ({ value: s.id, label: `${s.no} ${s.name}` }))} value={dr.after} onChange={(v) => upd({ after: v })} /></Field>
                  <Field label="Kind" htmlFor="pcf-ng-kind"><Select id="pcf-ng-kind" options={KINDS} value={dr.kind} onChange={(v) => upd({ kind: v })} /></Field>
                </div>
                {dr.kind !== "auto" ? (
                  <div className="form-row">
                    <Field label="Approver roles"><RolePicker cat={cat} idp="pcf-ng-r" sel={dr.roles} onChange={(ids) => upd({ roles: ids })} /></Field>
                    <Field label="Approvals needed" htmlFor="pcf-ng-req"><Input id="pcf-ng-req" type="number" min={1} max={5} className="mono pcf-num" value={String(dr.required)} onChange={(e) => upd({ required: parseInt(e.target.value, 10) || 1 })} /></Field>
                  </div>
                ) : null}
                <Field label="Purpose" htmlFor="pcf-ng-purpose"><Input id="pcf-ng-purpose" value={dr.purpose} placeholder="What has to be true to pass" onChange={(e) => upd({ purpose: e.target.value })} /></Field>
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
          <Field label="Bay name" htmlFor="pcf-nb-name"><Input id="pcf-nb-name" value={name} placeholder="Vendor review" autoComplete="off" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="What waits here" htmlFor="pcf-nb-desc"><Input id="pcf-nb-desc" value={desc} placeholder="Waiting for a reply from the vendor" onChange={(e) => setDesc(e.target.value)} /></Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
    />
  );
}


type StationRow = ReturnType<typeof flowOf>["stations"][number];

export function FlowStructure({ p, cat, slots, setSlots }: { p: PView; cat: Catalog; slots: number; setSlots: (v: number) => void }) {
  const ui = useUI();
  const res = useRes();
  const d = useCan("project.config", { project: p.id });
  const fd = useCan("flow.edit", { project: p.id });
  const agents = useAgents().data ?? [];
  const f = flowOf(cat, p);
  const m = metricsOf(p);
  const n = f.stations.length;
  const idx = (s: StationRow): number => f.stations.findIndex((x) => x.id === s.id);
  const cols: Array<Col<StationRow>> = [
    { key: "no", label: "No", render: (s) => <span className="mono">{s.no}</span> },
    { key: "name", label: "Station", render: (s) => <div>{s.name}{s.custom ? <span className="tag pcf-tag-custom">custom</span> : null}<div className="muted small">{agents.find((a) => a.id === s.agent)?.name ?? s.agent}</div></div> },
    { key: "wip", label: "WIP now", align: "end", render: (s) => { const here = m.byPosition[s.id]?.n ?? 0; const cap = p.flow.stations[s.id]?.wip ?? 0; return <span className={`mono${here > cap ? " neg" : ""}`}>{here + (here > cap ? " over" : "")}</span>; } },
    { key: "slots", label: "Coding slots", render: (s) => (s.id === "build" ? (
      <div className="pcf-slots">
        <NumInput id="pcf-slots" value={slots} min={1} max={8} locked={!d.allowed} label="Coding slots" onCommit={setSlots} />
        <span className="small muted">{`${m.slotsUsed} in use`}</span>
      </div>
    ) : null) },
    { key: "order", label: "Order", render: (s) => {
      const here = m.byPosition[s.id]?.n ?? 0;
      const fixed = s.id === "intake" || s.id === "close";
      if (fixed) return <span className="muted small pcf-fixed" data-tip={s.id === "intake" ? "Intake stays first." : "Close stays last."} tabIndex={0}><Icon name="lock" />{s.id === "intake" ? " first" : " last"}</span>;
      const i = idx(s);
      const upWhy = i <= 1 ? "Intake stays first." : null;
      const downWhy = i >= n - 2 ? "Close stays last." : null;
      return (
        <div className="row">
          <Btn small kind="ghost" icon="up" id={`pcf-mv-up-${s.id}`} aria={`Move ${s.name} earlier`} guard={fd} disabledReason={fd.allowed ? upWhy : null} onClick={async () => { res(await ops.moveStation(p.id, s.id, -1, { ifMatch: p.version })); focusLater(`pcf-mv-up-${s.id}`); }} />
          <Btn small kind="ghost" icon="down" id={`pcf-mv-dn-${s.id}`} aria={`Move ${s.name} later`} guard={fd} disabledReason={fd.allowed ? downWhy : null} onClick={async () => { res(await ops.moveStation(p.id, s.id, 1, { ifMatch: p.version })); focusLater(`pcf-mv-dn-${s.id}`); }} />
          {s.custom ? (
            <Btn small kind="ghost" icon="x" id={`pcf-st-rm-${s.id}`} aria={`Remove ${s.name}`} label="Remove" guard={fd} disabledReason={fd.allowed && here ? `${here} work order${here > 1 ? "s are" : " is"} at ${s.name}. Move them first.` : null}
              onClick={() => ui.typedConfirm({ title: `Remove ${s.name}`, kicker: `Flow · ${p.name}`, sub: "Its gate goes too. Routes skip it from now on. History keeps the station's past entries.", phrase: s.name, okLabel: "Remove station", guard: fd, onOk: async () => { const r = await ops.removeStation(p.id, s.id, { ifMatch: p.version }); ui.toast(r.msg, r.ok ? "ok" : "error"); return r.ok ? undefined : { ok: false, msg: r.msg }; } })} />
          ) : null}
        </div>
      );
    } },
  ];
  return (
    <div className="stack" id="flw-structure">
      <LockNote decision={fd} what="Adding and moving stations, gates and bays" />
      <div className="row">
        <Btn small icon="plus" id="pcf-add-station" guard={fd} label="Add station" onClick={() => ui.open((close) => <StationDialog p={p} cat={cat} close={close} />)} />
        <Btn small icon="plus" id="pcf-add-gate" guard={fd} label="Add gate" onClick={() => ui.open((close) => <GateDialog p={p} cat={cat} close={close} />)} />
        <Btn small icon="plus" id="pcf-add-bay" guard={fd} label="Add bay" onClick={() => ui.open((close) => <BayDialog p={p} close={close} />)} />
      </div>
      <DataTable id="pcf-st-table" caption="Stations: order, coding slots and removal" columns={cols} rows={f.stations} rowKey={(s) => s.id} />
      <div>
        <div className="small strong">Bays off the main belt</div>
        {f.bays.length ? (
          <ul className="plain-list pcf-bays">
            {f.bays.map((b) => (
              <li key={b.id} className={`pcf-bay${b.custom ? " is-custom" : ""}`}>
                <span className="pcf-bay-n">{b.name}{b.custom ? <span className="tag pcf-tag-custom">custom</span> : null}</span>
                <span className="muted small">{b.desc || ""}</span>
                <span className="mono small">{`${m.byPosition[b.id]?.n ?? 0} parked`}</span>
              </li>
            ))}
          </ul>
        ) : <Empty title="No bays" text="Bays sit off the main belt. Work orders can be parked there and returned." />}
      </div>
    </div>
  );
}
