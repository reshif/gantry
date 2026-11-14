/**
 * Floor (#floor): the live plant for the current project. Ported from legacy/js/views/floor.js.
 * Three views: Belt (serpentine conveyor with gates, bays and a shipped strip), Board (kanban with pointer drag and a
 * keyboard "Move to" menu) and List (sortable table). The header carries the project figures, new work order, the andon and
 * the project kill switch. Replay rebuilds the floor from the event log at a chosen past time (read-only). All data comes
 * from GET /projects/{id}/floor; every control is a command through the API.
 */
import { useEffect, useRef, useState } from "react";
import { DAY, MIN, fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useMe } from "../api/queries";
import { Btn, Empty, Segmented, ViewHead, type Decision } from "../ui/primitives";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { pickProject } from "../lib/routes";
import { setReplay, updatePrefs, usePrefs } from "../lib/prefs";
import { makeStopActions } from "../shell/stopActions";
import { Belt } from "./floor/Belt";
import { Board, ListView } from "./floor/Board";
import { useDrawers } from "./floor/Drawers";
import { FloorCtx, isLive, replayRange, since, useFloorCtx, useFloorState, type FloorCtxValue } from "./floor/kit";
import { ReplayBar } from "./floor/Replay";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";

const REPLAY_LOCK: Decision = { allowed: false, reason: "Replay is showing the past. Go back to live to act.", needs: "" };

function useTick(ms: number): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function Kpis() {
  const ctx = useFloorCtx();
  const { project: p, wos, now } = ctx;
  const live = wos.filter((w) => isLive(w) && w.bay !== "declined");
  const waiting = live.filter((w) => w.state === "waiting" && !w.bay);
  const oldest = waiting.reduce((m, w) => Math.max(m, now - since(w)), 0);
  const shipped7 = wos.filter((w) => w.state === "done" && !w.split && (w.doneAt ?? 0) > now - 7 * DAY).length;
  const shipped24 = wos.filter((w) => w.state === "done" && !w.split && (w.doneAt ?? 0) > now - DAY).length;
  const stuck = live.filter((w) => w.state === "blocked" || w.state === "failed" || w.bay === "sechold" || w.bay === "person").length;
  const slots = ctx.replay ? wos.filter((w) => !w.bay && w.state === "running" && ctx.cat.stations[w.station]?.id === "build").slice(0, p.flow.slots).length : ctx.floor.slots.used;
  const spendPct = p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0;
  const killed = wos.filter((w) => w.state === "killed").length;
  const items: Array<{ k: string; v: string; sub: string; tone?: string }> = [
    { k: "Work in flight", v: String(live.length), sub: `${live.filter((w) => w.state === "running").length} running now` },
    { k: "Gates waiting", v: String(waiting.length), sub: waiting.length ? `oldest ${fmt.dur(oldest)}` : "none waiting", tone: waiting.length ? "wait" : "" },
    { k: "Stuck", v: String(stuck), sub: "blocked, failed, held, asking", tone: stuck ? "block" : "" },
    { k: "Coding slots", v: `${slots}/${p.flow.slots}`, sub: slots >= p.flow.slots ? "all busy" : `${p.flow.slots - slots} free` },
    { k: "Shipped", v: String(shipped7), sub: `${shipped24} in 24h, 7 days total` },
    { k: "Spend MTD", v: fmt.money0(p.budget.mtd), sub: ctx.replay ? "live figure, not replayed" : `${fmt.pct(spendPct)} of ${fmt.money0(p.budget.monthly)}`, tone: spendPct >= p.budget.alertAt ? "wait" : "" },
  ];
  if (killed) items.push({ k: "Killed", v: String(killed), sub: "work orders stopped", tone: "kill" });
  return (
    <div className="fl-kpis" role="list" aria-label="Project figures">
      {items.map((x) => (
        <div key={x.k} className={`fl-kpi${x.tone ? ` tone-${x.tone}` : ""}`} role="listitem">
          <div className="fl-kpi-k">{x.k}</div>
          <div className="fl-kpi-v">{x.v}</div>
          <div className="fl-kpi-sub">{x.sub}</div>
        </div>
      ))}
    </div>
  );
}

function Header() {
  const ctx = useFloorCtx();
  const ui = useUI();
  const me = useMe();
  const p = ctx.project;
  const newWo = useNewWorkOrder();
  const dSubmit = useCan("wo.submit", { project: p.id });
  const dHalt = useCan("line.halt", { project: p.id });
  const dResume = useCan("line.resume", { project: p.id });
  const dKill = useCan("kill.project", { project: p.id });
  const dRestore = useCan("restore.project", { project: p.id });
  if (!me) return null;
  const stop = makeStopActions(ui, me);
  const lockIf = (d: Decision | null): Decision | null => (ctx.replay ? REPLAY_LOCK : d);
  const block = projectSubmitBlock(me, p, ctx.repos);
  const newGuard = lockIf(!dSubmit.allowed && !dSubmit.pending ? dSubmit : block ? { allowed: false, reason: block, needs: "" } : null);
  const factoryKilled = !!me.factory.killed;
  const killBtn = p.killed ? (
    <Btn label="Restore project" icon="power" id="floor-restore" guard={lockIf(dRestore.pending ? null : dRestore)} onClick={() => stop.restore("project", p.id)} />
  ) : (
    <Btn label="Kill project" kind="danger" icon="st-kill" id="floor-kill" guard={lockIf(factoryKilled ? { allowed: false, reason: "The whole factory is killed; restore it from Home.", needs: "" } : dKill.pending ? null : dKill)} onClick={() => stop.kill("project", p.id)} />
  );
  const andonMenu = (anchor: HTMLElement) => {
    const items = [
      p.halted
        ? { label: `Resume ${p.name}`, icon: "play", hint: "whole project", guard: dResume.pending ? null : dResume, onClick: () => void stop.resume(p.id) }
        : { label: `Halt ${p.name}`, icon: "halt", hint: "whole project", guard: dHalt.pending ? null : dHalt, onClick: () => stop.halt(p.id) },
      { sep: true },
      ...ctx.repos.map((r) =>
        r.halted
          ? { label: `Resume ${r.name}`, icon: "play", hint: "halted", guard: dResume.pending ? null : dResume, onClick: () => void stop.resumeRepo(r.id) }
          : { label: `Halt ${r.name}`, icon: "halt", hint: "repo", guard: dHalt.pending ? null : dHalt, onClick: () => stop.haltRepo(r.id, p.id) },
      ),
    ];
    ui.menu(anchor, "Andon: pull the cord", items);
  };
  return (
    <>
      <div id="floor-head">
        <ViewHead
          kicker={`Project · Floor · ${p.key}`}
          title={
            <>
              {p.name}
              {ctx.replay ? (
                <span className="vtitle-badge">
                  <span className="chip fl-rp-chip">
                    <Icon name="replay" />
                    Replay · not live
                  </span>
                </span>
              ) : null}
            </>
          }
          sub={p.desc}
          actions={
            <>
              <Btn label="New work order" kind="primary" icon="plus" id="floor-new-wo" guard={newGuard} onClick={() => newWo({ project: p.id })} />
              <Btn label={p.halted ? "Andon: halted" : "Andon"} kind="andon" icon="halt" id="floor-andon" aria="Andon controls: halt or resume the project or a repo" guard={lockIf(null)} onClick={(e) => andonMenu(e.currentTarget)} aria-haspopup="menu" />
              {killBtn}
            </>
          }
        />
      </div>
      <Kpis />
    </>
  );
}

function FloorBody({ projectId }: { projectId: string }) {
  const prefs = usePrefs();
  const ctx = useFloorCtx();
  const drawers = useDrawers(projectId);
  const view = prefs.floorView || "belt";
  const [playing, setPlaying] = useState(false);
  const rp = ctx.replay;
  const rpRef = useRef(rp);
  rpRef.current = rp;
  useTick(30_000);

  // play: advance the replay clock; each step is one read of the floor at that time
  useEffect(() => {
    if (!playing || !rp) return;
    const t = setInterval(() => {
      const c = rpRef.current;
      if (!c) return;
      const base = c.span === "7d" ? 60 * MIN : 10 * MIN;
      let next = c.at + base * c.speed * 0.5;
      if (next >= c.to) {
        setPlaying(false);
        next = c.to;
      }
      setReplay({ at: next });
    }, 500);
    return () => clearInterval(t);
  }, [playing, !!rp]);
  useEffect(() => {
    if (!rp) setPlaying(false);
  }, [rp]);
  useEffect(() => {
    if (playing && rp && rp.at >= rp.to - MIN) setReplay({ at: rp.from });
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const enter = () => {
    const rg = replayRange("24h");
    setReplay({ at: rg.to - 6 * 3_600_000, span: "24h", project: projectId, speed: 1, from: rg.from, to: rg.to });
  };
  const exit = () => {
    setPlaying(false);
    setReplay(null);
    setTimeout(() => document.getElementById("floor-replay-enter")?.focus(), 60);
  };
  return (
    <>
      <Header />
      <div className="fl-switch">
        <Segmented name="floor-view" label="Floor view" items={[{ id: "belt", label: "Belt", icon: "belt" }, { id: "board", label: "Board", icon: "board" }, { id: "list", label: "List", icon: "list" }]} value={view} onChange={(v) => updatePrefs({ floorView: v })} />
        {rp ? null : <Btn label="Replay" icon="replay" id="floor-replay-enter" aria="Replay the floor over the last 24 hours or 7 days" onClick={enter} />}
        <span className="muted small">{rp ? "Replaying recorded history. Nothing here changes the live floor." : "Live: changes from other people and the factory appear as they happen."}</span>
      </div>
      {rp ? <ReplayBar rp={rp} playing={playing} setPlaying={setPlaying} onExit={exit} /> : null}
      {view === "board" ? <Board /> : view === "list" ? <ListView /> : <Belt onStation={drawers.station} onGate={drawers.gate} />}
    </>
  );
}

export default function FloorView() {
  const me = useMe();
  const prefs = usePrefs();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const r = prefs.replay;
  const rpBase = r && projectId
    ? (() => {
        const span: "24h" | "7d" = r.span === "7d" ? "7d" : "24h";
        const rg = replayRange(span);
        const from = typeof r.from === "number" ? r.from : rg.from;
        const to = typeof r.to === "number" ? r.to : rg.to;
        const at = Math.max(from, Math.min(to, typeof r.at === "number" ? r.at : to));
        return { at: Math.round(at / MIN) * MIN, span, from, to, speed: typeof r.speed === "number" ? r.speed : 1 };
      })()
    : null;
  const { value, error } = useFloorState(projectId, rpBase);
  if (!me) return null;
  if (!projectId) {
    return (
      <div className="view">
        <Empty title="No project selected" text="Pick a project in the top bar to see its floor." />
      </div>
    );
  }
  if (!value && error) {
    return (
      <div className="view view-floor">
        <Empty title="The floor could not be loaded" text="Reload the page, or try again in a moment." />
      </div>
    );
  }
  if (!value) {
    return (
      <div className="view view-floor">
        <p className="muted small">Loading the floor…</p>
      </div>
    );
  }
  return (
    <FloorCtx.Provider value={value as FloorCtxValue}>
      <div className={`view view-floor${value.replay ? " is-replaying" : ""}`}>
        <FloorBody projectId={projectId} />
      </div>
    </FloorCtx.Provider>
  );
}

