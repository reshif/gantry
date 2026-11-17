/**
 * Floor (#floor): the live plant for the current project. One drawing of the line (stations across, work orders down, gates between, the
 * shipped strip and the bays under it) with the project figures above it. The board and the list of work orders live in Work orders.
 * The header carries the project's state, new work order, Line control (andon, kill and restore for the project or one repo) and the
 * Live / Replay switch. Replay rebuilds the floor from the event log at a chosen past time (read-only). All data comes from
 * GET /projects/{id}/floor; every control is a command through the API.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DAY, MIN, fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useMe } from "../api/queries";
import { Btn, Empty, Segmented, Stat, StatRow, Status, ViewHead, type Decision, type Tone } from "../ui/primitives";
import { Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { pickProject } from "../lib/routes";
import { setReplay, usePrefs } from "../lib/prefs";
import { makeStopActions } from "../shell/stopActions";
import { Belt, useBeltStatus } from "./floor/Belt";
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
  const items: Array<{ k: string; v: string; sub: ReactNode; tone?: "wait" | "block" | "done" }> = [
    { k: "Work in flight", v: String(live.length), sub: `${live.filter((w) => w.state === "running").length} running now` },
    { k: "Gates waiting", v: String(waiting.length), sub: waiting.length ? `oldest ${fmt.dur(oldest)}` : "none waiting", ...(waiting.length ? { tone: "wait" as const } : {}) },
    { k: "Stuck", v: String(stuck), sub: "blocked, failed, held, asking", ...(stuck ? { tone: "block" as const } : {}) },
    { k: "Coding slots", v: `${slots}/${p.flow.slots}`, sub: slots >= p.flow.slots ? "all busy" : `${p.flow.slots - slots} free` },
    { k: "Shipped, 7 days", v: String(shipped7), sub: `${shipped24} in 24h, ${wos.filter((w) => w.state === "done" && !w.split).length} in total` },
    { k: "Spend, month to date", v: fmt.money0(p.budget.mtd), sub: ctx.replay ? "Live figure, not replayed." : <>{`${fmt.pct(spendPct)} of ${fmt.money0(p.budget.monthly)}. `}<a href="#project-config">Set in Project settings</a></>, ...(spendPct >= p.budget.alertAt ? { tone: "wait" as const } : {}) },
  ];
  if (killed) items.push({ k: "Killed", v: String(killed), sub: "work orders stopped", tone: "block" });
  return (
    <StatRow id="floor-kpis">
      {items.map((x) => <Stat key={x.k} label={x.k} value={x.v} sub={x.sub} {...(x.tone ? { tone: x.tone } : {})} />)}
    </StatRow>
  );
}

const statusTone = (cls: string): Tone => (cls.includes("is-killed") ? "block" : cls.includes("is-halted") || cls.includes("is-partial") ? "wait" : cls.includes("is-replay") ? "accent" : "done");

function Header({ replaying, onReplay }: { replaying: boolean; onReplay: (on: boolean) => void }) {
  const ctx = useFloorCtx();
  const ui = useUI();
  const me = useMe();
  const status = useBeltStatus();
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
  const killItem = p.killed
    ? { label: `Restore ${p.name}`, icon: "power", hint: "after a kill", guard: dRestore.pending ? null : dRestore, onClick: () => stop.restore("project", p.id) }
    : { label: `Kill ${p.name}`, icon: "st-kill", hint: "stop now", guard: factoryKilled ? { allowed: false, reason: "The whole factory is killed; restore it from Home.", needs: "" } : dKill.pending ? null : dKill, onClick: () => stop.kill("project", p.id) };
  // One menu for everything that stops or restarts the line. Each item is locked, with the server's reason, for people who may not use it.
  const lineMenu = (anchor: HTMLElement) => {
    ui.menu(anchor, `Line control · ${p.name}`, [
      p.halted
        ? { label: `Resume ${p.name}`, icon: "play", hint: "whole project", guard: dResume.pending ? null : dResume, onClick: () => void stop.resume(p.id) }
        : { label: `Halt ${p.name}`, icon: "halt", hint: "whole project", guard: dHalt.pending ? null : dHalt, onClick: () => stop.halt(p.id) },
      ...ctx.repos.map((r) =>
        r.halted
          ? { label: `Resume ${r.name}`, icon: "play", hint: "halted", guard: dResume.pending ? null : dResume, onClick: () => void stop.resumeRepo(r.id) }
          : { label: `Halt ${r.name}`, icon: "halt", hint: "repo only", guard: dHalt.pending ? null : dHalt, onClick: () => stop.haltRepo(r.id, p.id) },
      ),
      { sep: true },
      killItem,
    ]);
  };
  const stateLabel = p.killed ? "Line control: killed" : p.halted ? "Line control: halted" : "Line control";
  return (
    <div id="floor-head">
      <ViewHead
        title={
          <>
            {p.name}
            <span className="vtitle-badge">
              <Status tone={statusTone(status.cls)} icon={status.icon} id="floor-status">{status.label}</Status>
            </span>
          </>
        }
        sub={p.desc}
        actions={
          <>
            <Btn label="New work order" kind="primary" icon="plus" id="floor-new-wo" guard={newGuard} onClick={() => newWo({ project: p.id })} />
            <Btn label={stateLabel} icon={p.killed ? "st-kill" : "halt"} id="floor-line" aria="Line control: halt or resume the project or a repo, kill or restore the project" guard={lockIf(null)} onClick={(e) => lineMenu(e.currentTarget)} aria-haspopup="menu" {...(p.halted || p.killed ? { kind: "danger" as const } : {})} />
            <Segmented name="floor-mode" label="Live or replay" items={[{ id: "live", label: "Live" }, { id: "replay", label: "Replay" }]} value={replaying ? "replay" : "live"} onChange={(v) => onReplay(v === "replay")} />
          </>
        }
      />
    </div>
  );
}

function FloorBody({ projectId }: { projectId: string }) {
  const ctx = useFloorCtx();
  const drawers = useDrawers(projectId);
  const [playing, setPlaying] = useState(false);
  const rp = ctx.replay;
  const hasReplay = !!rp;
  const rpRef = useRef(rp);
  rpRef.current = rp;
  useTick(30_000);

  // play: advance the replay clock; each step is one read of the floor at that time
  useEffect(() => {
    if (!playing || !hasReplay) return;
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
  }, [playing, hasReplay]);
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
    setTimeout(() => document.getElementById("floor-mode-live")?.focus(), 60);
  };
  return (
    <>
      <Header replaying={!!rp} onReplay={(on) => (on ? enter() : exit())} />
      <Kpis />
      <p className="muted small fl-live-note">{rp ? "Replaying recorded history. Nothing here changes the live floor." : "Live: changes from other people and the factory appear as they happen."}</p>
      {rp ? <ReplayBar rp={rp} playing={playing} setPlaying={setPlaying} onExit={exit} /> : null}
      <Belt onStation={drawers.station} onGate={drawers.gate} />
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
  if (!value) {
    const f = error ? failureOf(error) : null;
    return (
      <div className="view view-floor">
        {!f ? <Loading id="floor-loading" label="the floor" /> : f.hidden ? <NotVisible id="floor-hidden" what="this floor" reason={f.msg} /> : <LoadFailed id="floor-error" what="the floor" msg={f.msg} onRetry={() => window.location.reload()} />}
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

