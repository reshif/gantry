/**
 * The belt of the floor: the project's line drawn top to bottom, one row per station and one row per gate
 * between them, ending in Shipped, with the bays (work that left the line) underneath. The line never wraps
 * back on itself, and every gate has room for its full name, state and who must act (docs/ui/design-system.md §1).
 */
import { useState, type CSSProperties } from "react";
import { DAY, approvalText, flowOf, gateDef, gateExplain, gateKind, gateKindText, gateStateText, gateTitle, route as routeOf, routeGates as routeGatesOf, fmt, type Gate } from "@gantry/domain";
import { useAgents, useMe } from "../../api/queries";
import { Btn, Field, FilterBar, SearchBox, Select } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { navigate } from "../../lib/router";
import { useOpenTraveler } from "../../shell/useTraveler";
import { Icon } from "../../ui/Icon";
import { updatePrefs, usePrefs } from "../../lib/prefs";
import { ClassChip, classOf } from "../projects/kit";
import {
  FloorCtx, WoToken, assigneeOf, bayName, gateHaveNeed, gateOfStation, gateStateOf, gateText, isLive, layoutFor, openEntry, since, stationIdx, useFloorCtx, type FWo,
} from "./kit";

/* ---------- gates ---------- */

/** How a gate has been passing in the 24 hours before the shown time: under trust or by a person. */
function gateTrustSummary(ctx: ReturnType<typeof useFloorCtx>, gid: string): { mode: "trust" | "human" | "sampled"; short: string; tip: string } | null {
  if (gateKind(ctx.cat, ctx.project, gid) === "auto" || gid === "G0G1") return null;
  const t = ctx.now;
  const from = t - DAY;
  const list: Array<{ mode: string; trust?: number; reason?: string; by?: string; at: number }> = [];
  for (const w of ctx.wos) {
    const d = w.gates?.[gid]?.decision as { mode?: string; trust?: number; reason?: string; by?: string; at: number } | undefined;
    if (w.gates?.[gid]?.status === "passed" && d && d.at <= t && d.at > from) list.push({ ...d, mode: d.mode ?? "human" });
  }
  const sampled = ctx.wos.some((w) => w.gates?.[gid]?.status === "waiting" && !w.bay && /sampled/.test(w.gates[gid]?.trustNote ?? ""));
  if (!list.length && !sampled) return null;
  list.sort((a, b) => a.at - b.at);
  const last = list[list.length - 1];
  const nT = list.filter((d) => d.mode === "trust").length;
  const tip = `Last 24h: ${nT} passed under trust, ${list.length - nT} by a person${sampled ? "; one waiting was sampled for review" : ""}.`;
  if (sampled && (!last || last.mode !== "trust")) return { mode: "sampled", short: "sampled", tip };
  if (!last) return null;
  if (last.mode === "trust") return { mode: "trust", short: `L${last.trust ?? "?"} auto`, tip: `${tip} Last: ${last.reason ?? "under trust"}` };
  return { mode: "human", short: "person", tip: `${tip} Last: approved by ${last.by ?? "a person"}${last.trust != null ? ` with the cell at L${last.trust}` : ""}.` };
}

export function GateNode({ gid, onOpen, gates }: { gid: string; onOpen: (gid: string) => void; gates?: string[] | null }) {
  const ctx = useFloorCtx();
  const L = layoutFor(ctx.cat, ctx.project);
  const g = gateDef(ctx.cat, gid) as Gate;
  const gs = gateStateOf(ctx, gid);
  const rule = ctx.project.approvers[gid];
  const count = gs.state === "failing" ? gs.failing : gs.waiting;
  const mode = gateKind(ctx.cat, ctx.project, gid);
  const cap = gs.state === "off" ? "off · skipped" : gs.state === "failing" ? `${gs.failing} failing` : gs.state === "waiting" ? `${gs.waiting} waiting` : "nothing waiting";
  const roleName = (r: string): string => ctx.cat.roles.find((x) => x.id === r)?.name ?? r;
  const approval = approvalText(g, mode, rule, roleName);
  const need = mode !== "auto" && gs.state !== "off" ? (gid === "G0G1" ? "1 approval" : `${rule ? Math.max(1, rule.required) : 1} approval${rule && rule.required > 1 ? "s" : ""}`) : null;
  const tr = gs.state !== "off" ? gateTrustSummary(ctx, gid) : null;
  const base = `${gateTitle(g)}: ${gateStateText(gs.state, count)}. ${gateKindText(mode)}. ${gs.state === "off" ? "" : `${approval}. `}${gateExplain(g, mode)}`;
  const label = tr ? `${base} ${tr.tip}` : base;
  return (
    <div className={`fl-gate fl-gate-${gs.state}${tr && tr.mode === "trust" ? " is-trusted" : ""}${gates && !gates.includes(gid) ? " is-offroute" : ""}`} data-gate={gid} style={{ "--o": L.order[gid] } as CSSProperties}>
      <span className="fl-gate-rail" aria-hidden="true" />
      <button type="button" id={`floor-gate-${gid}`} className={`gate gate-${gs.state} gate-md gate-kind-${g.kind}`} aria-label={label} data-tip={label} onClick={() => onOpen(gid)}>
        <span className="gate-shape" aria-hidden="true">
          <span className="gate-count">{gs.state === "waiting" ? String(count) : gs.state === "failing" ? "!" : gs.state === "off" ? "–" : "✓"}</span>
        </span>
        <span className="fl-gate-short" aria-hidden="true">{g.name.split(" ")[0]}</span>
        <span className="gate-label mono">{g.label}</span>
      </button>
      <span className="fl-gate-cap">
        <span className="fl-gate-name">{g.name}</span>
        <span className="fl-gate-state">{cap}</span>
        {need ? <span className="fl-gate-need" title={approval}>{`needs ${need}`}</span> : null}
        {tr ? (
          <span className={`fl-gate-tr is-${tr.mode}`} aria-hidden="true">
            <Icon name={tr.mode === "trust" ? "trust" : "human"} />
            {tr.short}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/* ---------- the line: stations across, work orders down ---------- */

function haltedRepoName(ctx: ReturnType<typeof useFloorCtx>, w: FWo): string | null {
  const r = ctx.repos.find((x) => x.id === w.repo);
  if (ctx.replay) return ctx.replay.state.haltedRepos[w.repo] ? (r?.name ?? w.repo) : null;
  return r?.halted ? r.name : null;
}

/** Column head of one station: name, its limit, who staffs it, what is in it, and the gate after it. */
function StationHead({ sid, onStation, onGate, gates, bypassed }: { sid: string; onStation: (sid: string) => void; onGate: (gid: string) => void; gates: string[] | null; bypassed: boolean }) {
  const ctx = useFloorCtx();
  const agents = useAgents().data;
  const st = ctx.cat.stations.find((s) => s.id === sid);
  const conf = ctx.project.flow.stations[sid];
  if (!st || !conf) return null;
  const i = stationIdx(ctx.cat, sid);
  const here = ctx.wos.filter((w) => w.station === i && !w.bay && w.state !== "done");
  const live = here.filter(isLive);
  const over = conf.enabled && live.length > conf.wip;
  const ag = agents?.find((a) => a.id === st.agent);
  const g = gateOfStation(ctx.cat, ctx.project, sid);
  const holders = ctx.floor.slots.holders;
  const slotTotal = ctx.project.flow.slots;
  const busyFor = (n: number): string | null => {
    if (ctx.replay) return ctx.wos.filter((w) => w.station === stationIdx(ctx.cat, "build") && !w.bay && w.state === "running").slice(0, slotTotal)[n - 1]?.id ?? null;
    return holders.find((h) => h.slot === n)?.wo ?? null;
  };
  const queued = ctx.wos.filter((x) => x.bay === "queue" && isLive(x)).length;
  const used = Array.from({ length: slotTotal }, (_, k) => busyFor(k + 1)).filter(Boolean).length;
  const idle = !live.length && sid !== "build";
  return (
    <div className={`fl-st fl-st-col${conf.enabled ? "" : " is-off"}${idle ? " is-idle" : ""}${over ? " is-over" : ""}${sid === "build" ? " is-build" : ""}${bypassed ? " is-bypassed" : ""}`} data-station={sid}>
      <button type="button" className="fl-st-head" id={`floor-st-${sid}`} aria-label={`${st.no} ${st.name}: ${live.length} in progress, limit ${conf.wip}. Open station details`} onClick={() => onStation(sid)}>
        <span className="fl-st-no mono">{st.no}</span>
        <span className="fl-st-name">{st.name}</span>
      </button>
      <span className={`fl-wip mono${over ? " is-over" : ""}`} title={over ? "Over the WIP limit" : undefined}>{conf.enabled ? `WIP ${live.length}/${conf.wip}` : "off"}</span>
      <span className="fl-agent" title={`Agent: ${ag?.name ?? st.agent}`}>{ag?.name ?? st.agent}</span>
      {!conf.enabled ? <span className="fl-off faint">Off here. Work passes by.</span> : null}
      {sid === "build" && conf.enabled ? (
        <ul className="fl-slots" aria-label="Coding slots">
          {Array.from({ length: slotTotal }, (_, k) => {
            const wo = busyFor(k + 1);
            return (
              <li key={k} className={`fl-slot${wo ? " is-busy" : ""}`} title={`Coding slot ${k + 1} of ${slotTotal}: ${wo ?? "free"}`}>
                <span className="fl-slot-dot" aria-hidden="true" />
                <span className="sr fl-slot-k">{`coding slot ${k + 1} of ${slotTotal}`}</span>
                <span className="mono fl-slot-v">{wo ?? "free"}</span>
              </li>
            );
          })}
          <li className="fl-slot-sum faint">{`${used}/${slotTotal}${queued ? ` · ${queued} waiting` : ""}`}</li>
        </ul>
      ) : null}
      {idle && conf.enabled ? <span className="fl-idle faint">idle</span> : null}
      {g ? <GateNode gid={g.id} onOpen={onGate} gates={gates} /> : null}
    </div>
  );
}

type CellKind = "passed" | "now" | "todo" | "skip";

/** One cell of a work order's row: what happened at this station, from the work order's own history. */
function Cell({ w, sid, route, onGate }: { w: FWo; sid: string; route: string[]; onGate: (gid: string) => void }) {
  const ctx = useFloorCtx();
  const actor = useActors();
  const j = stationIdx(ctx.cat, sid);
  const g = gateOfStation(ctx.cat, ctx.project, sid);
  const onRoute = route.includes(sid);
  const done = w.state === "done";
  const kind: CellKind = !onRoute ? "skip" : done || j < w.station ? "passed" : j === w.station ? "now" : "todo";
  const spent = (w.history ?? []).filter((h) => h.station === sid && h.endedAt != null).reduce((n, h) => n + ((h.endedAt ?? 0) - h.startedAt), 0);
  const gateOn = !!g && ctx.project.flow.gates[g.id] !== undefined && !ctx.project.flow.gates[g.id]?.absent;
  const gs = g ? w.gates?.[g.id]?.status : undefined;
  const waitingHere = !!g && (ctx.replay ? w.replayGate === g.id && w.state === "waiting" : gs === "waiting");
  const gKind = !g || !gateOn ? "" : waitingHere ? "wait" : gs === "failed" ? "fail" : gs === "passed" || (done && onRoute) || (kind === "passed" && !gs) ? "ok" : "todo";
  const who = assigneeOf(w);
  const nowText = w.bay ? bayName(ctx.cat, w.bay) : w.state === "running" ? (who ? actor(who).name.replace(" (agent)", "") : "Working") : w.state === "waiting" ? "Waiting" : w.state === "failed" ? "Failed" : w.state === "blocked" ? "Blocked" : w.state === "killed" ? "Killed" : "";
  const glyph = w.bay ? "st-park" : w.state === "waiting" ? "st-wait" : w.state === "failed" ? "st-fail" : w.state === "blocked" || w.state === "killed" ? "st-block" : "st-run";
  return (
    <div className={`fl-cell fl-cell-${kind}`} data-cell={sid}>
      {kind === "skip" ? <span className="fl-cell-t faint" title="This class does not use this station">–</span> : null}
      {kind === "passed" ? (
        <>
          <span className="fl-cell-g" aria-hidden="true">✓</span>
          <span className="fl-cell-t faint">{spent ? fmt.dur(spent) : "done"}</span>
          <span className="sr">{`passed ${ctx.cat.stations[j]?.name ?? sid}`}</span>
        </>
      ) : null}
      {kind === "now" ? (
        <span className={`fl-cell-now is-${w.bay ? "park" : w.state}`}>
          <Icon name={glyph} />
          <span>{nowText}</span>
        </span>
      ) : null}
      {gKind && g ? (
        <button type="button" className={`fl-dia fl-dia-${gKind}`} aria-label={`${g.name} for ${w.id}: ${gKind === "wait" ? "waiting" : gKind === "fail" ? "failing" : gKind === "ok" ? "passed" : "not reached"}`} data-tip={`${g.name}${gKind === "wait" ? ": waiting" : ""}`} onClick={() => onGate(g.id)}>
          <span aria-hidden="true">{gKind === "ok" ? "✓" : gKind === "fail" ? "!" : ""}</span>
        </button>
      ) : null}
    </div>
  );
}

function WoRow({ w, line, onGate }: { w: FWo; line: string[]; onGate: (gid: string) => void }) {
  const ctx = useFloorCtx();
  const open = useOpenTraveler();
  const actor = useActors();
  const route = routeOf(ctx.cat, ctx.project, w.cls);
  const killed = w.state === "killed";
  const cls = classOf(ctx.cat, ctx.project, w.cls);
  const gt = gateText(ctx, w);
  const halted = haltedRepoName(ctx, w);
  const a = assigneeOf(w);
  const st = ctx.cat.stations[w.station];
  return (
    <li className={`fl-row${killed ? " is-killed" : ""}${halted ? " is-halted" : ""}`} data-wo={w.id}>
      <div className="fl-row-main">
        <button type="button" className="fl-row-open" id={`floor-tok-${w.id}`} aria-label={`${w.id}, ${w.title}, ${cls.name}, ${gt.t}`} onClick={() => open(w.id)}>
          <span className="mono strong fl-row-id">{w.id}</span>
          <span className="fl-row-title">{w.title}</span>
        </button>
        <span className="fl-row-meta">
          <ClassChip cls={cls} small />
          <span className={`chip wo-prio wo-prio-${w.priority}`}>{w.priority}</span>
          <span className={`fl-row-note${gt.c ? ` is-${gt.c}` : ""}`}>{w.state === "running" && a ? `${actor(a).name.replace(" (agent)", "")} working` : gt.t}</span>
          {halted ? <span className="chip chip-block" title={`${halted} is halted (andon)`}>{`${halted} halted`}</span> : null}
        </span>
        <span className="fl-row-where muted small">{w.bay ? bayName(ctx.cat, w.bay) : `At ${st?.name ?? ""}`}</span>
      </div>
      <div className="fl-cells">
        {line.map((sid) => <Cell key={sid} w={w} sid={sid} route={route} onGate={onGate} />)}
      </div>
    </li>
  );
}

/* ---------- bays and shipped ---------- */

function Bays() {
  // Bays sit off the line, under it: work that left the belt and returns to the station it came from.
  const ctx = useFloorCtx();
  const bays = flowOf(ctx.cat, ctx.project).bays;
  return (
    <section className="fl-bays" aria-label="Off the line" style={{ "--bays": Math.min(6, bays.length) } as CSSProperties}>
      <div className="fl-bays-h">
        <span className="fl-bays-t">Off the line</span>
        <span className="muted small">Work that left the line waits here, then returns to the station it came from.</span>
      </div>
      <div className="fl-bays-row">
        {bays.map((b) => {
          const list = ctx.wos.filter((w) => w.bay === b.id && w.state !== "killed");
          const shown = b.id === "declined" ? list.slice(-3) : list;
          return (
            <div key={b.id} className={`fl-bay fl-bay-${b.id}${list.length ? " has-work" : ""}`} data-bay={b.id}>
              <div className="fl-bay-h" title={b.desc}>
                <Icon name={b.id === "sechold" ? "shield" : b.id === "person" ? "human" : b.id === "queue" ? "clock" : b.id === "declined" ? "x" : "st-park"} />
                <span className="fl-bay-n">{b.name}</span>
                <span className="mono fl-bay-c">{String(list.length)}</span>
              </div>
              <div className="fl-bay-toks">
                {shown.map((w) => (
                  <WoToken key={w.id} w={w} compact idPrefix="floor-tok-" />
                ))}
                {b.id === "declined" && list.length > 3 ? <span className="muted small">{`${list.length - 3} older`}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Shipped() {
  const ctx = useFloorCtx();
  const done = ctx.wos.filter((w) => w.state === "done" && !w.split).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const today = done.filter((w) => (w.doneAt ?? 0) > ctx.now - DAY).length;
  return (
    <section className="fl-ship" data-ship="1" style={{ "--o": 99 } as CSSProperties} aria-label="Shipped">
      <div className="fl-ship-h">
        <Icon name="rocket" />
        <span className="fl-ship-t">Shipped</span>
        <span className="mono small">{`${today} in 24h · ${done.length} total`}</span>
      </div>
      <div className="fl-ship-toks">
        {done.slice(0, 6).map((w) => (
          <WoToken key={w.id} w={w} compact idPrefix="floor-tok-" />
        ))}
        {!done.length ? <span className="muted small">Nothing shipped yet.</span> : null}
      </div>
    </section>
  );
}

/* ---------- the belt ---------- */

export function useBeltStatus(): { cls: string; label: string; icon: string } {
  const ctx = useFloorCtx();
  const me = useMe();
  const p = ctx.project;
  if (ctx.replay) {
    const s = ctx.replay.state;
    const at = ` · ${fmt.stamp(ctx.replay.at)}`;
    if (s.killed) return { cls: "is-replay is-killed", label: `Replay · ${s.killed.scope === "factory" ? "factory" : "project"} killed at this time${at}`, icon: "st-kill" };
    if (s.halted) return { cls: "is-replay is-halted", label: `Replay · halted at this time${at}`, icon: "halt" };
    return { cls: "is-replay", label: `Replay · not live${at}`, icon: "replay" };
  }
  if (me?.factory.killed) return { cls: "is-killed", label: "Line stopped · factory killed", icon: "st-kill" };
  if (p.killed) return { cls: "is-killed", label: "Line stopped · project killed", icon: "st-kill" };
  if (p.status === "archived") return { cls: "is-killed", label: "Archived", icon: "lock" };
  if (p.halted) return { cls: "is-halted", label: "Halted · andon pulled", icon: "halt" };
  const rh = ctx.repos.filter((r) => r.halted).length;
  if (rh) return { cls: "is-partial", label: `Running · ${rh} repo${rh > 1 ? "s" : ""} halted`, icon: "halt" };
  return { cls: "is-live", label: "Running · live", icon: "st-run" };
}

function RoutePill({ id, hover, onHover }: { id: string; hover: string | null; onHover: (id: string | null) => void }) {
  const ctx = useFloorCtx();
  const prefs = usePrefs();
  const c = classOf(ctx.cat, ctx.project, id);
  const route = routeOf(ctx.cat, ctx.project, id);
  const skipped = flowOf(ctx.cat, ctx.project).active.filter((s) => !route.includes(s.id)).map((s) => s.name);
  const text = c.endsAfter ? `${c.name}: ends after ${ctx.cat.stations.find((s) => s.id === c.endsAfter)?.name ?? c.endsAfter}` : skipped.length ? `${c.name}: skips ${skipped.join(", ")}` : `${c.name}: full route`;
  const active = prefs.activeClass === id;
  return (
    <button
      type="button"
      className={`fl-route cls-${c.id}${c.custom && c.token ? ` ${c.token}` : ""}${c.custom ? " is-custom" : ""}${active ? " is-active" : ""}${(hover ?? prefs.activeClass) === id ? " is-hl" : ""}`}
      id={`floor-route-${id}`}
      title={text}
      aria-label={text}
      aria-pressed={active ? "true" : "false"}
      data-cls={id}
      onClick={() => updatePrefs((p) => ({ activeClass: p.activeClass === id ? null : id }))}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
    >
      <span className="cls-mark" aria-hidden="true" />
      <span className="fl-route-n">{c.name}</span>
    </button>
  );
}

export function Belt({ onStation, onGate }: { onStation: (sid: string) => void; onGate: (gid: string) => void }) {
  const ctx = useFloorCtx();
  const prefs = usePrefs();
  const [hover, setHover] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [repo, setRepo] = useState("all");
  const [prio, setPrio] = useState("all");
  const [routes, setRoutes] = useState(false);
  const p = ctx.project;
  const L = layoutFor(ctx.cat, p);
  const classes = flowOf(ctx.cat, p).classes;
  const activeCls = hover ?? prefs.activeClass;
  const route = activeCls ? routeOf(ctx.cat, p, activeCls) : null;
  const gates = activeCls ? routeGatesOf(ctx.cat, p, activeCls) : null;
  const line = [...L.top, ...L.bottom];
  const needle = q.trim().toLowerCase();
  const onLine = ctx.wos
    .filter((w) => !w.bay && w.state !== "done" && (isLive(w) || w.state === "killed"))
    .filter((w) => (repo === "all" || w.repo === repo) && (prio === "all" || w.priority === prio) && (!needle || w.id.toLowerCase().includes(needle) || w.title.toLowerCase().includes(needle)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const legend = (state: string, text: string) => (
    <span key={state} className={`fl-leg gate-${state}`}>
      <span className="fl-leg-d" aria-hidden="true" />
      {text}
    </span>
  );
  const gatesOn = line.filter((sid) => {
    const g = gateOfStation(ctx.cat, p, sid);
    return !!g && !!p.flow.gates[g.id]?.enabled;
  }).length;
  const filteredOut = !!needle || repo !== "all" || prio !== "all";
  return (
    <section className={`panel fl-belt${activeCls ? " has-route" : ""}`} id="floor-belt" aria-label={`Line for ${p.name}`} data-active={prefs.activeClass ?? ""}>
      <div className="fl-tools">
        <FilterBar label="Filter the line" actions={<Btn label="Board and list view" kind="ghost" small id="floor-to-board" onClick={() => { updatePrefs({ floorView: "board" }); navigate("work-orders"); }} />}>
          <SearchBox id="floor-q" value={q} onChange={setQ} placeholder="Id or title" label="Search the line" />
          <div className="filters">
            <Field label="Repo" htmlFor="floor-repo">
              <Select id="floor-repo" options={[{ value: "all", label: "all" }, ...ctx.repos.map((r) => ({ value: r.id, label: r.name }))]} value={repo} onChange={setRepo} />
            </Field>
            <Field label="Priority" htmlFor="floor-prio">
              <Select id="floor-prio" options={[{ value: "all", label: "any" }, ...["P0", "P1", "P2", "P3"].map((x) => ({ value: x, label: x }))]} value={prio} onChange={setPrio} />
            </Field>
          </div>
          <Btn label="Routes by class" icon="branch" id="floor-routes-toggle" aria-expanded={routes} aria-controls="floor-routes" onClick={() => setRoutes(!routes)} />
        </FilterBar>
        <div className="fl-legend" aria-label="Gate legend">
          {legend("clear", "clear")}
          {legend("waiting", "waiting on people")}
          {legend("failing", "failing")}
          {legend("off", "off")}
          <span className="faint">Only problems are coloured.</span>
        </div>
        {routes || prefs.activeClass ? (
          <div className="fl-routes" id="floor-routes" role="group" aria-label="Class routes. Hover to preview, select to pin">
            <span className="fl-routes-l">Routes</span>
            {classes.map((c) => (
              <RoutePill key={c.id} id={c.id} hover={hover} onHover={setHover} />
            ))}
          </div>
        ) : null}
      </div>
      <div className="fl-grid-wrap">
        <div className="fl-grid" style={{ "--n": line.length } as CSSProperties}>
          <div className="fl-head" role="group" aria-label="Stations and gates, in order">
            <div className="fl-head-lbl">Work order</div>
            {line.map((sid) => (
              <StationHead key={sid} sid={sid} onStation={onStation} onGate={onGate} gates={gates} bypassed={!!route && !route.includes(sid)} />
            ))}
          </div>
          <div className="fl-sec-h">
            <span className="fl-sec-t">On the line</span>
            <span className="chip mono" id="floor-online-count">{String(onLine.length)}</span>
          </div>
          {onLine.length ? (
            <ol className="fl-rows" aria-label="Work orders on the line">
              {onLine.map((w) => <WoRow key={w.id} w={w} line={line} onGate={onGate} />)}
            </ol>
          ) : (
            <p className="fl-quiet muted small">{filteredOut ? "No work order on the line matches." : "Nothing is moving through the stations right now."}</p>
          )}
        </div>
      </div>
      <Shipped />
      <Bays />
      <p className="fl-foot faint small">{`${line.filter((sid) => p.flow.stations[sid]?.enabled).length} stations and ${gatesOn} gates on · flow version ${ctx.floor.flowVersion}.`}</p>
    </section>
  );
}

export { FloorCtx, openEntry, since, bayName, gateHaveNeed, classOf, ClassChip };
