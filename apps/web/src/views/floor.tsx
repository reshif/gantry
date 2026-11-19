/**
 * Floor (#floor): the live plant for the current project. One drawing of the line (stations across, work orders down, gates between, the
 * shipped strip and the bays under it) with the project figures above it. The board and the list of work orders live in Work orders.
 * The header carries the project's state, new work order, Line control (andon, kill and restore for the project or one repo) and the
 * Live / Replay switch. Replay rebuilds the floor from the event log at a chosen past time (read-only). All data comes from
 * GET /projects/{id}/floor; every control is a command through the API.
 */
import { useEffect, useState } from "react";
import { flowOf, fmt } from "@gantry/domain";
import { useCan, useCanMany } from "../api/can";
import { makeStopActions } from "../shell/stopActions";
import { useUI } from "../ui/overlay-context";
import { useAgents, useMe } from "../api/queries";
import { Btn, Empty, Panel, ViewHead, type Decision } from "../ui/primitives";
import { Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { pickProject } from "../lib/routes";
import { hashFor } from "../lib/router";
import { usePrefs } from "../lib/prefs";
import { Belt } from "./floor/Belt";
import { NeedBar } from "./floor/Need";
import { PartsList, type PartsSort } from "./floor/Parts";
import { buildModel, dur, type FloorModel } from "./floor/model";
import type { LineHandlers } from "./floor/Line";
import { useDrawers } from "./floor/Drawers";
import { FloorCtx, WoChip, isLive, stationIdx, useFloorCtx, useFloorState, type FloorCtxValue, type FWo } from "./floor/kit";
import { useQueryParam } from "./floor/urlState";
import { ReplayBar, useReplayBase, useReplayPlayer } from "./floor/Replay";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";
import "../styles/views/floor.css";
import "../styles/views/floor-line.css";

const REPLAY_LOCK: Decision = { allowed: false, reason: "Replay is showing the past. Go back to live to act.", needs: "" };

function useTick(ms: number): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** The ticker beside the title: how much is on the line, where it is jammed, the longest wait at a person's gate, and what shipped. */
function Ticker({ model }: { model: FloorModel }) {
  const facts = useFacts();
  const ctx = useFloorCtx();
  const bn = model.bottleneck;
  const old = model.oldest;
  return (
    <div className="fp-ticker" id="floor-kpis" aria-label="Line summary">
      <div className="tk" title={facts}>
        <span className="k">ON THE LINE</span>
        <span className="v">{model.live.length}<small>{`of ${ctx.wos.filter((w) => w.bay !== "declined").length}`}</small></span>
      </div>
      <div className={`tk${bn ? " bott" : ""}`}>
        <span className="k">BOTTLENECK</span>
        <span className="v">{bn ? `${bn.st.s.no} ${bn.st.items.length}/${bn.st.lim}` : "none"}<small>{bn ? `+${bn.over} over` : "all within limit"}</small></span>
      </div>
      <div className="tk" title={old ? `Oldest has waited ${fmt.dur(old.ms)}` : undefined}>
        <span className="k">{old ? `OLDEST AT ${old.gate}` : "OLDEST AT GATE"}</span>
        <span className="v">{old ? dur(old.ms) : "—"}<small>{old ? old.wo : "nobody waiting"}</small></span>
      </div>
      <div className="tk done">
        <span className="k">RELEASED</span>
        <span className="v">{model.done.length}<small>shipped</small></span>
      </div>
    </div>
  );
}

/** Coding slots and month-to-date spend (kept from the platform): they ride as the tooltip of the In flight figure, so the strip stays the prototype's five cells. */
function useFacts(): string {
  const ctx = useFloorCtx();
  const { project: p, wos } = ctx;
  const slots = ctx.replay ? wos.filter((w) => !w.bay && w.state === "running" && ctx.cat.stations[w.station]?.id === "build").slice(0, p.flow.slots).length : ctx.floor.slots.used;
  const spendPct = p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0;
  return `Coding slots ${slots}/${p.flow.slots} · Spend, month to date ${fmt.money0(p.budget.mtd)} (${fmt.pct(spendPct)} of ${fmt.money0(p.budget.monthly)})${ctx.replay ? ", live figure" : ""}`;
}

/** Line control in the Floor header: halt or resume this project's line, and the factory emergency stop (each asks for step-up in its dialog). */
function LineControl() {
  const ctx = useFloorCtx();
  const me = useMe();
  const ui = useUI();
  const p = ctx.project;
  const killed = !!me?.factory.killed;
  const halted = !!me?.projects.find((x) => x.id === p.id)?.halted;
  // S-42: a killed project is restored here (Halt is refused by the server on it, so it is not offered)
  const projKilled = !!(p.killed ?? me?.projects.find((x) => x.id === p.id)?.killed);
  const checks = useCanMany([{ action: halted ? "line.resume" : "line.halt", project: p.id }, { action: killed ? "restore.factory" : "kill.factory" }, { action: "line.halt", project: p.id }, { action: "line.resume", project: p.id }, { action: "restore.project", project: p.id }]);
  if (!me) return null;
  const stop = makeStopActions(ui, me);
  const guardOf = (i: number) => (ctx.replay ? REPLAY_LOCK : checks[i]?.pending ? undefined : checks[i]);
  return (
    <Btn
      label="Line control"
      icon="pause"
      id="floor-line-control"
      aria-haspopup="menu"
      onClick={(e) =>
        ui.menu(e.currentTarget as HTMLElement, null, [
          { head: "Line control" },
          ...(projKilled
            ? [{ label: checks[4]?.override ? "Restore project with a reason" : "Restore project", icon: "right", guard: guardOf(4), onClick: () => stop.restore("project", p.id) }]
            : [{ label: halted ? "Resume line" : "Halt line (pause the project)", icon: halted ? "right" : "pause", guard: guardOf(0), onClick: () => (halted ? void stop.resume(p.id) : stop.halt(p.id)) }]),
          ...(ctx.repos.length && !projKilled ? [{ head: "Pause one repo" }] : []),
          ...(projKilled ? [] : ctx.repos).map((r) => ({ label: r.halted ? `Resume ${r.name}` : `Pause ${r.name}`, icon: r.halted ? "right" : "pause", guard: guardOf(r.halted ? 3 : 2), onClick: () => (r.halted ? void stop.resumeRepo(r.id) : stop.haltRepo(r.id, p.id)) })),
          { head: "Whole factory" },
          { label: killed ? (checks[1]?.override ? "Restore with a reason" : "Restore factory") : "Emergency stop", icon: "stop", guard: guardOf(1), onClick: () => (killed ? stop.restore("factory", null) : stop.kill("factory", null)) },
        ])
      }
    />
  );
}

function Header({ view, onView, model, parts, onParts, focus, onFocus, replaying, onReplay }: { view: string; onView: (v: string | null) => void; model: FloorModel; parts: boolean; onParts: () => void; focus: boolean; onFocus: () => void; replaying: boolean; onReplay: (on: boolean) => void }) {
  const ctx = useFloorCtx();
  const me = useMe();
  const p = ctx.project;
  const newWo = useNewWorkOrder();
  const dSubmit = useCan("wo.submit", { project: p.id });
  if (!me) return null;
  const block = projectSubmitBlock(me, p, ctx.repos);
  const newGuard: Decision | null = ctx.replay ? REPLAY_LOCK : !dSubmit.allowed && !dSubmit.pending ? dSubmit : block ? { allowed: false, reason: block, needs: "" } : null;
  const partsN = model.all.filter((b) => b.w.bay !== "declined").length;
  return (
    <div id="floor-head">
      <ViewHead
        title="Floor"
        kicker={p.key}
        sub={`${p.name} · flow v${ctx.floor.flowVersion}`}
        actions={
          <>
            <Btn label={`Parts list (${partsN})`} id="floor-parts-toggle" title="Show the bill of materials: every work order as a numbered part" aria-pressed={parts} aria-controls="floor-parts" aria-expanded={parts} onClick={onParts} />
            <Btn label="Focus on me" icon="eye" id="floor-focus" title="Dim everything that does not need a person" aria-pressed={focus} onClick={onFocus} />
            <div className="seg" role="group" aria-label="Live or replay">
              <Btn label="Live" id="floor-mode-live" aria-pressed={!replaying} onClick={() => onReplay(false)} />
              <Btn label="Replay" id="floor-mode-replay" title="Rebuild the floor from the event log at a past time (read-only)" aria-pressed={replaying} onClick={() => onReplay(true)} />
            </div>
            <div className="seg" role="group" aria-label="View">
              {(["belt", "board"] as const).map((v) => (
                <Btn key={v} label={v === "belt" ? "Belt" : "Board"} id={`floor-view-${v}`} aria-pressed={view === v} onClick={() => onView(v === "board" ? "board" : null)} />
              ))}
            </div>
            <LineControl />
            <Btn label="Submit work order" kind="primary" icon="plus" id="floor-new-wo" guard={newGuard} onClick={() => newWo({ project: p.id })} />
          </>
        }
      />
      <Ticker model={model} />
    </div>
  );
}

function BoardCol({ id, title, list, needs }: { id: string; title: string; list: FWo[]; needs: Set<string> }) {
  const ctx = useFloorCtx();
  return (
    <div className="col" data-station={id}>
      <h3><span>{title}</span><span>{list.length}</span></h3>
      <div className="cards">
        {list.length ? list.map((w) => (
          <a key={w.id} className={`card${needs.has(w.id) ? " need" : ""}`} data-wo={w.id} id={`floor-tok-${w.id}`} href={hashFor("record", w.id, ctx.project.id)}>
            <div className="row"><span className="mono small">{w.id}</span><span className="spacer" /><WoChip w={w} /></div>
            <div>{w.title}</div>
            <div className="small muted">{`${ctx.project.name} · ${w.priority}`}</div>
          </a>
        )) : <div className="small muted">Empty</div>}
      </div>
    </div>
  );
}

function BoardPanel({ model, focus }: { model: FloorModel; focus: boolean }) {
  const ctx = useFloorCtx();
  const needs = new Set([...model.groups.flatMap((g) => g.wos.map((w) => w.id)), ...model.all.filter((b) => b.kind === "stuck" || b.kind === "gate").map((b) => b.w.id)]);
  const line = ctx.project.flow.order.map((id) => ctx.cat.stations.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s && !!ctx.project.flow.stations[s.id]?.enabled);
  const bays = flowOf(ctx.cat, ctx.project).bays.filter((b) => b.id !== "declined");
  const killedList = ctx.wos.filter((w) => w.state === "killed" && w.bay !== "declined");
  return (
    <Panel title="Board" flush>
      <div className={`board board-fit${focus ? " is-focus" : ""}`} id="floor-board">
        {line.map((s) => (
          <BoardCol key={s.id} id={s.id} title={`${s.no} ${s.name}`} list={ctx.wos.filter((w) => w.station === stationIdx(ctx.cat, s.id) && !w.bay && isLive(w))} needs={needs} />
        ))}
        {/* S-41: orders parked in a bay and killed ones are on the Board too, as columns after the stations (declined orders stay out, as in the Parts list and the ticker) */}
        {bays.map((b) => (
          <BoardCol key={b.id} id={`bay-${b.id}`} title={`Bay · ${b.name}`} list={ctx.wos.filter((w) => w.bay === b.id && w.state !== "killed" && w.state !== "done")} needs={needs} />
        ))}
        {killedList.length ? <BoardCol id="killed" title="Killed" list={killedList} needs={needs} /> : null}
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
  const agents = useAgents().data;
  const model = buildModel(ctx, agents);
  const [viewQ, setView] = useQueryParam("view");
  const [partsQ, setParts] = useQueryParam("parts");
  const [sortQ, setSort] = useQueryParam("psort");
  const [focusQ, setFocus] = useQueryParam("focus");
  const [hl, setHl] = useState<string[] | null>(null);
  const view = viewQ === "board" ? "board" : "belt";
  const parts = partsQ === "open";
  const focus = focusQ === "1";
  const sort: PartsSort = sortQ === "wait" || sortQ === "rev" ? sortQ : "group";
  const h: Omit<LineHandlers, "route"> = { onStation: drawers.station, onGate: drawers.gate, onBay: (sid, bayId) => drawers.bay(bayId, sid), onOut: drawers.out, onWo: drawers.wo, hl: new Set(hl ?? []), hover: setHl };
  const showParts = parts;
  return (
    <>
      <Header view={view} onView={setView} model={model} parts={parts} onParts={() => setParts(parts ? null : "open")} focus={focus} onFocus={() => setFocus(focus ? null : "1")} replaying={!!rp} onReplay={(on) => (on ? enter() : exit())} />
      {rp ? <ReplayBar rp={rp} playing={playing} setPlaying={setPlaying} onExit={exit} /> : null}
      {view === "board" ? (
        <>
          <NeedBar model={model} h={{ ...h, route: null }} onMore={() => { setParts("open"); setSort(null); }} />
        <div className={`fp-main${showParts ? " has-parts" : ""}`}>
          <div className="fp-left">
            <BoardPanel model={model} focus={focus} />
          </div>
          {showParts ? <PartsList model={model} sort={sort} onSort={(s) => setSort(s === "group" ? null : s)} onClose={() => setParts(null)} h={{ ...h, route: null }} /> : null}
        </div>
        </>
      ) : (
        <>
          <NeedBar model={model} h={{ ...h, route: null }} onMore={() => { setParts("open"); setSort(null); }} />
          <div className={`fp-main${showParts ? " has-parts" : ""}${focus ? " is-focus" : ""}`}>
            <div className="fp-left">
              <Belt model={model} h={h} focus={focus} showHint={!showParts} />
            </div>
            {showParts ? <PartsList model={model} sort={sort} onSort={(s) => setSort(s === "group" ? null : s)} onClose={() => setParts(null)} h={{ ...h, route: null }} /> : null}
          </div>
        </>
      )}
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

