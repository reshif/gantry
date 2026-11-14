/** The work-order dialogs the traveler opens: send back, reassign agent and move to a bay (legacy G.sendBackDialog, G.reassignDialog, G.parkDialog). Reclassify is the class override of work-orders/intake. */
import { useState } from "react";
import { ops } from "../../api/ops";
import { useAgents } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Field, LockNote, Select } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useCatalog } from "../projects/kit";
import { navigate } from "../../lib/router";
import { updatePrefs } from "../../lib/prefs";
import { dec, no, openEntry, stName, useTravelerWo, type TDecision } from "./model";

const Err = ({ text }: { text: string }) => (
  <div className="form-err" role="alert">
    {text}
  </div>
);

export function SendBackDialog({ woId, onClose }: { woId: string; onClose: () => void }) {
  const ui = useUI();
  const cat = useCatalog();
  const wo = useTravelerWo(woId).data;
  const [to, setTo] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!wo || !cat) return null;
  const cur = wo.route.indexOf(cat.stations[wo.station]?.id ?? "");
  const opts = wo.route
    .slice(0, Math.max(0, cur))
    .map((sid) => {
      const m = wo.allowed.moves[sid];
      return { value: sid, label: `${cat.stations.find((s) => s.id === sid)?.no ?? ""} ${stName(cat, sid)}`.trim(), disabled: !!m && !m.allowed, why: m?.reason };
    })
    .reverse();
  const pick = to ?? opts.find((o) => !o.disabled)?.value ?? opts[0]?.value ?? "";
  const d: TDecision = dec(wo, "sendback");
  const submit = async () => {
    if (busy) return;
    if (!pick) {
      setErr(`${wo.id} is at the first station on its route.`);
      return;
    }
    setBusy(true);
    const r = await ops.sendBack(wo.id, pick, note.trim(), undefined, { ifMatch: wo.version });
    setBusy(false);
    if (!r.ok) {
      setErr(r.msg);
      return;
    }
    ui.toast(r.msg, "ok");
    onClose();
  };
  return (
    <Dialog
      title={`Send ${wo.id} back`}
      kicker="Rework"
      sub="The station's agent picks it up again with your note. Gates after that station reset and need approving again."
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Sending work back" />
          <Field label="Back to station" htmlFor="sb-to" hint={`Only earlier stations on the ${cat.classes.find((c) => c.id === wo.cls)?.name ?? wo.cls} route.`}>
            <Select id="sb-to" options={opts} value={pick} onChange={setTo} />
          </Field>
          <Field label="Note for the agent" htmlFor="sb-note">
            <textarea id="sb-note" className="input" rows={3} placeholder="What needs to change?" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Send back", kind: "primary", icon: "undo", submit: true, id: "sb-submit", guard: d, onClick: () => void submit() }]}
    />
  );
}

export function ReassignDialog({ woId, onClose }: { woId: string; onClose: () => void }) {
  const ui = useUI();
  const cat = useCatalog();
  const wo = useTravelerWo(woId).data;
  const roster = useAgents();
  const all = roster.data ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!wo || !cat) return null;
  const st = cat.stations[wo.station];
  const cur = openEntry(wo)?.agent ?? "";
  let agents = all.filter((a) => (a.stations || []).includes(st?.id ?? "") && (a.projects === "all" || (a.projects || []).includes(wo.project)));
  const curAgent = all.find((a) => a.id === cur);
  if (curAgent && !agents.some((a) => a.id === cur)) agents = [curAgent, ...agents];
  const others = agents.filter((a) => a.id !== cur);
  // A different agent is preselected; with none allowed there is nothing to submit, and the dialog says where to allow one.
  const sel = pick ?? others[0]?.id ?? cur;
  const noOthers = !roster.isError && roster.isSuccess && others.length === 0;
  const listed = agents.length ? agents.map((a) => ({ value: a.id, label: `${a.name} ${a.version} · ${a.model}${a.status && a.status !== "active" ? ` (${a.status})` : ""}${a.id === cur ? " (current)" : ""}` })) : cur ? [{ value: cur, label: `${cur} (current)` }] : [];
  const d0 = dec(wo, "reassign");
  const stationName = st?.name ?? "this station";
  const d = noOthers && d0.allowed ? no(`No other agent is allowed to staff ${stationName} in this project.`) : d0;
  const goAgents = (agent?: string) => { onClose(); if (agent) updatePrefs({ agent }); navigate("agents", agent ?? null); };
  const submit = async () => {
    if (busy) return;
    if (sel === cur) {
      setErr("Pick a different agent.");
      return;
    }
    setBusy(true);
    const r = await ops.reassign(wo.id, sel, undefined, { ifMatch: wo.version });
    setBusy(false);
    if (!r.ok) {
      setErr(r.msg);
      return;
    }
    ui.toast(r.msg, "ok");
    onClose();
  };
  return (
    <Dialog
      title={`Reassign ${st?.name ?? "station"} on ${wo.id}`}
      kicker="Staffing"
      sub="Only agents allowed to staff this station in the project are listed. The model follows the agent and the project's routing rules."
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Reassigning agents" />
          <Field label="Agent" htmlFor="ra-agent" hint={roster.isError ? "The agent list could not be loaded." : null}>
            <Select id="ra-agent" options={listed} value={sel} onChange={setPick} />
          </Field>
          {noOthers ? (
            <div className="callout callout-warn small" id="ra-none" role="status">
              <p>{`Nobody else can take ${stationName} here: ${cur ? (curAgent?.name ?? cur) : "the current agent"} is the only agent allowed to staff it in this project, so there is nothing to reassign to.`}</p>
              <p>To allow another agent, open it on the Agents screen and add this station and this project under Stations and Projects.</p>
              <div className="osx-actions">
                {cur ? <button type="button" className="btn btn-sm" id="ra-open-agent" onClick={() => goAgents(cur)}>{`Open ${curAgent?.name ?? "the agent"} on Agents`}</button> : null}
                <button type="button" className="btn btn-sm" id="ra-create-agent" onClick={() => goAgents()}>Create an agent for this station</button>
              </div>
            </div>
          ) : null}
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Reassign", kind: "primary", icon: "swap", submit: true, id: "ra-submit", guard: d, onClick: () => void submit() }]}
    />
  );
}

export function ParkDialog({ woId, onClose }: { woId: string; onClose: () => void }) {
  const ui = useUI();
  const cat = useCatalog();
  const wo = useTravelerWo(woId).data;
  const [bay, setBay] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!wo || !cat) return null;
  const bays = cat.bays.filter((b) => wo.allowed.moves[b.id]);
  const opts = bays.map((b) => {
    const m = wo.allowed.moves[b.id]!;
    return { value: b.id, label: `${b.name}${m.allowed ? "" : " (not available)"}`, disabled: !m.allowed, why: m.reason };
  });
  const first = opts.find((o) => !o.disabled);
  const sel = bay ?? first?.value ?? opts[0]?.value ?? "";
  const chosen = opts.find((o) => o.value === sel);
  const d: TDecision = first ? (wo.stop ? no(`${wo.stop.reason || "Stopped"}`) : dec(wo, "park")) : no(opts[0]?.why ?? "No bay is available for this work order.");
  const submit = async () => {
    if (busy) return;
    if (chosen?.disabled) {
      setErr(chosen.why ?? "That bay is not available.");
      return;
    }
    setBusy(true);
    const r = await ops.park(wo.id, sel, reason, undefined, { ifMatch: wo.version });
    setBusy(false);
    if (!r.ok) {
      setErr(r.msg);
      return;
    }
    ui.toast(r.msg, "ok");
    onClose();
  };
  return (
    <Dialog
      title={`Move ${wo.id} to a bay`}
      kicker="Off the main belt"
      sub={`Work in a bay stops. It returns to ${stName(cat, cat.stations[wo.station]?.id)} when someone releases it.`}
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Moving work to a bay" />
          <Field label="Bay" htmlFor="park-bay" hint={chosen?.disabled ? chosen.why : "Declined needs Decline rights. Queue is only for work about to build."}>
            <Select id="park-bay" options={opts} value={sel} onChange={setBay} />
          </Field>
          <Field label="Reason" htmlFor="park-reason">
            <textarea id="park-reason" className="input" rows={3} placeholder="Why does it leave the belt?" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Move to bay", kind: "primary", icon: "st-park", submit: true, id: "park-submit", guard: d, onClick: () => void submit() }]}
    />
  );
}
