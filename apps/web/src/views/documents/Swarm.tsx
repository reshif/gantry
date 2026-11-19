/**
 * Phase 3 in the workspace: the scouts a station sent (a board with each scout's question, focus, state, turn and cost, and a Stop button), the
 * objections one agent raised about another's document (a person decides: it stands or the author is right), and the notes an approver sees
 * before a gate: assumptions nobody confirmed and objections nobody decided. Nothing here blocks a gate; it is shown and recorded.
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Chip, Who, TextArea } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { decideObjection, stopScout, type Assumption, type Objection, type SwarmView } from "./api";

const station = (s: string | null) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : "another station");
const STATE: Record<string, string> = { queued: "Waiting to start", running: "Working", done: "Delivered", failed: "Failed", stopped: "Stopped" };

export function SwarmBoard({ woId, sw, canStop, stopWhy }: { woId: string; sw: SwarmView; canStop: boolean; stopWhy?: string | undefined }) {
  const ui = useUI();
  const live = sw.scouts.filter((x) => x.state === "queued" || x.state === "running").length;
  const cost = sw.scouts.reduce((t, x) => t + x.costUsd, 0);
  const stop = async (id: string) => {
    const ok = await ui.confirm({ title: `Stop scout ${id}?`, kicker: woId, ok: "Stop scout", body: <p>The scout stops at its next model call. The station goes on with what the other scouts deliver.</p> });
    if (!ok) return;
    const r = await stopScout(woId, id, "Stopped from the scouts board.");
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  return (
    <article className={`osx-card sw-card${live ? " is-live" : ""}`} id="sw-board" aria-label="Scouts">
      <header className="osx-card-h">
        <strong>{`Scouts from ${station(sw.station)}`}</strong>
        <span className="osx-status">{live ? `${live} working` : sw.endedAt ? "All ended" : "Starting"}</span>
      </header>
      <p className="small muted sw-meta">{`${sw.scouts.length} scout${sw.scouts.length === 1 ? "" : "s"} · ${fmt.money(cost)} so far · started ${fmt.stamp(sw.startedAt)}. When all have ended, ${station(sw.station)} brings their findings together.`}</p>
      <ul className="sw-list">
        {sw.scouts.map((x) => (
          <li key={x.id} className={`sw-row is-${x.state}`} id={`sw-${x.id}`}>
            <span className="sw-id mono" aria-hidden="true">{x.id}</span>
            <div className="sw-main">
              <span className="sw-q">{x.question}</span>
              <span className="small muted">{`${x.focus === "web" ? "Web" : "Repository"} · ${STATE[x.state] ?? x.state}${x.state === "running" && x.turn ? ` · turn ${x.turn}` : ""} · ${fmt.money(x.costUsd)}`}</span>
              {x.summary ? <span className="small sw-sum">{x.summary}</span> : null}
            </div>
            {x.state === "queued" || x.state === "running" ? <Btn small kind="ghost" icon="x" id={`sw-stop-${x.id}`} label="Stop" disabled={!canStop} disabledReason={!canStop ? stopWhy || "You may not stop work on this work order." : undefined} onClick={() => void stop(x.id)} /> : <span />}
          </li>
        ))}
      </ul>
    </article>
  );
}

export function ObjectionCard({ woId, o, canDecide }: { woId: string; o: Objection; canDecide: boolean }) {
  const ui = useUI();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const open = o.status === "open";
  const run = async (decision: "upheld" | "overruled") => {
    setBusy(true);
    const r = await decideObjection(woId, o.id, { decision, note: note.trim() });
    setBusy(false);
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  const fid = `ob-${o.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return (
    <article className={`osx-card ob-card is-${o.status} sev-${o.severity}`} id={fid} aria-label={`Objection to ${o.targetDoc}`}>
      <header className="osx-card-h">
        <strong>{`${station(o.station)} objects to ${o.targetDoc}${o.section ? ` · ${o.section}` : ""}`}</strong>
        <Chip text={`${o.severity} impact`} cls={o.severity === "high" ? "chip-warn" : ""} />
        <span className="osx-status">{open ? "Needs a decision" : o.status === "upheld" ? "Upheld" : "Overruled"}</span>
      </header>
      {o.claim ? <p className="small ob-claim"><span className="muted">The document says: </span>{o.claim}</p> : null}
      <p className="small ob-reason"><span className="muted">Why it is wrong: </span>{o.reason}</p>
      {open ? (
        canDecide ? (
          <div className="osx-ask">
            <label className="small" htmlFor={`${fid}-note`}>Your reason (both agents work from it)</label>
            <TextArea id={`${fid}-note`} className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="osx-actions">
              <Btn small kind="primary" id={`${fid}-up`} label="The objection stands" disabled={busy || note.trim().length < 3} disabledReason={note.trim().length < 3 ? "Give your reason." : undefined} onClick={() => void run("upheld")} />
              <Btn small id={`${fid}-over`} label={`${station(o.targetStation)} is right`} disabled={busy || note.trim().length < 3} disabledReason={note.trim().length < 3 ? "Give your reason." : undefined} onClick={() => void run("overruled")} />
            </div>
            <p className="small muted">Upholding records the decision; to have the work redone, send the work order back to {station(o.targetStation)}.</p>
          </div>
        ) : <p className="small muted">Someone who may approve gates on this project decides.</p>
      ) : (
        <p className="small ob-decided">{o.status === "upheld" ? "Upheld" : "Overruled"}<span className="muted">{" — "}</span><Who id={o.decidedBy} />{o.decidedAt ? <span className="muted">{`, ${fmt.stamp(o.decidedAt)}`}</span> : null}{o.note ? <span>{`: ${o.note}`}</span> : null}</p>
      )}
    </article>
  );
}

/** Before an approver decides a gate: what is still open. Shown, not enforced; the gate decision records the counts. */
export function GateNotes({ assumptions, objections, jump }: { assumptions: Assumption[]; objections: Objection[]; jump: (id: string) => void }) {
  const a = assumptions.filter((x) => x.status === "open");
  const o = objections.filter((x) => x.status === "open");
  if (!a.length && !o.length) return null;
  return (
    <div className="callout callout-warn small gate-notes" id="gate-notes" role="note">
      <strong>Before you approve</strong>
      <ul>
        {o.length ? <li><button type="button" className="linkish" onClick={() => jump(`ob-${o[0]!.id.replace(/[^A-Za-z0-9_-]/g, "-")}`)}>{`${o.length} objection${o.length === 1 ? "" : "s"} not decided`}</button></li> : null}
        {a.length ? <li><button type="button" className="linkish" onClick={() => jump(`as-${a[0]!.id.replace(/[^A-Za-z0-9_-]/g, "-")}`)}>{`${a.length} assumption${a.length === 1 ? "" : "s"} not confirmed${a.some((x) => x.impact === "high") ? " (some high impact)" : ""}`}</button></li> : null}
      </ul>
      <span className="muted">Your decision records what was still open.</span>
    </div>
  );
}
