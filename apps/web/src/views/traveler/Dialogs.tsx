/** The work-order dialogs the traveler opens: send back, reassign agent and move to a bay (legacy G.sendBackDialog, G.reassignDialog, G.parkDialog). Reclassify is the class override of work-orders/intake. */
import { useState } from "react";
import { ops } from "../../api/ops";
import { useAgents } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Field, Input, LockNote, Select, TextArea } from "../../ui/primitives";
import { parseLimits, type LimitText } from "../../lib/runLimits";
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
      title="Send back"
      sub="Choose an earlier station. Its agent restarts with your note."
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Sending work back" />
          <Field label="Station" htmlFor="sb-to">
            <Select id="sb-to" options={opts} value={pick} onChange={setTo} />
          </Field>
          <Field label="What to fix (required)" htmlFor="sb-note">
            <textarea id="sb-note" className="input" rows={3} placeholder="What needs to change?" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "sb-submit", guard: d, onClick: () => void submit() }]}
    />
  );
}

/** Redo the station the work order is at: the same send-back route with the current station as the target. The station runs again from a clean attempt and its agent reads the note. */
export function RedoDialog({ woId, onClose }: { woId: string; onClose: () => void }) {
  const ui = useUI();
  const cat = useCatalog();
  const wo = useTravelerWo(woId).data;
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!wo || !cat) return null;
  const sid = cat.stations[wo.station]?.id ?? "";
  const name = stName(cat, sid);
  const d: TDecision = dec(wo, "sendback");
  const submit = async () => {
    if (busy) return;
    if (note.trim().length < 3) {
      setErr("Say what the station should do differently (at least 3 characters).");
      return;
    }
    setBusy(true);
    const r = await ops.sendBack(wo.id, sid, note.trim(), undefined, { ifMatch: wo.version });
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
      title={`Redo ${name}`}
      sub={`${name} runs again from a clean attempt. Its agent reads your note; what it wrote before stays on record.`}
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Redoing a station" />
          <Field label="What should it do differently? (required)" htmlFor="redo-note">
            <TextArea id="redo-note" rows={3} placeholder="What needs to change?" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: `Redo ${name}`, kind: "primary", submit: true, id: "redo-submit", guard: d, onClick: () => void submit() }]}
    />
  );
}

/**
 * Retry with a higher limit: the next attempt (only) runs with the limits given here. The agent and the project keep theirs; the raise is recorded on the attempt and in the
 * audit with the reason. The server decides who may (the right to change limits; a Factory Admin's reason overrides a freeze) and checks the ranges.
 */
export function RetryLimitDialog({ woId, onClose, decision }: { woId: string; onClose: () => void; decision: TDecision }) {
  const ui = useUI();
  const cat = useCatalog();
  const wo = useTravelerWo(woId).data;
  const [t, setT] = useState<LimitText>({ turns: "", minutes: "", costUsd: "" });
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!wo || !cat) return null;
  const stop = wo.limitStop;
  const { value, errors } = parseLimits(t);
  const set = (k: keyof LimitText) => (e: React.ChangeEvent<HTMLInputElement>) => setT((x) => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    if (busy) return;
    if (Object.keys(errors).length) { setErr("Fix the limits marked above."); return; }
    if (!Object.keys(value).length) { setErr("Give at least one higher limit for the next attempt."); return; }
    setBusy(true);
    const r = await ops.retryWithLimits(wo.id, value, reason.trim() || undefined, { ifMatch: wo.version });
    setBusy(false);
    if (!r.ok) { setErr(r.msg); return; }
    ui.toast(r.msg, "ok");
    onClose();
  };
  const at = stop ? `${stName(cat, stop.station)}: ${stop.text}` : wo.stop?.reason ?? "";
  return (
    <Dialog
      title="Retry with a higher limit"
      sub="The next attempt runs with these limits. It does not change the agent or the project."
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={decision} what="Changing a run limit" />
          {at ? <div className="small" id="rl-stopped">{at}</div> : null}
          <Field label="Max turns" htmlFor="rl-turns" error={errors.turns}><Input id="rl-turns" type="number" className="mono" min={1} max={500} placeholder={stop?.limit === "turns" ? `More than ${stop.max}` : "Leave as is"} value={t.turns} onChange={set("turns")} /></Field>
          <Field label="Max time (minutes)" htmlFor="rl-min" error={errors.minutes}><Input id="rl-min" type="number" className="mono" min={1} max={240} placeholder={stop?.limit === "time" ? `More than ${Math.round((stop.max / 60) * 10) / 10}` : "Leave as is"} value={t.minutes} onChange={set("minutes")} /></Field>
          <Field label="Max cost per run" htmlFor="rl-cost" error={errors.costUsd}><Input id="rl-cost" type="number" className="mono" min={0.01} step="0.01" placeholder="Leave as is" value={t.costUsd} onChange={set("costUsd")} /></Field>
          <Field label="Reason (recorded in the audit)" htmlFor="rl-reason"><TextArea id="rl-reason" rows={2} placeholder="Why does this run need more?" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Retry with higher limit", kind: "primary", submit: true, id: "rl-submit", guard: decision, onClick: () => void submit() }]}
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
  const first = opts.find((o) => o.value === "hold" && !o.disabled) ?? opts.find((o) => !o.disabled);
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
      title="Park work order"
      onClose={onClose}
      body={
        <div className="form-grid">
          <LockNote decision={d} what="Moving work to a bay" />
          <Field label="Bay" htmlFor="park-bay" hint={chosen?.disabled ? chosen.why : undefined}>
            <Select id="park-bay" options={opts} value={sel} onChange={setBay} />
          </Field>
          <Field label="Reason (required)" htmlFor="park-reason">
            <textarea id="park-reason" className="input" rows={3} placeholder="Why does it leave the belt?" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Err text={err} />
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "park-submit", guard: d, onClick: () => void submit() }]}
    />
  );
}
