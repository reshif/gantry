/**
 * Project config > Flow as a line editor: stations and gates in flow order, each gate drawn between the two stations it guards.
 * Edits are a draft. "Review changes" lists each before -> after; Save sends the same requests as before (one PATCH per change,
 * each carrying If-Match, the version chained from the previous save). Nothing is written until Save.
 */
import { useMemo, useState } from "react";
import { approvalText, flowOf, gateLock, gateModeLock, ruleText, ruleWarning, type ApproverRule, type Catalog, type Gate, type GateKind, type Station, type WorkClass } from "@gantry/domain";
import { commands as ops } from "../../api/commands";
import { useCan } from "../../api/can";
import { useAgents } from "../../api/queries";
import { useLeaveGuard } from "../../lib/useLeaveGuard";
import { DraftConflictBanner } from "../../ui/DraftConflict";
import { useUI } from "../../ui/overlay-context";
import { Btn, Chip, Field, Input, LockNote, Panel, Select, Toggle } from "../../ui/primitives";
import { nextVersion } from "../govern/data";
import { useRes } from "../projects/kit";
import type { PcProps } from "./ctx";

/** What each mode value the API takes (human, auto, mixed; "off" is the gate's enabled flag) is called, and what it does. */
export const MODE_TEXT: Record<GateKind | "off", { label: string; help: string }> = {
  human: { label: "Person approves", help: "A person must approve before work moves on." },
  auto: { label: "Automatic check", help: "Passes by itself when its checks pass; nobody signs." },
  mixed: { label: "Mixed (check, then person)", help: "Checks run first, then a person approves." },
  off: { label: "Off", help: "Skipped: new work orders pass straight through." },
};
type Mode = GateKind | "off";
const MODES: Mode[] = ["human", "auto", "mixed", "off"];

interface StOv { enabled?: boolean; wip?: number }
interface GOv { mode?: Mode }

/** Work classes that travel through a station (the class's skips and where it ends). */
function classesAt(cat: Catalog, order: string[], classes: WorkClass[], sid: string): WorkClass[] {
  const at = order.indexOf(sid);
  return classes.filter((c) => c.enabled !== false && !c.skips.includes(sid) && (!c.endsAfter || order.indexOf(c.endsAfter) >= at));
}

export function FlowLine({ p, cat, people, set }: PcProps) {
  const ui = useUI();
  const res = useRes();
  const d = useCan("project.config", { project: p.id });
  const agents = useAgents();
  const f = flowOf(cat, p);
  const order = f.stations.map((s) => s.id);
  const [stOv, setStOv] = useState<Record<string, StOv>>({});
  const [gOv, setGOv] = useState<Record<string, GOv>>({});
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const roleName = (id: string): string => cat.roles.find((r) => r.id === id)?.name ?? id;
  const personName = (id: string): string => people.find((x) => x.id === id)?.name ?? id;

  const stCur = (s: Station): { enabled: boolean; wip: number } => { const c = p.flow.stations[s.id] ?? { enabled: false, wip: 5 }; return { enabled: s.id === "intake" ? true : !!c.enabled, wip: c.wip }; };
  const gateMode = (g: Gate): GateKind => (f.gates.find((x) => x.id === g.id)?.mode ?? p.flow.gates[g.id]?.mode ?? g.kind) as GateKind;
  const gCur = (g: Gate): Mode => (p.flow.gates[g.id]?.enabled ? gateMode(g) : "off");
  const stEff = (s: Station) => ({ ...stCur(s), ...stOv[s.id] });
  const gEff = (g: Gate): Mode => gOv[g.id]?.mode ?? gCur(g);

  const gates = cat.gates.filter((g) => p.flow.gates[g.id]);
  const gatesAfter = (sid: string): Gate[] => gates.filter((g) => g.after === sid);
  const orphans = gates.filter((g) => !order.includes(g.after));

  type Change = { key: string; what: string; from: string; to: string };
  const changes = useMemo<Change[]>(() => {
    const out: Change[] = [];
    for (const s of f.stations) {
      const cur = stCur(s);
      const o = stOv[s.id];
      if (o?.wip !== undefined && o.wip !== cur.wip) out.push({ key: `wip-${s.id}`, what: `${s.no} ${s.name} WIP limit`, from: String(cur.wip), to: String(o.wip) });
      if (o?.enabled !== undefined && o.enabled !== cur.enabled) out.push({ key: `on-${s.id}`, what: `${s.no} ${s.name}`, from: cur.enabled ? "on" : "off", to: o.enabled ? "on" : "off" });
    }
    for (const g of gates) {
      const o = gOv[g.id]?.mode;
      if (o !== undefined && o !== gCur(g)) out.push({ key: `g-${g.id}`, what: `${g.label} ${g.name}`, from: MODE_TEXT[gCur(g)].label, to: MODE_TEXT[o].label });
    }
    return out;
  }, [p, cat, stOv, gOv]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = changes.length > 0;
  useLeaveGuard(dirty);

  const discard = () => { setStOv({}); setGOv({}); setReviewing(false); setConflict(false); };

  const save = async () => {
    if (!dirty || saving) return;
    const offs = gates.filter((g) => gOv[g.id]?.mode === "off" && gCur(g) !== "off" && g.id !== "G1f");
    if (offs.length) {
      const ok = await ui.confirm({ title: `Turn off ${offs.map((g) => g.name).join(", ")}?`, kicker: `Flow · ${p.name}`, ok: "Turn off", body: `${offs.map((g) => `${g.name} (${g.label})`).join(", ")} will be skipped for new work orders. Work orders already in flight keep the flow they started with. This needs a recent sign-in and is audited.` });
      if (!ok) return;
    }
    setSaving(true);
    let ver = p.version;
    let failed = false;
    const run = async (r: Promise<{ ok: boolean; msg: string; status?: number }>, label: string): Promise<boolean> => {
      const x = await r;
      if (!x.ok) {
        failed = true;
        if (x.status === 409 || x.status === 412 || x.status === 428) setConflict(true);
        res(x);
        return false;
      }
      ver = nextVersion(x, ver);
      ui.toast(label, "ok");
      return true;
    };
    for (const s of f.stations) {
      const o = stOv[s.id];
      const cur = stCur(s);
      if (o?.wip !== undefined && o.wip !== cur.wip && !(await run(ops.setProject(p.id, `flow.stations.${s.id}.wip`, o.wip, { ifMatch: ver }), `${s.name} WIP limit set to ${o.wip}.`))) break;
      if (o?.enabled !== undefined && o.enabled !== cur.enabled && !(await run(ops.setProject(p.id, `flow.stations.${s.id}.enabled`, o.enabled, { ifMatch: ver }), `${s.name}${o.enabled ? " turned on." : " turned off."}`))) break;
    }
    if (!failed) {
      for (const g of gates) {
        const to = gOv[g.id]?.mode;
        if (to === undefined || to === gCur(g)) continue;
        if (to === "off") { if (!(await run(ops.setProject(p.id, `flow.gates.${g.id}.enabled`, false, { ifMatch: ver }), `${g.name} turned off.`))) break; continue; }
        if (gCur(g) === "off" && !(await run(ops.setProject(p.id, `flow.gates.${g.id}.enabled`, true, { ifMatch: ver }), `${g.name} turned on.`))) break;
        if (to !== gateMode(g) && !(await run(ops.setGateMode(p.id, g.id, to, { ifMatch: ver }), `${g.label} set to ${MODE_TEXT[to].label}.`))) break;
      }
    }
    setSaving(false);
    if (!failed) { discard(); }
  };

  const modeChoices = (g: Gate): { options: Array<{ value: string; label: string }>; why: string[] } => {
    const lock = gateLock(g, p);
    const why: string[] = [];
    const options = MODES.filter((m) => {
      if (m === gCur(g) || m === gEff(g)) return true;
      if (m === "off") { if (lock.locked) { why.push(lock.reason); return false; } return true; }
      const w = gateModeLock(g, m, p);
      if (w) { why.push(w); return false; }
      return true;
    }).map((m) => ({ value: m, label: MODE_TEXT[m].label }));
    return { options, why: [...new Set(why)] };
  };

  const nextStation = (s: Station): Station | undefined => f.stations[order.indexOf(s.id) + 1];

  const stationCard = (s: Station) => {
    const eff = stEff(s);
    const ag = agents.data?.find((a) => a.id === s.agent);
    const trav = classesAt(cat, order, p.flow.classes, s.id);
    const changed = stOv[s.id] !== undefined && changes.some((c) => c.key.endsWith(`-${s.id}`));
    return (
      <li key={s.id} className={`flw-card flw-station${eff.enabled ? "" : " is-off"}${changed ? " is-changed" : ""}`} id={`flw-st-${s.id}`}>
        <div className="flw-head"><span className="flw-name">{s.name}</span><span className="mono small flw-code">{s.no}</span></div>
        <div className="small muted">{ag ? `Agent: ${ag.name}` : s.agent ? `Agent: ${s.agent}` : "No agent"}</div>
        <div className="flw-ctl">
          <span className="small" id={`pcf-wip-l-${s.id}`}>WIP limit</span>
          <span className="flw-step" role="group" aria-labelledby={`pcf-wip-l-${s.id}`}>
            <Btn small kind="ghost" label="−" aria={`Decrease WIP limit for ${s.name}`} id={`pcf-wip-dn-${s.id}`} disabled={!d.allowed || eff.wip <= 1} onClick={() => setStOv((o) => ({ ...o, [s.id]: { ...o[s.id], wip: Math.max(1, eff.wip - 1) } }))} />
            <Input id={`pcf-wip-${s.id}`} type="number" className="mono pcf-num" min={1} max={30} aria-label={`${s.name} WIP limit`} value={eff.wip} disabled={!d.allowed}
              onChange={(e) => { const v = Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 1)); setStOv((o) => ({ ...o, [s.id]: { ...o[s.id], wip: v } })); }} />
            <Btn small kind="ghost" label="+" aria={`Increase WIP limit for ${s.name}`} id={`pcf-wip-up-${s.id}`} disabled={!d.allowed || eff.wip >= 30} onClick={() => setStOv((o) => ({ ...o, [s.id]: { ...o[s.id], wip: Math.min(30, eff.wip + 1) } }))} />
          </span>
        </div>
        <div className="flw-ctl">
          <span className="small" id={`pcf-st-l-${s.id}`}>Station on</span>
          {s.id === "intake" ? <Chip text="always on" cls="plain" /> : (
            <Toggle id={`pcf-st-${s.id}`} checked={eff.enabled} decision={d} label={`${s.name} station on`} onChange={(v) => setStOv((o) => ({ ...o, [s.id]: { ...o[s.id], enabled: v } }))} />
          )}
        </div>
        <div className="small muted">{s.id === "intake" ? "Every work order starts here, so it cannot be turned off." : eff.enabled ? "Off would skip this station for new work orders." : "Off: new work orders skip this station."}</div>
        <div className="flw-classes small" aria-label={`Work classes through ${s.name}`}>
          <span className="muted">Routes: </span>
          {eff.enabled && trav.length ? trav.map((c) => <Chip key={c.id} text={c.name} cls="plain" />) : <span className="muted">{eff.enabled ? "no class" : "none while off"}</span>}
        </div>
      </li>
    );
  };

  const gateCard = (g: Gate, s?: Station) => {
    const mode = gEff(g);
    const kind: GateKind = mode === "off" ? gateMode(g) : mode;
    const rule = p.flow.gates[g.id] && (p.approvers[g.id] as ApproverRule | undefined);
    const { options, why } = modeChoices(g);
    const lock = gateLock(g, p);
    const next = s ? nextStation(s) : undefined;
    const warn = mode !== "auto" && mode !== "off" && rule && g.id !== "G0G1" ? ruleWarning(people.filter((x) => x.status === "active"), p, rule, g.label) : null;
    const who = mode === "off" ? MODE_TEXT.off.help
      : mode === "auto" ? "No approvers: passes when its checks pass."
        : g.id === "G0G1" ? approvalText(g, mode, rule, roleName, personName)
          : rule ? `${mode === "mixed" ? "Checks, then. " : ""}${ruleText(rule, roleName, personName)}.` : "No approver rule set: a Factory Admin decides.";
    const changed = gOv[g.id]?.mode !== undefined && gOv[g.id]?.mode !== gCur(g);
    return (
      <li key={g.id} className={`flw-card flw-gate${mode === "off" ? " is-off" : ""}${changed ? " is-changed" : ""}`} id={`flw-g-${g.id}`}>
        <div className="flw-head"><span className="flw-diamond" aria-hidden="true" /><span className="flw-name">{g.name}</span><span className="mono small flw-code" title={g.id === "G0G1" || g.id === "G3G3s" ? "Two checkpoints drawn as one" : undefined}>{g.label}</span>{g.custom ? <Chip text="custom" cls="plain" /> : null}</div>
        <div className="small muted">{s && next ? `Between ${s.no} ${s.name} and ${next.no} ${next.name}` : s ? `After ${s.no} ${s.name}` : "Not placed on this line"}</div>
        <Field label="Mode" htmlFor={`pcf-gmode-${g.id}`}>
          <Select id={`pcf-gmode-${g.id}`} aria-label={`${g.name} mode`} aria-describedby={`flw-mh-${g.id}`} disabled={!d.allowed} options={options} value={mode}
            onChange={(v) => setGOv((o) => ({ ...o, [g.id]: { mode: v as Mode } }))} />
        </Field>
        <div className="small muted" id={`flw-mh-${g.id}`}>{MODE_TEXT[mode].help}{mode === "mixed" || mode === "auto" ? ` Checks: ${g.checks.join(", ") || "none listed"}.` : ""}</div>
        {why.length ? <div className="small muted" id={`pcf-gate-lock-${g.id}`}><span className="sr">Locked: </span>{why.join(" ")}</div> : lock.locked ? <div className="small muted" id={`pcf-gate-lock-${g.id}`}>{lock.reason}</div> : null}
        <div className="small flw-who">{who}{kind !== "auto" && mode !== "off" ? <> <Btn small kind="ghost" id={`pcf-gate-ap-${g.id}`} label="Approvers" aria={`Approvers for ${g.name}`} onClick={() => set({ tab: "approvers", gate: g.id })} /></> : null}</div>
        {warn ? <div className="callout callout-warn small" role="alert" id={`flw-warn-${g.id}`}>{warn}</div> : null}
      </li>
    );
  };

  return (
    <div className="pcf-stack" id="flw">
      <LockNote decision={d} what="Flow settings" />
      <DraftConflictBanner id="flw-conflict" conflict={conflict ? { keys: [] } as never : null} onKeepMine={() => { setConflict(false); void save(); }} onDiscard={discard} />
      <Panel title="Line: stations and the gates between them" tools={<Btn small kind="ghost" id="flw-more" label="Add or reorder (Flow details)" onClick={() => set({ tab: "flow-advanced" })} />}>
        <p className="small muted flw-legend">Work moves left to right. A square card is a station; a diamond card is a gate between two stations. Changes stay a draft until you save.</p>
        <ol className="flw-line" aria-label="Flow in order">
          {f.stations.flatMap((s) => [stationCard(s), ...gatesAfter(s.id).map((g) => gateCard(g, s))])}
          {orphans.map((g) => gateCard(g))}
        </ol>
      </Panel>
      <div className="flw-bar" role="region" aria-label="Draft changes">
        {dirty ? (
          <>
            <span id="flw-count"><strong>{changes.length}</strong> unsaved change{changes.length === 1 ? "" : "s"}</span>
            <Btn small kind="ghost" id="flw-review" label={reviewing ? "Hide changes" : "Review changes"} onClick={() => setReviewing((v) => !v)} />
            <Btn small kind="ghost" id="flw-discard" label="Discard" onClick={discard} />
            <Btn kind="primary" id="flw-save" label={saving ? "Saving" : "Save"} guard={d} disabledReason={saving ? "Saving" : null} onClick={() => void save()} />
          </>
        ) : <span className="muted small" id="flw-count">No unsaved changes.</span>}
      </div>
      {dirty && reviewing ? (
        <Panel title="Review changes">
          <ul className="plain-list flw-review" id="flw-changes">
            {changes.map((c) => <li key={c.key}><strong>{c.what}</strong>: <span className="muted">{c.from}</span> → <span>{c.to}</span></li>)}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
