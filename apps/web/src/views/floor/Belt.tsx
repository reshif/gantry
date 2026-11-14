/** The belt of the floor: serpentine conveyor of stations with gates, the bays and the shipped strip (legacy floor.js belt). */
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DAY, flowOf, gateDef, gateKind, route as routeOf, routeGates as routeGatesOf, fmt, type Gate } from "@gantry/domain";
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
  const cap = gs.state === "off" ? "off" : gs.state === "failing" ? `${gs.failing} failing` : gs.state === "waiting" ? `${gs.waiting} waiting` : "clear";
  const need = gateKind(ctx.cat, ctx.project, gid) !== "auto" && gs.state !== "off" ? (gid === "G0G1" ? "submitter" : `needs ${rule ? rule.required : 1}`) : null;
  const tr = gs.state !== "off" ? gateTrustSummary(ctx, gid) : null;
  const base = `${g.label} ${g.name}: ${gs.state === "waiting" ? `${count} waiting on approvers` : gs.state === "failing" ? `${count} failing` : gs.state === "off" ? "off in this project" : "clear"}`;
  const label = tr ? `${base}. ${tr.tip}` : base;
  return (
    <div className={`fl-gate fl-gate-${gs.state}${tr && tr.mode === "trust" ? " is-trusted" : ""}${gates && !gates.includes(gid) ? " is-offroute" : ""}`} data-gate={gid} style={{ "--o": L.order[gid] } as CSSProperties}>
      <button type="button" id={`floor-gate-${gid}`} className={`gate gate-${gs.state} gate-md gate-kind-${g.kind}`} aria-label={label} data-tip={label} onClick={() => onOpen(gid)}>
        <span className="gate-shape" aria-hidden="true">
          <span className="gate-count">{gs.state === "waiting" ? String(count) : gs.state === "failing" ? "!" : gs.state === "off" ? "–" : "✓"}</span>
        </span>
        <span className="gate-label mono">{g.label}</span>
      </button>
      <span className="fl-gate-cap mono">
        {cap}
        {need ? <span className="fl-gate-need">{need}</span> : null}
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
        <span className="fl-glyph is-human" title={`A person approves ${g.label}`}>
          <Icon name="human" />
          <span className="sr">Human gate </span>
          {g.label}
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
      <span className="fl-bypass" aria-hidden="true">{bypassed ? `Bypassed by ${name}` : ""}</span>
    </section>
  );
}

/* ---------- bays and shipped ---------- */

function Bays() {
  const ctx = useFloorCtx();
  const bays = flowOf(ctx.cat, ctx.project).bays;
  return (
    <section className="fl-bays" aria-label="Off the main belt" style={{ "--bays": Math.min(6, bays.length) } as CSSProperties}>
      <div className="fl-bays-h">
        <span className="fl-bays-t">Off the main belt</span>
        <span className="muted small">bays hold work that left the belt; it returns to the station it came from</span>
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

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** SVG conveyor layer, measured from the laid-out cards (legacy drawBelt). */
function drawBelt(beltEl: HTMLElement, ctx: ReturnType<typeof useFloorCtx>, cls: string | null): void {
  const stage = beltEl.querySelector<HTMLElement>(".fl-stage");
  const holder = beltEl.querySelector<HTMLElement>(".fl-svg");
  if (!stage || !holder) return;
  const sr = stage.getBoundingClientRect();
  if (!sr.width) return;
  const box = (sel: string) => {
    const el = stage.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left - sr.left, t: r.top - sr.top, w: r.width, h: r.height, cx: r.left - sr.left + r.width / 2, cy: r.top - sr.top + r.height / 2, r: r.right - sr.left, b: r.bottom - sr.top };
  };
  const grid = stage.querySelector<HTMLElement>(".fl-grid");
  const vertical = !!grid && getComputedStyle(grid).getPropertyValue("--vertical").trim() === "1";
  const W = Math.round(sr.width);
  const H = Math.round(stage.scrollHeight);
  const L = layoutFor(ctx.cat, ctx.project);
  let s = "";
  let d = "";
  const arrows: Array<[number, number, number]> = [];
  if (vertical) {
    const first = box('[data-station="intake"]');
    const last = box("[data-ship]");
    if (!first || !last) {
      holder.innerHTML = "";
      return;
    }
    const gx = box('[data-gate="G0G1"] .gate-shape');
    const x = gx ? Math.round(gx.cx) : 18;
    d = `M${x} ${first.t + 10} V${last.t + 8}`;
    for (const id of ["research", "plan", "verify", "close"]) {
      const b = box(`[data-station="${id}"]`);
      if (b) arrows.push([x, b.t - 8, 90]);
    }
  } else {
    const intake = box(`[data-station="${L.top[0]}"]`);
    const ship = box("[data-ship]");
    const plan = box(`[data-station="${L.top[L.top.length - 1]}"]`);
    const build = box(`[data-station="${L.bottom[0]}"]`);
    const close = box(`[data-station="${L.bottom[L.bottom.length - 1]}"]`);
    if (!intake || !ship || !plan || !build || !close) {
      holder.innerHTML = "";
      return;
    }
    const g0 = box(".fl-top .fl-gate .gate-shape");
    const turn = box(".fl-turn .gate-shape");
    const g4 = box(".fl-bottom .fl-gate .gate-shape");
    const g6 = box(".fl-g6 .gate-shape");
    const yT = g0 ? g0.cy : intake.t + 40;
    const xT = turn ? turn.cx : plan.r + 32;
    const yB = g4 ? g4.cy : build.t + 40;
    const xG = g6 ? g6.cx : close.cx;
    const R = 18;
    const g6t = g6 ? g6.t : close.b + 20;
    d = `M${intake.l - 6} ${yT} H${xT - R} Q${xT} ${yT} ${xT} ${yT + R} V${yB - R} Q${xT} ${yB} ${xT - R} ${yB} H${xG + R} Q${xG} ${yB} ${xG} ${yB + R} V${ship.t + 6}`;
    arrows.push([(plan.r + xT) / 2, yT, 0], [xT, (yT + yB) / 2 - 40, 90], [xT, (yT + yB) / 2 + 40, 90], [(build.r + xT) / 2, yB, 180], [xG, (close.b + g6t) / 2, 90]);
    if (cls) {
      const route = routeOf(ctx.cat, ctx.project, cls);
      const klass = classOf(ctx.cat, ctx.project, cls);
      const name = klass.name;
      const pill = (x: number, y: number, text: string) => {
        const w = Math.max(60, text.length * 6.1 + 16);
        return `<g class="fl-pill"><rect x="${(x - w / 2).toFixed(1)}" y="${(y - 9).toFixed(1)}" width="${w.toFixed(1)}" height="18" rx="9"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${esc(text)}</text></g>`;
      };
      let bypass = "";
      [L.top, L.bottom].forEach((row, ri) => {
        let k = 0;
        while (k < row.length) {
          if (route.includes(row[k] as string)) {
            k++;
            continue;
          }
          let j = k;
          while (j < row.length && !route.includes(row[j] as string)) j++;
          const a = box(`[data-station="${row[k]}"]`);
          const b = box(`[data-station="${row[j - 1]}"]`);
          if (!a || !b) {
            k = j;
            continue;
          }
          const label = `${name} skips ${row.slice(k, j).map((sid) => ctx.cat.stations.find((x) => x.id === sid)?.name ?? sid).join(", ")}`;
          const ends = (j >= row.length && ri === 1) || (!!klass.endsAfter && stationIdx(ctx.cat, row[k] as string) > stationIdx(ctx.cat, klass.endsAfter));
          if (ri === 0) {
            const x1 = a.l - 10;
            const x2 = b.r + 10;
            const y = a.t + 4;
            const top = a.t - 22;
            bypass += `<path d="M${x1} ${y + 10} C${x1} ${top} ${x2} ${top} ${x2} ${y + 10}" class="fl-bypass-arc"/>` + pill((x1 + x2) / 2, top + 3, ends ? `${name} ends here` : label);
          } else {
            const l = Math.min(a.l, b.l) - 10;
            const r = Math.max(a.r, b.r) + 10;
            const yb = a.b - 4;
            const bot = a.b + 22;
            bypass += `<path d="M${r} ${yb - 10} C${r} ${bot} ${l} ${bot} ${l} ${yb - 10}" class="fl-bypass-arc"/>` + pill((l + r) / 2, bot - 3, ends ? `${name} ends before here` : label);
          }
          k = j;
        }
      });
      s += "\u0000" + bypass;
    }
  }
  const tail = s.includes("\u0000") ? s.split("\u0000")[1] : "";
  let out = `<path d="${d}" class="fl-band"/><path d="${d}" class="fl-rollers"/><path d="${d}" class="fl-center"/>`;
  for (const a of arrows) out += `<path d="M-4 -5 L4 0 L-4 5" class="fl-arrow" transform="translate(${a[0].toFixed(1)} ${a[1].toFixed(1)}) rotate(${a[2]})"/>`;
  out += tail;
  holder.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${out}</svg>`;
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
  const beltRef = useRef<HTMLElement>(null);
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
  const bottomVisual = [...L.bottom].reverse();
  const turnGate = gateOfStation(ctx.cat, p, L.top[L.top.length - 1] as string);
  const lastGate = gateOfStation(ctx.cat, p, L.bottom[L.bottom.length - 1] as string);
  const colsFor = (kids: Array<{ kind: "gate" | "link" | "build" | "st" }>) => kids.map((k) => (k.kind === "gate" ? "60px" : k.kind === "link" ? "24px" : k.kind === "build" ? "minmax(0, 1.6fr)" : "minmax(0, 1fr)")).join(" ");
  const topKids: Array<{ kind: "gate" | "link" | "build" | "st" }> = [];
  L.top.forEach((sid, k) => {
    topKids.push({ kind: sid === "build" ? "build" : "st" });
    if (k < L.top.length - 1) topKids.push({ kind: gateOfStation(ctx.cat, p, sid) ? "gate" : "link" });
  });
  const botKids: Array<{ kind: "gate" | "link" | "build" | "st" }> = [];
  bottomVisual.forEach((sid, k) => {
    if (k > 0) botKids.push({ kind: gateOfStation(ctx.cat, p, sid) && gateOfStation(ctx.cat, p, sid)?.id !== "G6" ? "gate" : "link" });
    botKids.push({ kind: sid === "build" ? "build" : "st" });
  });
  const custom = L.bottom.length !== 4 || L.top.length !== 5;

  useLayoutEffect(() => {
    const el = beltRef.current;
    if (!el) return;
    drawBelt(el, ctx, activeCls);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => drawBelt(el, ctx, activeCls)) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  });

  const legend = (state: string, text: string) => (
    <span key={state} className={`fl-leg gate-${state}`}>
      <span className="fl-leg-d" aria-hidden="true" />
      {text}
    </span>
  );
  void me;
  return (
    <section ref={beltRef} className={`fl-belt ${status.cls}${activeCls ? " has-route" : ""}`} id="floor-belt" aria-label={`Belt for ${p.name}. ${status.label}`} data-active={prefs.activeClass ?? ""}>
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
      <div className="fl-stage" data-keep-scroll="floor-belt">
        <div className="fl-svg" aria-hidden="true" />
        <BeltGrid
          custom={custom}
          dense={Math.max(L.top.length, L.bottom.length) > 5 || L.bottom.length > 4 || L.top.length > 5}
          topCols={custom ? colsFor(topKids) : undefined}
          botCols={custom ? colsFor(botKids) : undefined}
          route={route}
          gates={gates}
          name={name}
        >
          <div className="fl-row fl-top">
            {L.top.map((sid, k) => {
              const g = gateOfStation(ctx.cat, p, sid);
              return (
                <Fragment key={sid}>
                  <StationCard sid={sid} onStation={onStation} route={route} name={name} />
                  {k < L.top.length - 1 ? g ? <GateNode gid={g.id} onOpen={onGate} gates={gates} /> : <div className="fl-link" aria-hidden="true" /> : null}
                </Fragment>
              );
            })}
          </div>
          <div className="fl-turn">{turnGate ? <GateNode gid={turnGate.id} onOpen={onGate} gates={gates} /> : null}</div>
          <Bays />
          <div className="fl-row fl-bottom">
            {bottomVisual.map((sid, k) => {
              const g = gateOfStation(ctx.cat, p, sid);
              const prev = bottomVisual[k - 1];
              return (
                <Fragment key={sid}>
                  {k > 0 ? (
                    g && g.id !== "G6" ? (
                      <GateNode gid={g.id} onOpen={onGate} gates={gates} />
                    ) : (
                      <div className="fl-link" aria-hidden="true" title={`No gate between ${ctx.cat.stations.find((x) => x.id === sid)?.name} and ${ctx.cat.stations.find((x) => x.id === prev)?.name}`} />
                    )
                  ) : null}
                  <StationCard sid={sid} onStation={onStation} route={route} name={name} />
                </Fragment>
              );
            })}
          </div>
          <div className="fl-row fl-g6">{lastGate ? <GateNode gid={lastGate.id} onOpen={onGate} gates={gates} /> : null}</div>
          <Shipped />
        </BeltGrid>
      </div>
    </section>
  );
}

function BeltGrid({ custom, dense, topCols, botCols, children }: { custom: boolean; dense: boolean; topCols?: string | undefined; botCols?: string | undefined; route: string[] | null; gates: string[] | null; name: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.querySelector<HTMLElement>(".fl-top");
    const bot = el.querySelector<HTMLElement>(".fl-bottom");
    const g6 = el.querySelector<HTMLElement>(".fl-g6");
    if (!custom) {
      for (const x of [top, bot, g6]) x?.style.removeProperty("--cols");
      return;
    }
    if (top && topCols) top.style.setProperty("--cols", topCols);
    if (bot && botCols) bot.style.setProperty("--cols", botCols);
    if (g6 && botCols) g6.style.setProperty("--cols", botCols);
  });
  return (
    <div ref={ref} className={`fl-grid${custom ? " has-custom" : ""}${dense ? " is-dense" : ""}`}>
      {children}
    </div>
  );
}

export { FloorCtx, openEntry, since, bayName, gateHaveNeed, classOf, ClassChip };
