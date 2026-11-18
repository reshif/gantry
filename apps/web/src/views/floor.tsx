/**
 * Floor (#floor): the live plant for the current project. One drawing of the line (stations across, work orders down, gates between, the
 * shipped strip and the bays under it) with the project figures above it. The board and the list of work orders live in Work orders.
 * The header carries the project's state, new work order, Line control (andon, kill and restore for the project or one repo) and the
 * Live / Replay switch. Replay rebuilds the floor from the event log at a chosen past time (read-only). All data comes from
 * GET /projects/{id}/floor; every control is a command through the API.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useMe } from "../api/queries";
import { Btn, Empty, Panel, Segmented, StateChip, ViewHead, type Decision } from "../ui/primitives";
import { Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { pickProject } from "../lib/routes";
import { hashFor } from "../lib/router";
import { usePrefs } from "../lib/prefs";
import { makeStopActions } from "../shell/stopActions";
import { Belt } from "./floor/Belt";
import { useDrawers } from "./floor/Drawers";
import { FloorCtx, waitingGateId, isLive, since, stationIdx, useFloorCtx, useFloorState, type FloorCtxValue } from "./floor/kit";
import { useQueryParam } from "./floor/urlState";
import { ReplayBar, useReplayBase, useReplayPlayer } from "./floor/Replay";
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
  const { wos } = ctx;
  const live = wos.filter((w) => isLive(w) && w.bay !== "declined");
  const waiting = live.filter((w) => w.state === "waiting" && !w.bay);
  const stuck = wos.filter((w) => (w.state === "blocked" || w.state === "failed" || w.state === "killed") && !w.split && !w.bay).length;
  const parked = live.filter((w) => w.bay).length;
  const released = wos.filter((w) => w.state === "done" && !w.split);
  const oldest = waiting.length ? fmt.dur(waiting.reduce((m, w) => Math.max(m, ctx.now - since(w)), 0)) : "";
  const items: Array<{ k: string; v: string; sub: ReactNode; tone?: string; title?: string }> = [
    { k: "In flight", v: String(live.length), sub: "on the line", tone: "info" },
    { k: "At gates", v: String(waiting.length), sub: "people to approve", tone: "warn", ...(oldest ? { title: `Oldest has waited ${oldest}` } : {}) },
    { k: "Stuck", v: String(stuck), sub: "blocked or failed", tone: "bad" },
    { k: "Parked", v: String(parked), sub: "in side bays" },
    { k: "Released", v: String(released.length), sub: "done", tone: "ok" },
  ];
  return (
    <div className="fstrip" id="floor-kpis">
      {items.map((x) => (
        <div key={x.k} className={`fs${x.tone ? ` ${x.tone}` : ""}`} title={x.title}>
          <span className="micro">{x.k}</span>
          <b className="num">{x.v}</b>
          <span className="small muted">{x.sub}</span>
        </div>
      ))}
    </div>
  );
}

/** Coding slots and month-to-date spend: kept from the platform (budget and spend are always visible), set small under the line, outside the five-cell strip. */
function Facts() {
  const ctx = useFloorCtx();
  const { project: p, wos } = ctx;
  const slots = ctx.replay ? wos.filter((w) => !w.bay && w.state === "running" && ctx.cat.stations[w.station]?.id === "build").slice(0, p.flow.slots).length : ctx.floor.slots.used;
  const spendPct = p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0;
  const alert = spendPct >= p.budget.alertAt;
  return (
    <p className="small muted fl-facts" id="floor-facts">
      <span className="stat-tile"><span className="micro">Coding slots</span> <b className="mono stat-val">{`${slots}/${p.flow.slots}`}</b> {slots >= p.flow.slots ? "all busy" : `${p.flow.slots - slots} free`}</span>
      <span className="stat-tile"><span className="micro">Spend, month to date</span> <b className={`mono stat-val${alert ? " warn" : ""}`}>{fmt.money0(p.budget.mtd)}</b> {ctx.replay ? "Live figure, not replayed." : <>{`${fmt.pct(spendPct)} of ${fmt.money0(p.budget.monthly)}. `}<a href="#project-config">Set in Project settings</a></>}</span>
    </p>
  );
}

function Header({ replaying, onReplay, view, onView }: { replaying: boolean; onReplay: (on: boolean) => void; view: string; onView: (v: string | null) => void }) {
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
        title="Floor"
        kicker={p.key}
        sub="Every work order on the production line, station by station. Click a station, a valve or a tag."
        actions={
          <>
            <Segmented name="floor-view" label="Belt or board" items={[{ id: "belt", label: "Belt" }, { id: "board", label: "Board" }]} value={view} onChange={(v) => onView(v === "board" ? "board" : null)} />
            <Segmented name="floor-mode" label="Live or replay" items={[{ id: "live", label: "Live" }, { id: "replay", label: "Replay" }]} value={replaying ? "replay" : "live"} onChange={(v) => onReplay(v === "replay")} />
            <Btn label={stateLabel} icon={p.killed ? "st-kill" : "halt"} id="floor-line" aria="Line control: halt or resume the project or a repo, kill or restore the project" guard={lockIf(null)} onClick={(e) => lineMenu(e.currentTarget)} aria-haspopup="menu" {...(p.halted || p.killed ? { kind: "danger" as const } : {})} />
            <Btn label="Submit work order" kind="primary" icon="plus" id="floor-new-wo" guard={newGuard} onClick={() => newWo({ project: p.id })} />
          </>
        }
      />
    </div>
  );
}

function BoardPanel() {
  const ctx = useFloorCtx();
  const gateOf = (w: (typeof ctx.wos)[number]): string | null => waitingGateId(ctx, w);
  const line = ctx.project.flow.order.map((id) => ctx.cat.stations.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s && !!ctx.project.flow.stations[s.id]?.enabled);
  return (
    <Panel title="Board" flush>
      <div className="board" id="floor-board">
        {line.map((s) => {
          const list = ctx.wos.filter((w) => w.station === stationIdx(ctx.cat, s.id) && !w.bay && isLive(w));
          return (
            <div key={s.id} className="col" data-station={s.id}>
              <h3><span>{`${s.no} ${s.name}`}</span><span>{list.length}</span></h3>
              <div className="cards">
                {list.length ? list.map((w) => (
                  <a key={w.id} className="card" data-wo={w.id} id={`floor-tok-${w.id}`} href={hashFor("record", w.id, ctx.project.id)}>
                    <div className="row"><span className="mono small">{w.id}</span><span className="spacer" />{gateOf(w) && w.state === "waiting" ? <span className="chip warn state state-waiting"><span>{`At ${gateOf(w)}`}</span></span> : <StateChip state={w.state} />}</div>
                    <div>{w.title}</div>
                    <div className="small muted">{`${ctx.project.name} · ${w.priority}`}</div>
                  </a>
                )) : <div className="small muted">Empty</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function FloorBody({ projectId }: { projectId: string }) {
  const ctx = useFloorCtx();
  const drawers = useDrawers(projectId);
  const rp = ctx.replay;
  const { playing, setPlaying, enter, exit } = useReplayPlayer(projectId, rp, "floor-mode-live");
  useTick(30_000);
  const [viewQ, setView] = useQueryParam("view");
  const view = viewQ === "board" ? "board" : "belt";

  return (
    <>
      <Header replaying={!!rp} onReplay={(on) => (on ? enter() : exit())} view={view} onView={setView} />
      <Kpis />
      {rp ? <ReplayBar rp={rp} playing={playing} setPlaying={setPlaying} onExit={exit} /> : null}
      {view === "board" ? <BoardPanel /> : <Belt onStation={drawers.station} onGate={drawers.gate} onOut={drawers.out} />}
      <Facts />
    </>
  );
}

export default function FloorView() {
  const me = useMe();
  const prefs = usePrefs();
  const projectId = me ? pickProject(me, prefs.project) : null;
  const rpBase = useReplayBase(projectId);
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
      <div className={`view view-floor floorpg${value.replay ? " is-replaying" : ""}`}>
        <FloorBody projectId={projectId} />
      </div>
    </FloorCtx.Provider>
  );
}

