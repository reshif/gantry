/**
 * The belt of the floor: the "Line drawing" panel (Line.tsx) with the route legend and the side bays under it. Under 700 px the drawing is a
 * stacked list of the same stations. Hover and focus-on-me state live in the Floor view; this component draws them.
 */
import { useState } from "react";
import { flowOf, fmt, route as routeOf } from "@gantry/domain";
import { Btn, Panel } from "../../ui/primitives";
import { useMe } from "../../api/queries";
import { updatePrefs, usePrefs } from "../../lib/prefs";
import { ClassChip, classOf } from "../projects/kit";
import { FloorCtx, bayName, gateHaveNeed, openEntry, since, useFloorCtx } from "./kit";
import { LineDrawing, LineStack, useNarrow, type LineHandlers } from "./Line";
import type { FloorModel } from "./model";

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

export function Belt({ model, h, focus, showHint }: { model: FloorModel; h: Omit<LineHandlers, "route">; focus: boolean; showHint?: boolean }) {
  const ctx = useFloorCtx();
  const prefs = usePrefs();
  const [hover, setHover] = useState<string | null>(null);
  const [routes, setRoutes] = useState(false);
  const [holder, narrow] = useNarrow();
  const p = ctx.project;
  const classes = flowOf(ctx.cat, p).classes;
  const activeCls = hover ?? prefs.activeClass;
  const route = activeCls ? routeOf(ctx.cat, p, activeCls) : null;
  const handlers: LineHandlers = { ...h, route };
  const tools = (
    <>
      {showHint === false ? null : <span className="fp-hint mono">balloon no. = end of the WO number · figure below = time waiting · click a balloon, gate or bay</span>}
      <Btn label="Routes" id="floor-routes-toggle" title="Show the route of each work class" aria-pressed={routes} aria-controls="floor-routes" onClick={() => setRoutes(!routes)} />
    </>
  );
  const bays = flowOf(ctx.cat, p).bays;
  return (
    <>
      <Panel title="Line drawing" cls={`fl-belt fp-sheetp${activeCls ? " has-route" : ""}${focus ? " is-focus" : ""}`} tools={tools} flush id="floor-line">
        <div id="floor-belt" ref={holder} aria-label={`Line for ${p.name}`} data-active={prefs.activeClass ?? ""} className="fp-drawing">
          {routes || prefs.activeClass ? (
            <div className="fl-routes" id="floor-routes" role="group" aria-label="Class routes. Hover to preview, select to pin">
              <span className="fl-routes-l">Routes</span>
              {classes.map((c) => (
                <RoutePill key={c.id} id={c.id} hover={hover} onHover={setHover} />
              ))}
            </div>
          ) : null}
          {narrow ? <LineStack model={model} h={handlers} /> : <LineDrawing model={model} h={handlers} />}
        </div>
      </Panel>
      <div className="fp-bays" aria-label="Side bays">
        <span className="fp-bays-l mono">SIDE BAYS</span>
        {bays.map((b) => {
          const n = ctx.wos.filter((w) => w.bay === b.id && w.state !== "killed" && w.state !== "done").length;
          return (
            <Btn key={b.id} label={`${b.name} ${n}`} small kind="ghost" id={`floor-bayc-${b.id}`} title={b.desc} onClick={() => h.onBay("", b.id)} />
          );
        })}
      </div>
    </>
  );
}

export { FloorCtx, openEntry, since, bayName, gateHaveNeed, classOf, ClassChip };
