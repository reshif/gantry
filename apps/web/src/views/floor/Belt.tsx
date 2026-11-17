/**
 * The belt of the floor (Blueprint prototype): one panel holding the production-line schematic (SVG, see Schematic.tsx) with the density
 * switch and the class routes, then the side bays as cards. Gates are valves between stations; work orders are tags in a tray under their station.
 */
import { useState } from "react";
import { flowOf, fmt, route as routeOf } from "@gantry/domain";
import { Btn, Panel } from "../../ui/primitives";
import { useMe } from "../../api/queries";
import { updatePrefs, usePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { ClassChip, classOf } from "../projects/kit";
import { FloorCtx, bayName, gateHaveNeed, openEntry, since, useFloorCtx } from "./kit";
import { Schematic } from "./Schematic";
import { useQueryParam } from "./urlState";

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

export function Belt({ onStation, onGate, onOut }: { onStation: (sid: string) => void; onGate: (gid: string) => void; onOut: () => void }) {
  const ctx = useFloorCtx();
  const prefs = usePrefs();
  const open = useOpenTraveler();
  const [hover, setHover] = useState<string | null>(null);
  const [routes, setRoutes] = useState(false);
  const [density, setDensity] = useQueryParam("density");
  const p = ctx.project;
  const classes = flowOf(ctx.cat, p).classes;
  const activeCls = hover ?? prefs.activeClass;
  const route = activeCls ? routeOf(ctx.cat, p, activeCls) : null;
  const detail = density === "detail";
  const tools = (
    <>
      <Btn label="Routes by class" icon="branch" small kind="ghost" id="floor-routes-toggle" aria-expanded={routes} aria-controls="floor-routes" onClick={() => setRoutes(!routes)} />
      <div className="seg" role="group" aria-label="Density">
        {([["fit", "Fit", "Compact tags so the whole line fits one screen"], ["detail", "Detail", "One tag per row with title and state"]] as const).map(([v, l, t]) => (
          <Btn key={v} label={l} title={t} aria-pressed={(detail ? "detail" : "fit") === v} onClick={() => setDensity(v === "fit" ? null : v)} />
        ))}
      </div>
    </>
  );
  const bays = flowOf(ctx.cat, p).bays;
  return (
    <>
      <Panel title="Production line" cls={`fl-belt floor${activeCls ? " has-route" : ""}`} tools={tools} flush>
        <div id="floor-belt" aria-label={`Line for ${p.name}`} data-active={prefs.activeClass ?? ""}>
          {routes || prefs.activeClass ? (
            <div className="fl-routes" id="floor-routes" role="group" aria-label="Class routes. Hover to preview, select to pin">
              <span className="fl-routes-l">Routes</span>
              {classes.map((c) => (
                <RoutePill key={c.id} id={c.id} hover={hover} onHover={setHover} />
              ))}
            </div>
          ) : null}
          <Schematic detail={detail} route={route} onStation={onStation} onGate={onGate} onWo={open} onOut={onOut} />
          <div className="flegend" aria-label="Legend">
            <span className="lg"><i className="run" />Running</span>
            <span className="lg"><i className="wait" />At a gate (person approves)</span>
            <span className="lg"><i className="bad" />Stuck (blocked or failed)</span>
            <span className="lg"><i className="valve" />Valve: solid = person, dashed = automatic check</span>
            <span className="lg"><i className="hop" />Hopper = work in progress against the limit, red when over</span>
            <span className="lg"><i className="rw" />Rework return line</span>
          </div>
        </div>
      </Panel>
      <Panel title="Side bays" cls="fl-bays">
        <div className="card-grid" aria-label="Off the line">
          {bays.map((b) => {
            const list = ctx.wos.filter((w) => w.bay === b.id && w.state !== "killed");
            const shown = b.id === "declined" ? list.slice(-3) : list;
            return (
              <div key={b.id} className={`card fl-bay fl-bay-${b.id}${list.length ? " has-work" : ""}`} data-bay={b.id}>
                <div className="row fl-bay-h">
                  <h3 className="fl-bay-n">{b.name}</h3>
                  <span className="spacer" />
                  <span className={`chip ${list.length ? "warn" : "plain"} fl-bay-c`}>{String(list.length)}</span>
                </div>
                <div className="small muted">{b.desc}</div>
                {shown.map((w) => (
                  <div key={w.id} className="row small" data-wo={w.id}>
                    <Btn label={w.id} kind="ghost" small id={`floor-bay-${w.id}`} onClick={() => open(w.id)} />
                    <span className="trunc grow">{w.title}</span>
                  </div>
                ))}
                {b.id === "declined" && list.length > 3 ? <span className="muted small">{`${list.length - 3} older`}</span> : null}
              </div>
            );
          })}
        </div>
      </Panel>
      <p className="fl-foot faint small">{`${p.flow.order.filter((sid) => p.flow.stations[sid]?.enabled).length} stations on · flow version ${ctx.floor.flowVersion}.`}</p>
    </>
  );
}

export { FloorCtx, openEntry, since, bayName, gateHaveNeed, classOf, ClassChip };
