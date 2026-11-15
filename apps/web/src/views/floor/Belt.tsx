/**
 * The belt of the floor: the project's line drawn top to bottom, one row per station and one row per gate
 * between them, ending in Shipped, with the bays (work that left the line) underneath. The line never wraps
 * back on itself, and every gate has room for its full name, state and who must act (docs/ui/design-system.md §1).
 */
import { Fragment, useState, type CSSProperties } from "react";
import { DAY, approvalText, flowOf, gateDef, gateExplain, gateKind, gateKindText, gateStateText, gateTitle, route as routeOf, routeGates as routeGatesOf, fmt, type Gate } from "@gantry/domain";
import { useAgents, useMcpServers, useMe } from "../../api/queries";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { updatePrefs, usePrefs } from "../../lib/prefs";
import { ClassChip, classOf } from "../projects/kit";
import {
  FloorCtx, WoToken, bayName, gateHaveNeed, mcpFor, gateOfStation, gateStateOf, isLive, layoutFor, openEntry, since, stationIdx, useFloorCtx, type FWo,
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

/* ---------- stations ---------- */

function Staffing({ sid }: { sid: string }) {
  const ctx = useFloorCtx();
  const agents = useAgents().data;
  const mcp = useMcpServers().data;
  const st = ctx.cat.stations.find((s) => s.id === sid);
  if (!st) return null;
  const ag = agents?.find((a) => a.id === st.agent);
  const n = mcpFor(ctx.project, sid, mcp).length;
  const g = gateOfStation(ctx.cat, ctx.project, sid);
  const human = g && gateKind(ctx.cat, ctx.project, g.id) !== "auto" && (ctx.project.flow.gates[g.id]?.enabled || g.id === "G0G1");
  return (
    <div className="fl-staff">
      <span className="fl-glyph" title={`Agent: ${ag?.name ?? st.agent}`}>
        <Icon name="agent" />
        <span className="sr">Agent </span>
        {ag?.name ?? st.agent}
      </span>
      <span className="fl-glyph" title={`${n} MCP servers allowed here`}>
        <Icon name="tool" />
        <span className="sr">MCP servers </span>
        {String(n)}
      </span>
      {human && g ? (
        <span className="fl-glyph is-human" title={gateExplain(g, gateKind(ctx.cat, ctx.project, g.id))}>
          <Icon name="human" />
          <span className="sr">{`${gateKindText(gateKind(ctx.cat, ctx.project, g.id))} gate, `}</span>
          {g.name}
        </span>
      ) : null}
    </div>
  );
}

function haltedRepoName(ctx: ReturnType<typeof useFloorCtx>, w: FWo): string | null {
  const r = ctx.repos.find((x) => x.id === w.repo);
  if (ctx.replay) return ctx.replay.state.haltedRepos[w.repo] ? (r?.name ?? w.repo) : null;
  return r?.halted ? r.name : null;
}

function StationCard({ sid, onStation, route, name }: { sid: string; onStation: (sid: string) => void; route: string[] | null; name: string }) {
  const bypassed = !!route && !route.includes(sid);
  const ctx = useFloorCtx();
  const L = layoutFor(ctx.cat, ctx.project);
  const st = ctx.cat.stations.find((s) => s.id === sid);
  const conf = ctx.project.flow.stations[sid];
  if (!st || !conf) return null;
  const i = stationIdx(ctx.cat, sid);
  const here = ctx.wos.filter((w) => w.station === i && !w.bay && w.state !== "done");
  const live = here.filter(isLive);
  const show = [...live, ...here.filter((w) => w.state === "killed")];
  const over = conf.enabled && live.length > conf.wip;
  const max = 4;
  const holders = ctx.floor.slots.holders;
  const busyFor = (n: number): string | null => {
    if (ctx.replay) {
      const list = ctx.wos.filter((w) => w.station === stationIdx(ctx.cat, "build") && !w.bay && w.state === "running").slice(0, ctx.project.flow.slots);
      return list[n - 1]?.id ?? null;
    }
    return holders.find((h) => h.slot === n)?.wo ?? null;
  };
  const queued = ctx.wos.filter((x) => x.bay === "queue" && isLive(x)).length;
  return (
    <section className={`fl-st${conf.enabled ? "" : " is-off"}${over ? " is-over" : ""}${sid === "build" ? " is-build" : ""}${bypassed ? " is-bypassed" : ""}`} data-station={sid} style={{ "--o": L.order[sid] } as CSSProperties} aria-label={`${st.no} ${st.name}`}>
      <button type="button" className="fl-st-head" id={`floor-st-${sid}`} aria-label={`${st.no} ${st.name}: ${live.length} in progress, limit ${conf.wip}. Open station details`} onClick={() => onStation(sid)}>
        <span className="fl-st-no mono">{st.no}</span>
        <span className="fl-st-name">{st.name}</span>
        <span className={`fl-wip mono${over ? " is-over" : ""}`}>{conf.enabled ? `${live.length}/${conf.wip}` : "off"}</span>
      </button>
      <Staffing sid={sid} />
      {!conf.enabled ? <p className="fl-off">Off in this project. Work passes by.</p> : null}
      {sid === "build" && conf.enabled ? (
        <ul className="fl-slots" aria-label="Coding slots">
          {Array.from({ length: ctx.project.flow.slots }, (_, k) => {
            const wo = busyFor(k + 1);
            return (
              <li key={k} className={`fl-slot${wo ? " is-busy" : ""}`}>
                <span className="fl-slot-k">{`coding slot ${k + 1} of ${ctx.project.flow.slots}`}</span>
                <span className="mono fl-slot-v">{wo ?? "free"}</span>
              </li>
            );
          })}
          {queued ? (
            <li className="fl-slot is-queue">
              <span className="fl-slot-k">queue</span>
              <span className="mono fl-slot-v">{`${queued} waiting`}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="fl-toks">
        {show.slice(0, max).map((w) => (
          <WoToken key={w.id} w={w} idPrefix="floor-tok-" halted={haltedRepoName(ctx, w)} />
        ))}
        {show.length > max ? <Btn label={`+${show.length - max} more at ${st.name}`} small kind="ghost" id={`floor-more-${sid}`} onClick={() => onStation(sid)} /> : null}
        {!show.length && conf.enabled ? <p className="fl-idle">idle</p> : null}
      </div>
      <span className="fl-bypass" aria-hidden="true">{bypassed ? `${name} skips this station` : ""}</span>
    </section>
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

function useBeltStatus(): { cls: string; label: string; icon: string } {
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
      aria-pressed={active ? "true" : "false"}
      data-cls={id}
      onClick={() => updatePrefs((p) => ({ activeClass: p.activeClass === id ? null : id }))}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
    >
      <span className="cls-mark" aria-hidden="true" />
      <span>{text}</span>
    </button>
  );
}

export function Belt({ onStation, onGate }: { onStation: (sid: string) => void; onGate: (gid: string) => void }) {
  const ctx = useFloorCtx();
  const prefs = usePrefs();
  const me = useMe();
  const status = useBeltStatus();
  const [hover, setHover] = useState<string | null>(null);
  const p = ctx.project;
  const L = layoutFor(ctx.cat, p);
  const classes = flowOf(ctx.cat, p).classes;
  const activeCls = hover ?? prefs.activeClass;
  const route = activeCls ? routeOf(ctx.cat, p, activeCls) : null;
  const gates = activeCls ? routeGatesOf(ctx.cat, p, activeCls) : null;
  const name = activeCls ? classOf(ctx.cat, p, activeCls).name : "";
  const repoHalts = ctx.replay
    ? Object.keys(ctx.replay.state.haltedRepos).map((id) => ({ name: ctx.repos.find((r) => r.id === id)?.name ?? id, reason: ctx.replay?.state.haltedRepos[id]?.text ?? "" }))
    : ctx.repos.filter((r) => r.halted).map((r) => ({ name: r.name, reason: r.halted?.reason ?? "" }));
  const line = [...L.top, ...L.bottom];

  const legend = (state: string, text: string) => (
    <span key={state} className={`fl-leg gate-${state}`}>
      <span className="fl-leg-d" aria-hidden="true" />
      {text}
    </span>
  );
  void me;
  return (
    <section className={`fl-belt ${status.cls}${activeCls ? " has-route" : ""}`} id="floor-belt" aria-label={`Belt for ${p.name}. ${status.label}`} data-active={prefs.activeClass ?? ""}>
      <div className="fl-belt-head">
        <div className="fl-stamp">
          <Icon name={status.icon} />
          <span>{status.label}</span>
        </div>
        {repoHalts.length ? (
          <div className="fl-halts">
            {repoHalts.map((r) => (
              <span key={r.name} className="chip chip-block" title={r.reason}>
                <Icon name="halt" />
                {` ${r.name} halted`}
              </span>
            ))}
          </div>
        ) : null}
        <div className="fl-legend" aria-label="Gate legend">
          {legend("clear", "clear")}
          {legend("waiting", "waiting on people")}
          {legend("failing", "failing")}
          {legend("off", "off")}
        </div>
      </div>
      <div className="fl-routes" role="group" aria-label="Class routes. Hover to preview, select to pin">
        <span className="fl-routes-l">Routes</span>
        {classes.map((c) => (
          <RoutePill key={c.id} id={c.id} hover={hover} onHover={setHover} />
        ))}
      </div>
      <ol className="fl-line" aria-label="Stations and gates, in order">
        {line.map((sid) => {
          const g = gateOfStation(ctx.cat, p, sid);
          return (
            <Fragment key={sid}>
              <li className="fl-line-item">
                <StationCard sid={sid} onStation={onStation} route={route} name={name} />
              </li>
              {g ? (
                <li className="fl-line-item fl-line-gate">
                  <GateNode gid={g.id} onOpen={onGate} gates={gates} />
                </li>
              ) : (
                <li className="fl-line-item fl-line-link" aria-hidden="true" />
              )}
            </Fragment>
          );
        })}
        <li className="fl-line-item">
          <Shipped />
        </li>
      </ol>
      <Bays />
    </section>
  );
}

export { FloorCtx, openEntry, since, bayName, gateHaveNeed, classOf, ClassChip };
