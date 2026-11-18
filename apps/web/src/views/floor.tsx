/**
 * Floor (#floor): the live plant for the current project. One drawing of the line (stations across, work orders down, gates between, the
 * shipped strip and the bays under it) with the project figures above it. The board and the list of work orders live in Work orders.
 * The header carries the project's state, new work order, Line control (andon, kill and restore for the project or one repo) and the
 * Live / Replay switch. Replay rebuilds the floor from the event log at a chosen past time (read-only). All data comes from
 * GET /projects/{id}/floor; every control is a command through the API.
 */
import { useEffect, useState, type ReactNode } from "react";
import { HOUR, fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useMe } from "../api/queries";
import { Icon } from "../ui/Icon";
import { Btn, Empty, Segmented, Status, type Decision, type Tone } from "../ui/primitives";
import { Card, Conveyor, CrEmpty, FloorKpis, FloorTools, ListItem, LoadBar, Page, Ticker } from "../ui/cr";
import { useActors } from "../ui/actors";
import { useActivity } from "../api/queries";
import { eventRows, eventText } from "../lib/eventText";
import { buildBelt } from "./floor/conveyor";
import { useFloorFilter } from "./floor/urlState";
import { openApproval } from "./floor/Approval";
import { Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { pickProject } from "../lib/routes";
import { usePrefs } from "../lib/prefs";
import { makeStopActions } from "../shell/stopActions";
import { useBeltStatus } from "./floor/Belt";
import { useDrawers } from "./floor/Drawers";
import { FloorCtx, since, useFloorCtx, useFloorState, type FloorCtxValue } from "./floor/kit";
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

function Kpis({ open, ticker }: { open: ReturnType<typeof buildBelt>["open"]; ticker: Array<{ when: string; text: string }> }) {
  const ctx = useFloorCtx();
  const { wos, now } = ctx;
  const gates = open.filter((w) => w.state === "waiting" && !w.bay && !!ctx.floor.gates.find((g) => g.wo === w.id)).length;
  const queued = open.filter((w) => w.state === "waiting" && !ctx.floor.gates.some((g) => g.wo === w.id)).length;
  const stuck = open.filter((w) => w.state === "blocked" || w.state === "failed" || w.bay === "sechold" || w.bay === "person").length;
  const perHour = wos.filter((w) => w.state === "done" && !w.split && (w.doneAt ?? 0) > now - 6 * HOUR).length / 6;
  return (
    <div className="floor-top" id="floor-kpis">
      <FloorKpis
        items={[
          { l: "On belt", v: open.length },
          { l: "Queued", v: queued, tone: queued > 8 ? "warn" : undefined },
          { l: "At gates", v: gates, tone: gates ? "warn" : "ok" },
          { l: "Blocked", v: stuck, tone: stuck ? "bad" : "ok" },
          { l: "Per hour", v: perHour.toFixed(1) },
        ]}
      />
      <Ticker items={ticker} />
    </div>
  );
}

const statusTone = (cls: string): Tone => (cls.includes("is-killed") ? "block" : cls.includes("is-halted") || cls.includes("is-partial") ? "wait" : cls.includes("is-replay") ? "accent" : "done");

function Header({ replaying, onReplay, paused, onPause, children }: { replaying: boolean; onReplay: (on: boolean) => void; paused: boolean; onPause: () => void; children: ReactNode }) {
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
  const dRestoreAny = useCan(me?.factory.killed ? "restore.factory" : "restore.project", me?.factory.killed ? {} : { project: p.id });
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
  const killed = factoryKilled ? me.factory.killed : p.killed;
  return (
    <Page
      eyebrow="Operate"
      title="Floor"
      sub={
        <>
          The production line, left to right. Work orders ride the belt; gates are checkpoints where a person decides.{" "}
          <span className="vtitle-badge"><Status tone={statusTone(status.cls)} icon={status.icon} id="floor-status">{status.label}</Status></span>
          <span className="dim mono" style={{ marginLeft: 8, fontSize: 12 }}>{p.name}</span>
        </>
      }
      cls="view-floor-page"
      id="floor-head"
      acts={
        <>
          <Btn label={paused ? "Resume belt" : "Pause belt"} icon={paused ? "play" : "pause"} id="floor-pause" aria-pressed={paused} onClick={onPause} />
          <Btn label="Halt line" kind="danger" icon="halt" id="floor-halt" aria="Emergency stop: halt the line" guard={lockIf(factoryKilled || p.killed ? { allowed: false, reason: "The line is already stopped. Use Start restore.", needs: "" } : dKill.pending ? null : dKill)} onClick={() => stop.kill("project", p.id)} />
        </>
      }
    >
      <div className="row fl-extra" id="floor-extra">
          <Btn label="New work order" kind="primary" icon="plus" id="floor-new-wo" guard={newGuard} onClick={() => newWo({ project: p.id })} />
          <Btn label={p.killed ? "Line control: killed" : p.halted ? "Line control: halted" : "Line control"} icon="halt" id="floor-line" aria="Line control: halt or resume the project or a repo, kill or restore the project" guard={lockIf(null)} onClick={(e) => lineMenu(e.currentTarget)} aria-haspopup="menu" />
          <Segmented name="floor-mode" label="Live or replay" items={[{ id: "live", label: "Live" }, { id: "replay", label: "Replay" }]} value={replaying ? "replay" : "live"} onChange={(v) => onReplay(v === "replay")} />
      </div>
      {killed ? (
        <div className="banner bad" role="alert" id="floor-kill-banner">
          <Icon name="stop" />
          <div className="grow"><b>{factoryKilled ? "Factory stopped." : "Project stopped."}</b>{` ${killed.reason ?? ""} Restore needs ${factoryKilled ? "two Factory Admins" : "a Project Admin"}.`}</div>
          <Btn label="Start restore" small id="floor-start-restore" guard={dRestoreAny.pending ? null : dRestoreAny} onClick={() => stop.restore(factoryKilled ? "factory" : "project", factoryKilled ? null : p.id)} />
        </div>
      ) : null}
      {children}
    </Page>
  );
}

function FloorBody({ projectId }: { projectId: string }) {
  const ctx = useFloorCtx();
  const drawers = useDrawers(projectId);
  const actors = useActors();
  const activity = useActivity(projectId);
  const rp = ctx.replay;
  const { playing, setPlaying, enter, exit } = useReplayPlayer(projectId, rp, "floor-mode-live");
  const [paused, setPaused] = useState(false);
  const { filter, set: setFilter, clear: clearFilter } = useFloorFilter();
  const ui = useUI();
  const [filtersOpen, setFiltersOpen] = useState(false);
  useTick(30_000);

  const agentName = (id: string) => actors(id).name.replace(" (agent)", "");
  const { stations, released, open } = buildBelt(ctx, agentName, filter);
  const ticker = eventRows(activity.data).slice(0, 14).map((e) => ({ when: fmt.ago(e.at, Date.now()), text: eventText(e, ctx.cat, (id) => actors(id).name.replace(" (agent)", "")).replace(/ entered /, " moved to ") }));

  /* below the belt: what waits at a gate (oldest first) and where the belt is tight */
  const gates = open.filter((w) => w.state === "waiting" && !w.bay && ctx.floor.gates.some((g) => g.wo === w.id)).sort((a, b) => since(a) - since(b));
  const load = stations
    .map((s) => {
      const active = s.lane.length;
      return { s, used: active, wait: s.queue.length };
    })
    .sort((a, b) => b.wait - a.wait || b.used / b.s.slots - a.used / a.s.slots)
    .slice(0, 5);
  const scale = Math.max(1, ...load.map((x) => x.s.slots + x.wait));
  const priorities = [...new Set(["P1", "P2", "P3", ...ctx.wos.map((w) => w.priority)])].sort();
  const gateOf = (woId: string) => ctx.floor.gates.find((g) => g.wo === woId);

  return (
    <Header replaying={!!rp} onReplay={(on) => (on ? enter() : exit())} paused={paused} onPause={() => setPaused((v) => !v)}>
      {rp ? <ReplayBar rp={rp} playing={playing} setPlaying={setPlaying} onExit={exit} /> : null}
      <Kpis open={open} ticker={ticker} />
      <FloorTools
        q={filter.q}
        onQ={(q) => setFilter("q", q)}
        filters={[
          { key: "cls", label: "Class", options: ctx.cat.classes.map((c) => [c.id, c.name]) },
          { key: "pri", label: "Priority", options: priorities.map((x): [string, string] => [x, x]) },
          { key: "st", label: "State", options: [["running", "Running"], ["queued", "Queued"], ["gate", "At gate"], ["blocked", "Blocked"]] },
        ]}
        values={{ cls: filter.cls, pri: filter.pri, st: filter.st }}
        onFilter={(k, v) => setFilter(k as "cls" | "pri" | "st", v)}
        onClear={clearFilter}
        open={filtersOpen}
        onToggle={() => setFiltersOpen((o) => !o)}
      />
      <Conveyor stations={stations} released={released} paused={paused} onToken={drawers.token} onStation={drawers.station} onGate={drawers.gate} onPile={drawers.station} />
      <div className="grid g2" style={{ marginTop: 16, alignItems: "start" }}>
        <Card title="Waiting at gates" flush hint="Oldest first" id="floor-gates">
          <div className="list">
            {gates.length ? (
              gates.slice(0, 5).map((w) => {
                const g = gateOf(w.id);
                return (
                  <ListItem key={w.id} tone="warn" title={`${g?.gate ?? ""} · ${w.title}`} sub={`${w.id} · waiting ${fmt.dur(Math.max(0, ctx.now - since(w)))}`}>
                    {g ? <Btn label="Review" small kind="primary" id={`floor-review-${w.id}`} onClick={() => { const gd = ctx.cat.gates.find((x) => x.id === g.gate); openApproval(ui, projectId, w.id, g.gate, gd?.label ?? g.gate, gd?.name ?? ""); }} /> : null}
                  </ListItem>
                );
              })
            ) : (
              <CrEmpty title="No gates waiting" text="Nothing needs a person right now." icon="check" />
            )}
          </div>
        </Card>
        <Card title="Where the belt is tight" hint="Stations ranked by queue pressure" id="floor-tight">
          <div className="stack" style={{ gap: 14 }}>
            {load.map((x) => <LoadBar key={x.s.id} name={x.s.name} used={x.used} slots={x.s.slots} waiting={x.wait} scale={scale} />)}
            <div className="dim mono" style={{ fontSize: 11 }}>Filled = slots in use. Tinted = waiting. Tick = capacity.</div>
          </div>
        </Card>
      </div>
    </Header>
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
      <div className="floor-root">
        {!f ? <Loading id="floor-loading" label="the floor" /> : f.hidden ? <NotVisible id="floor-hidden" what="this floor" reason={f.msg} /> : <LoadFailed id="floor-error" what="the floor" msg={f.msg} onRetry={() => window.location.reload()} />}
      </div>
    );
  }
  return (
    <FloorCtx.Provider value={value as FloorCtxValue}>
      <div className={`floor-root${value.replay ? " is-replaying" : ""}`}>
        <FloorBody projectId={projectId} />
      </div>
    </FloorCtx.Provider>
  );
}

