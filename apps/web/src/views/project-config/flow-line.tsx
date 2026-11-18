/**
 * Project config > Flow: two panels, "Stations" and "Gates", one compact aligned row each (the Blueprint prototype's layout), a row
 * opens in place for details (URL state). Hovering a station lights the gates beside it and the other way round.
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
import { Btn, Input, LockNote, Panel, Select, Toggle } from "../../ui/primitives";
import { nextVersion } from "../govern/data";
import { useRes } from "../projects/kit";
import { useQueryParam } from "../projects/urlState";
import type { PcProps } from "./ctx";

/** What each mode value the API takes (human, auto, mixed; "off" is the gate's enabled flag) is called, and what it does. */
export const MODE_TEXT: Record<GateKind | "off", { label: string; help: string }> = {
  human: { label: "Person approves", help: "A person must approve before work moves on." },
  auto: { label: "Automatic check", help: "Passes by itself when its checks pass; nobody signs." },
  mixed: { label: "Mixed", help: "Checks run first, then a person approves." },
  off: { label: "Off", help: "Skipped: new work orders pass straight through." },
};
type Mode = GateKind | "off";
const MODES: GateKind[] = ["human", "auto", "mixed"];

interface StOv { enabled?: boolean; wip?: number }
interface GOv { kind?: GateKind; on?: boolean }

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
  const [openQ, setOpenQ] = useQueryParam("open");
  const [hot, setHot] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const roleName = (id: string): string => cat.roles.find((r) => r.id === id)?.name ?? id;
  const personName = (id: string): string => people.find((x) => x.id === id)?.name ?? id;

  const stCur = (s: Station): { enabled: boolean; wip: number } => { const c = p.flow.stations[s.id] ?? { enabled: false, wip: 5 }; return { enabled: s.id === "intake" ? true : !!c.enabled, wip: c.wip }; };
  const gateMode = (g: Gate): GateKind => (f.gates.find((x) => x.id === g.id)?.mode ?? p.flow.gates[g.id]?.mode ?? g.kind) as GateKind;
  const gCur = (g: Gate): Mode => (p.flow.gates[g.id]?.enabled ? gateMode(g) : "off");
  const stEff = (s: Station) => ({ ...stCur(s), ...stOv[s.id] });
  const gOn = (g: Gate): boolean => gOv[g.id]?.on ?? !!p.flow.gates[g.id]?.enabled;
  const gKind = (g: Gate): GateKind => gOv[g.id]?.kind ?? gateMode(g);
  const gEff = (g: Gate): Mode => (gOn(g) ? gKind(g) : "off");

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
      const o = gEff(g);
      if (o !== gCur(g)) out.push({ key: `g-${g.id}`, what: `${g.label} ${g.name}`, from: MODE_TEXT[gCur(g)].label, to: MODE_TEXT[o].label });
    }
    return out;
  }, [p, cat, stOv, gOv]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = changes.length > 0;
  useLeaveGuard(dirty);

  const discard = () => { setStOv({}); setGOv({}); setReviewing(false); setConflict(false); };

  const save = async () => {
    if (!dirty || saving) return;
    const offs = gates.filter((g) => gEff(g) === "off" && gCur(g) !== "off" && g.id !== "G1f");
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
        const to = gEff(g);
        if (to === gCur(g)) continue;
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
    if (lock.locked) why.push(lock.reason);
    const options = MODES.filter((m) => {
      if (m === gateMode(g) || m === gKind(g)) return true;
      const w = gateModeLock(g, m, p);
      if (w) { why.push(w); return false; }
      return true;
    }).map((m) => ({ value: m, label: MODE_TEXT[m].label }));
    return { options, why: [...new Set(why)] };
  };


  const prevStation = (s: Station): Station | undefined => f.stations[order.indexOf(s.id) - 1];
  const nextStation = (s: Station): Station | undefined => f.stations[order.indexOf(s.id) + 1];
  const stationOf = (g: Gate): Station | undefined => f.stations.find((s) => s.id === g.after);

  const opened = new Set((openQ ?? "").split(",").filter(Boolean));
  const toggleOpen = (key: string) => { const n = new Set(opened); if (n.has(key)) n.delete(key); else n.add(key); setOpenQ(n.size ? [...n].join(",") : null); };
  /** Hovering or focusing a station lights the gates on either side of it, and a gate lights the two stations it sits between. */
  const linked = (key: string): boolean => {
    if (!hot) return false;
    const [kind, id] = [hot.slice(0, 1), hot.slice(2)];
    if (kind === "s" && key.startsWith("g:")) { const g = gates.find((x) => x.id === key.slice(2)); const s = f.stations.find((x) => x.id === id); return !!(g && s && (g.after === s.id || g.after === prevStation(s)?.id)); }
    if (kind === "g" && key.startsWith("s:")) { const g = gates.find((x) => x.id === id); const s = g && stationOf(g); return !!(s && (key.slice(2) === s.id || key.slice(2) === nextStation(s)?.id)); }
    return false;
  };
  const hover = (key: string) => ({ onMouseEnter: () => setHot(key), onMouseLeave: () => setHot(null), onFocus: () => setHot(key), onBlur: () => setHot(null) });
  const cls = (key: string, off: boolean, changed: boolean) => `flw-row${off ? " is-off" : ""}${changed ? " is-changed" : ""}${hot === key ? " is-hot" : ""}${linked(key) ? " is-link" : ""}`;
  const chevron = (key: string, name: string) => (
    <Btn small kind="ghost" icon={opened.has(key) ? "down" : "chevron"} id={`flw-x-${key.replace(":", "-")}`} aria={`${opened.has(key) ? "Hide" : "Show"} details of ${name}`} aria-expanded={opened.has(key)} aria-controls={`flw-d-${key.replace(":", "-")}`} cls="flw-chev" onClick={() => toggleOpen(key)} />
  );

  const stationRow = (s: Station) => {
    const eff = stEff(s);
    const key = `s:${s.id}`;
    const ag = agents.data?.find((a) => a.id === s.agent);
    const agent = ag ? ag.name : s.agent || "No agent";
    const trav = classesAt(cat, order, p.flow.classes, s.id);
    const changed = changes.some((c) => c.key.endsWith(`-${s.id}`) && (c.key.startsWith("wip-") || c.key.startsWith("on-")));
    return (
      <li key={s.id} className={cls(key, !eff.enabled, changed)} id={`flw-st-${s.id}`} {...hover(key)}>
        <div className="flw-line">
          <span className="mono small flw-code">{s.no}</span>
          <span className="flw-name" title={s.name}>{s.name}</span>
          <span className="small muted flw-sub" title={agent}>{agent}</span>
          <span className="flw-ctl">
            <span className="small muted" id={`pcf-wip-l-${s.id}`}>WIP</span>
            <span className="flw-step" role="group" aria-labelledby={`pcf-wip-l-${s.id}`}>
              <Btn small kind="ghost" label="−" aria={`Decrease WIP limit for ${s.name}`} id={`pcf-wip-dn-${s.id}`} disabled={!d.allowed || eff.wip <= 1} onClick={() => setStOv((o) => ({ ...o, [s.id]: { ...o[s.id], wip: Math.max(1, eff.wip - 1) } }))} />
              <Input id={`pcf-wip-${s.id}`} type="number" className="mono pcf-num" min={1} max={30} aria-label={`${s.name} WIP limit`} value={eff.wip} disabled={!d.allowed}
                onChange={(e) => { const v = Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 1)); setStOv((o) => ({ ...o, [s.id]: { ...o[s.id], wip: v } })); }} />
              <Btn small kind="ghost" label="+" aria={`Increase WIP limit for ${s.name}`} id={`pcf-wip-up-${s.id}`} disabled={!d.allowed || eff.wip >= 30} onClick={() => setStOv((o) => ({ ...o, [s.id]: { ...o[s.id], wip: Math.min(30, eff.wip + 1) } }))} />
            </span>
          </span>
          <span className="flw-ctl flw-on">
            {s.id === "intake" ? <span className="small muted">Always on</span> : (
              <><span className="small muted" aria-hidden="true">On</span><Toggle id={`pcf-st-${s.id}`} checked={eff.enabled} decision={d} label={`${s.name} station on`} onChange={(v) => setStOv((o) => ({ ...o, [s.id]: { ...o[s.id], enabled: v } }))} /></>
            )}
          </span>
          {chevron(key, s.name)}
        </div>
        {opened.has(key) ? (
          <div className="flw-more small" id={`flw-d-s-${s.id}`}>
            <div><span className="muted">Agent: </span>{agent}</div>
            <div><span className="muted">Routes: </span>{eff.enabled && trav.length ? trav.map((c) => c.name).join(", ") : eff.enabled ? "no class" : "none while off"}</div>
            <div className="muted">{s.id === "intake" ? "Every work order starts here, so it cannot be turned off." : eff.enabled ? "Turning it off skips this station for new work orders." : "Off: new work orders skip this station."}</div>
          </div>
        ) : null}
      </li>
    );
  };

  const gateRow = (g: Gate) => {
    const mode = gEff(g);
    const on = mode !== "off";
    const kind = gKind(g);
    const key = `g:${g.id}`;
    const s = stationOf(g);
    const next = s ? nextStation(s) : undefined;
    const rule = p.flow.gates[g.id] && (p.approvers[g.id] as ApproverRule | undefined);
    const { options, why } = modeChoices(g);
    const lock = gateLock(g, p);
    const warn = on && kind !== "auto" && rule && g.id !== "G0G1" ? ruleWarning(people.filter((x) => x.status === "active"), p, rule, g.label) : null;
    const who = !on ? MODE_TEXT.off.help
      : kind === "auto" ? "No approvers: passes when its checks pass."
        : g.id === "G0G1" ? approvalText(g, kind, rule, roleName, personName)
          : rule ? `${kind === "mixed" ? "Checks, then. " : ""}${ruleText(rule, roleName, personName)}.` : "No approver rule set: a Factory Admin decides.";
    const short = !on ? "Off" : kind === "auto" ? "No approvers" : rule ? ruleText(rule, roleName, personName) : "Factory Admin";
    const changed = changes.some((c) => c.key === `g-${g.id}`);
    return (
      <li key={g.id} className={cls(key, !on, changed)} id={`flw-g-${g.id}`} {...hover(key)}>
        <div className="flw-line">
          <span className="mono small flw-code" title={g.id === "G0G1" || g.id === "G3G3s" ? "Two checkpoints drawn as one" : undefined}>{g.label}</span>
          <span className="flw-name" title={g.name}>{g.name}</span>
          <span className="small muted mono flw-hint" title={s && next ? `Between ${s.name} and ${next.name}` : s ? `After ${s.name}` : "Not placed on this line"}>{s && next ? `${s.no} → ${next.no}` : s ? `after ${s.no}` : "unplaced"}</span>
          <Select id={`pcf-gmode-${g.id}`} aria-label={`${g.name} mode`} aria-describedby={`flw-mh-${g.id}`} disabled={!d.allowed || !on} options={options} value={kind}
            onChange={(v) => setGOv((o) => ({ ...o, [g.id]: { ...o[g.id], kind: v as GateKind } }))} />
          <span className="small muted flw-sub" id={`flw-mh-${g.id}`} title={short}>{short}</span>
          <span className="flw-ctl flw-on" title={lock.locked ? lock.reason : undefined}>
            <span className="small muted" aria-hidden="true">On</span>
            <Toggle id={`pcf-gate-${g.id}`} checked={on} decision={d} disabled={lock.locked} label={`${g.name} on`} onChange={(v) => setGOv((o) => ({ ...o, [g.id]: { ...o[g.id], on: v } }))} />
          </span>
          {chevron(key, g.name)}
        </div>
        {warn ? <div className="callout callout-warn small flw-warn" role="alert" id={`flw-warn-${g.id}`}>{warn}</div> : null}
        {opened.has(key) ? (
          <div className="flw-more small" id={`flw-d-g-${g.id}`}>
            <div><span className="muted">{s && next ? `Between ${s.no} ${s.name} and ${next.no} ${next.name}.` : s ? `After ${s.no} ${s.name}.` : "Not placed on this line."}</span>{g.custom ? " Custom gate." : ""}</div>
            <div>{MODE_TEXT[on ? kind : "off"].help}{on && kind !== "human" ? ` Checks: ${g.checks.join(", ") || "none listed"}.` : ""}</div>
            <div>{who}{on && kind !== "auto" ? <> <Btn small kind="ghost" id={`pcf-gate-ap-${g.id}`} label="Approvers" aria={`Approvers for ${g.name}`} onClick={() => set({ tab: "approvers", gate: g.id })} /></> : null}</div>
            {why.length ? <div className="muted" id={`pcf-gate-lock-${g.id}`}><span className="sr">Locked: </span>{[...new Set(why)].join(" ")}</div> : null}
            <div className="muted">{on ? "Turning it off skips this gate for new work orders; work already in flight keeps its flow." : "Off: new work orders pass straight through."}</div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="pcf-stack" id="flw">
      <LockNote decision={d} what="Flow settings" />
      <DraftConflictBanner id="flw-conflict" conflict={conflict ? { keys: [] } as never : null} onKeepMine={() => { setConflict(false); void save(); }} onDiscard={discard} />
      <div className="flw-cols">
        <Panel title="Stations" tools={<Btn small kind="ghost" id="flw-more" label="Add or reorder (Flow details)" onClick={() => set({ tab: "flow-advanced" })} />}>
          <ul className="flw-list" aria-label="Stations in order">{f.stations.map(stationRow)}</ul>
        </Panel>
        <Panel title="Gates">
          <ul className="flw-list flw-gates" aria-label="Gates in order">
            {f.stations.flatMap((s) => gatesAfter(s.id).map(gateRow))}
            {orphans.map(gateRow)}
          </ul>
        </Panel>
      </div>
      <div className="flw-bar" role="region" aria-label="Draft changes">
        {dirty ? (
          <>
            <span id="flw-count"><strong>{changes.length}</strong> unsaved change{changes.length === 1 ? "" : "s"}</span>
            <Btn small kind="ghost" id="flw-review" label={reviewing ? "Hide changes" : "Review"} onClick={() => setReviewing((v) => !v)} />
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
