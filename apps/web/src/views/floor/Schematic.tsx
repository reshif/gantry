/**
 * The production-line schematic of the Floor, ported from the Blueprint prototype (js/floor.js drawBelt): an SVG with a conveyor, one block per
 * station (hopper = work in progress against the limit), work-order tags in a tray under it, a named valve per gate, rework return lines and
 * the OUT block. Layout follows the container width. Every figure comes from the floor read (FloorCtx).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAgents } from "../../api/queries";
import { waitingGateId, gateOfStation, isLive, stationIdx, gateStateOf, useFloorCtx, type FWo } from "./kit";

const fit = (t: string, px: number, cw: number): string => {
  const n = Math.max(3, Math.floor(px / cw));
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const GSHORT: Record<string, string> = { G0G1: "Brief", G1f: "Feas.", G2: "Spec", G3d: "Design", G3G3s: "Secure", G4: "Checks", G5: "Merge", G6: "Ship", GC: "Comply" };
const gShort = (g: { id: string; name: string }): string => GSHORT[g.id] ?? String(g.name).split(" ")[0]!.slice(0, 8);

type Kind = "bad" | "wait" | "run" | "idle";
const isStuck = (w: FWo): boolean => w.state === "blocked" || w.state === "failed" || w.state === "killed";
const tagKind = (w: FWo): Kind => (isStuck(w) ? "bad" : w.state === "waiting" ? "wait" : w.state === "running" ? "run" : "idle");
const tagWord = (w: FWo): string => ({ bad: "STUCK", wait: "GATE", run: "RUN", idle: String(w.state).slice(0, 5).toUpperCase() })[tagKind(w)];

type Pt = [number, number];
const pathOf = (pts: Pt[]): string => `M${pts.map((p) => p.join(" ")).join(" L")}`;
const keyOnEnter = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

function Chevrons({ pts, id }: { pts: Pt[]; id: string }) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.abs(pts[i]![0] - pts[i - 1]![0]) + Math.abs(pts[i]![1] - pts[i - 1]![1]);
  const d = pathOf(pts);
  const n = Math.max(1, Math.floor(L / 54));
  const dur = L / 34;
  return (
    <>
      {Array.from({ length: n }, (_, k) => (
        <path key={`${id}-${k}`} d="M-3 -4.5L3 0L-3 4.5" className="f-chev" style={{ offsetPath: `path('${d}')`, offsetDistance: `${(((k + 0.5) / n) * 100).toFixed(1)}%`, animationDuration: `${dur.toFixed(1)}s`, animationDelay: `-${((k / n) * dur).toFixed(2)}s` } as React.CSSProperties} />
      ))}
    </>
  );
}

function Tag({ w, x, y, tw, th, detail, onOpen }: { w: FWo; x: number; y: number; tw: number; th: number; detail: boolean; onOpen: (id: string) => void }) {
  const ctx = useFloorCtx();
  const kind = tagKind(w);
  const cy = y + th / 2;
  const gate = kind === "wait" ? waitingGateId(ctx, w) : null;
  const word = tagWord(w);
  const wordFull = gate ? `${word} ${gate}` : word;
  const open = () => onOpen(w.id);
  const idText = detail || tw >= 72 ? w.id : w.id.replace(/^WO-/, "");
  const wordW = wordFull.length * 6.6 + 8;
  const tx = x + 22 + w.id.length * 6.6 + 8;
  return (
    <g className={`f-tag ${kind}`} tabIndex={0} role="button" aria-label={`${w.id} ${w.title}, ${wordFull}`} data-wo={w.id} id={`floor-tok-${w.id}`} onClick={open} onKeyDown={keyOnEnter(open)}>
      <title>{`${w.id} · ${w.title}\n${gate ? `Waiting at gate ${gate}` : w.state} · ${w.priority} · ${ctx.project.name}`}</title>
      <rect x={x} y={y} width={tw} height={th} rx={2} className="f-tb" />
      {kind === "bad" ? <rect x={x} y={y} width={tw} height={th} rx={2} fill="url(#hatch)" pointerEvents="none" /> : null}
      <rect x={x} y={y} width={17} height={th} rx={2} className="f-bd" />
      {kind === "run" ? <path d={`M${x + 5.5} ${cy - 5} L${x + 12.5} ${cy} L${x + 5.5} ${cy + 5}Z`} className="f-gl" /> : null}
      {kind === "wait" ? <path d={`M${x + 5.5} ${cy - 5}V${cy + 5}M${x + 11.5} ${cy - 5}V${cy + 5}`} className="f-gl s" /> : null}
      {kind === "bad" ? <path d={`M${x + 8.5} ${cy - 5.5}V${cy + 1.5}M${x + 8.5} ${cy + 4.5}V${cy + 5.5}`} className="f-gl s w" /> : null}
      {kind === "idle" ? <circle cx={x + 8.5} cy={cy} r={3} className="f-gl" /> : null}
      <text x={x + 22} y={cy + 4} className="f-id">{idText}</text>
      {detail ? (
        <>
          <text x={tx} y={cy + 4} className="f-ttl">{fit(w.title, tw - (tx - x) - wordW - 6, 6.6)}</text>
          <text x={x + tw - 6} y={cy + 4} textAnchor="end" className={`f-st ${kind}`}>{wordFull}</text>
        </>
      ) : null}
    </g>
  );
}

interface Pos { s?: { id: string; no: string; name: string; agent: string; purpose: string }; out?: boolean; x: number; y: number; row: number; i: number; trayH: number }

export function Schematic({ detail, route, onStation, onGate, onWo, onOut }: { detail: boolean; route: string[] | null; onStation: (sid: string) => void; onGate: (gid: string) => void; onWo: (id: string) => void; onOut: () => void }) {
  const ctx = useFloorCtx();
  const agents = useAgents().data;
  const holder = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const measure = () => setW((prev) => { const w = Math.floor(el.clientWidth); return w && Math.abs(w - prev) >= 6 ? w : prev; });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = W || 960;

  const p = ctx.project;
  const line = p.flow.order.map((id) => ctx.cat.stations.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s && !!p.flow.stations[s.id]?.enabled);
  const by: Record<string, FWo[]> = {};
  for (const s of line) {
    const i = stationIdx(ctx.cat, s.id);
    by[s.id] = ctx.wos.filter((w) => w.station === i && !w.bay && w.state !== "done" && (isLive(w) || w.state === "killed"));
  }
  const done = ctx.wos.filter((w) => w.state === "done" && !w.split);
  const rework: Record<string, number> = {};
  for (const w of ctx.wos) for (const sb of w.sendbacks ?? []) rework[`${sb.from}>${sb.to}`] = (rework[`${sb.from}>${sb.to}`] ?? 0) + 1;

  const items: Array<{ s?: (typeof line)[number]; out?: boolean }> = [...line.map((s) => ({ s })), { out: true }];
  const N = items.length;
  const vertical = width < 640;
  const padL = vertical ? 44 : 30;
  const padR = vertical ? 12 : 82;
  const gapMin = 46;
  let perRow = vertical ? 1 : Math.max(1, Math.floor((width - padL - padR + gapMin) / (136 + gapMin)));
  const rows = Math.ceil(N / perRow);
  perRow = Math.ceil(N / rows);
  const bw = vertical ? width - padL - padR : Math.min(204, (width - padL - padR - (perRow - 1) * gapMin) / perRow);
  const gap = vertical ? 54 : perRow > 1 ? (width - padL - padR - perRow * bw) / (perRow - 1) : 0;
  const BH = 122;
  const laneTop = vertical ? 0 : 34;
  const TH = detail ? 24 : 22;
  const TG = detail ? 3 : 4;
  const tcols = detail ? 1 : bw >= 224 ? 3 : 2;
  const trows = detail ? (vertical ? 4 : 5) : 2;
  const cap = tcols * trows;
  const slotsN = (n: number): number => (n <= cap ? n : detail ? trows + 1 : cap);
  const trayRows = (n: number): number => (!n ? 0 : detail ? Math.min(n, trows) + (n > trows ? 1 : 0) : Math.ceil(slotsN(n) / tcols));
  const pos: Pos[] = [];
  let y = 8;
  for (let r = 0; r < rows; r++) {
    const ids = items.slice(r * perRow, (r + 1) * perRow);
    const rowsNeeded = Math.max(...ids.map((it) => (it.out ? 0 : trayRows(by[it.s!.id]!.length))), 0);
    ids.forEach((it, i) => {
      const tr = vertical ? (it.out ? 0 : trayRows(by[it.s!.id]!.length)) : rowsNeeded;
      const trayH = tr ? tr * (TH + TG) + 10 : 26;
      pos.push({ ...(it.s ? { s: it.s } : {}), ...(it.out ? { out: true } : {}), x: vertical ? padL : padL + i * (bw + gap), y: y + (vertical ? 0 : laneTop), row: r, i, trayH });
      if (vertical) y += BH + trayH + 54;
    });
    if (!vertical) {
      const trayH = rowsNeeded ? rowsNeeded * (TH + TG) + 10 : 26;
      pos.slice(-ids.length).forEach((q) => (q.trayH = trayH));
      y += laneTop + BH + trayH + (r === rows - 1 ? 14 : 54);
    }
  }
  const H = vertical ? y - 54 + 14 : y;
  const Ux = vertical ? 0 : padL + perRow * bw + (perRow - 1) * gap + 68;
  const cy = (q: Pos): number => q.y + BH * 0.5 - 4;

  const segs: Pt[][] = [];
  const arrows: Array<[number, number, number]> = [];
  if (vertical) {
    segs.push([[22, pos[0]!.y - 6], [22, cy(pos[pos.length - 1]!)]]);
    pos.forEach((q) => {
      segs.push([[22, cy(q)], [q.x, cy(q)]]);
      arrows.push([q.x - 2, cy(q), 0]);
    });
  } else {
    segs.push([[12, cy(pos[0]!)], [pos[0]!.x, cy(pos[0]!)]]);
    arrows.push([pos[0]!.x - 2, cy(pos[0]!), 0]);
    pos.forEach((q, k) => {
      const nx = pos[k + 1];
      if (!nx || q.out) return;
      const x2 = q.x + bw;
      if (nx.row === q.row) {
        segs.push([[x2, cy(q)], [nx.x, cy(q)]]);
        arrows.push([nx.x - 2, cy(q), 0]);
      } else {
        const gy = q.y + BH + q.trayH + 26;
        segs.push([[x2, cy(q)], [Ux, cy(q)], [Ux, gy], [14, gy], [14, cy(nx)], [nx.x, cy(nx)]]);
        arrows.push([nx.x - 2, cy(nx), 0], [width / 2, gy, 180], [Ux, (cy(q) + gy) / 2, 90], [14, (gy + cy(nx)) / 2, -90]);
      }
    });
  }

  const blocks: ReactNode[] = [];
  const valves: ReactNode[] = [];
  const reworkLines: ReactNode[] = [];
  const cross: Array<[string, string, number]> = [];
  pos.forEach((q, k) => {
    if (q.out) {
      const ow = Math.min(bw, 150);
      blocks.push(
        <g key="out" className="f-outg" role="button" tabIndex={0} aria-label={`Out: ${done.length} released work order${done.length === 1 ? "" : "s"}`} id="floor-out" style={{ cursor: "pointer" }} onClick={onOut} onKeyDown={keyOnEnter(onOut)}>
          <title>OUT · released work orders</title>
          <rect x={q.x} y={q.y} width={ow} height={BH} className="f-block out" />
          <rect x={q.x} y={q.y} width={ow} height={28} className="f-head out" />
          <text x={q.x + 8} y={q.y + 18} className="f-no">OUT</text>
          <text x={q.x + 40} y={q.y + 18} className="f-name">Released</text>
          <text x={q.x + 12} y={q.y + 76} className="f-big">{done.length}</text>
          <text x={q.x + 12} y={q.y + 96} className="f-txt2">shipped</text>
          <path d={`M${q.x + ow - 40} ${q.y + 56} h24 m-8 -8 l8 8 l-8 8`} className="f-outarr" />
        </g>,
      );
      return;
    }
    const s = q.s!;
    const list = by[s.id]!;
    const ag = agents?.find((a) => a.id === s.agent);
    const lim = p.flow.stations[s.id]?.wip ?? 5;
    const over = Math.max(0, list.length - lim);
    const ratio = list.length / lim;
    const running = list.filter((w) => w.state === "running").length;
    const waiting = list.filter((w) => tagKind(w) === "wait").length;
    const bad = list.filter(isStuck).length;
    const bypassed = !!route && !route.includes(s.id);
    const open = () => onStation(s.id);
    const hx = q.x + 12;
    const hy = q.y + 64;
    const hw = 44;
    const hh = 42;
    const rr = Math.min(1, ratio);
    const tone = over ? "bad" : ratio > 0.8 ? "warn" : "";
    const fillH = rr * (hh - 4);
    const tx = hx + hw + 10;
    const tw2 = bw - (tx - q.x) - 4;
    const ty = q.y + BH + 8;
    const shown = list.length <= cap ? list : list.slice(0, detail ? trows : cap - 1);
    const extra = list.length - shown.length;
    const tgw = detail ? bw - 16 : (bw - 16 - (tcols - 1) * 4) / tcols;
    blocks.push(
      <g key={s.id} className={bypassed ? "f-bypass" : undefined} data-station={s.id}>
        <g role="button" tabIndex={0} id={`floor-st-${s.id}`} aria-label={`${s.name}: ${list.length} work order${list.length === 1 ? "" : "s"}, limit ${lim}${over ? ", over limit" : ""}, agent ${ag?.name ?? "none"}`} style={{ cursor: "pointer" }} onClick={open} onKeyDown={keyOnEnter(open)}>
          <title>{`${s.name} · ${s.purpose}`}</title>
          <rect x={q.x} y={q.y} width={bw} height={BH} className={`f-block${bad ? " jam" : over ? " over" : ""}`} />
          <rect x={q.x} y={q.y} width={bw} height={28} className="f-head" />
          <text x={q.x + 8} y={q.y + 18} className="f-no">{s.no}</text>
          <text x={q.x + 8 + s.no.length * 6.9 + 8} y={q.y + 18} className="f-name">{fit(s.name, bw - 24 - s.no.length * 6.9, 7.4)}</text>
          <circle cx={q.x + 14} cy={q.y + 44} r={4.5} className={`f-lamp ${bad ? "bad" : waiting ? "wait" : running ? "run" : "idle"}`} />
          <text x={q.x + 24} y={q.y + 48} className="f-txt2">{fit(ag?.name ?? "No agent", bw - 34, 6.8)}</text>
          <line x1={q.x} x2={q.x + bw} y1={q.y + 56} y2={q.y + 56} stroke="var(--line)" />
          <path d={`M${hx} ${hy} H${hx + hw} L${hx + hw - 10} ${hy + hh} H${hx + 10} Z`} className={`f-hop${over ? " over" : ""}`} />
          {fillH > 0 ? <path d={`M${hx + 10 - (10 * fillH) / hh} ${hy + hh - 2 - fillH} H${hx + hw - 10 + (10 * fillH) / hh} L${hx + hw - 11} ${hy + hh - 2} H${hx + 11} Z`} className={`f-fill${tone ? ` ${tone}` : ""}`} /> : null}
          <text x={hx + hw / 2} y={hy + hh - 10} textAnchor="middle" className="f-cnt">{list.length}</text>
          <text x={tx} y={hy + 9} className={`f-txt${over ? " bad" : " b"}`}>{fit(over ? `${list.length}/${lim} OVER` : `WIP ${list.length}/${lim}`, tw2 + 6, 6.6)}</text>
          <text x={tx} y={hy + 22} className={`f-txt${over ? " bad" : ""}`}>{fit(over ? `+${over} over limit` : `${Math.round(ratio * 100)}% full`, tw2 + 6, 6.6)}</text>
          {([["run", running, "M0 -5L7 0L0 5Z"], ["wait", waiting, "M1 -5V5M6 -5V5"], ["bad", bad, "M3.5 -5.5V1.5M3.5 4.5V5.5"]] as const).map(([kd, n, d], i) => (
            <g key={kd}>
              <path d={d} transform={`translate(${tx + i * 24} ${hy + 37})`} className={`f-mini ${kd}${n ? " on" : ""}`} />
              <text x={tx + i * 24 + 10} y={hy + 41} className={`f-txt${n ? (kd === "bad" ? " bad" : " b") : ""}`}>{n}</text>
            </g>
          ))}
          <title>{`${s.name}: ${running} running, ${waiting} at a gate, ${bad} stuck. WIP ${list.length} of limit ${lim}.`}</title>
        </g>
        {!list.length ? <text x={q.x + 4} y={ty + 12} className="f-txt">idle · nothing queued</text> : null}
        {shown.map((w, j) => {
          const c = detail ? 0 : j % tcols;
          const r = detail ? j : Math.floor(j / tcols);
          return <Tag key={w.id} w={w} x={q.x + 8 + c * (tgw + 4)} y={ty + r * (TH + TG)} tw={tgw} th={TH} detail={detail} onOpen={onWo} />;
        })}
        {extra > 0 ? (() => {
          const j = shown.length;
          const c = detail ? 0 : j % tcols;
          const r = detail ? j : Math.floor(j / tcols);
          const mx = q.x + 8 + c * (tgw + 4);
          const my = ty + r * (TH + TG);
          return (
            <g className="f-tag more" tabIndex={0} role="button" aria-label={`${extra} more at ${s.name}`} onClick={open} onKeyDown={keyOnEnter(open)}>
              <title>{`${extra} more work orders at ${s.name}`}</title>
              <rect x={mx} y={my} width={tgw} height={TH} rx={2} className="f-tb" />
              <text x={mx + tgw / 2} y={my + TH / 2 + 4} textAnchor="middle" className="f-id" style={{ fill: "var(--accent)" }}>{`+${extra} more`}</text>
            </g>
          );
        })() : null}
      </g>,
    );
    const gate = gateOfStation(ctx.cat, p, s.id);
    if (gate) {
      const gs = gateStateOf(ctx, gate.id);
      const wcount = gs.waiting;
      const nx = pos[k + 1];
      let vx: number;
      let vy: number;
      if (vertical) {
        vx = 22;
        vy = q.y + BH + q.trayH + 27;
      } else {
        vy = cy(q);
        vx = nx && nx.row === q.row ? q.x + bw + gap / 2 : q.x + bw + 32;
      }
      const kindCls = gs.state === "off" ? " off" : gs.failing ? " bad" : wcount ? " wait" : gate.kind === "auto" ? " auto" : "";
      const label = `${gate.label} · ${gate.name} (${gate.kind === "auto" ? "automatic check" : gate.kind === "mixed" ? "check plus person" : "a person approves"})${wcount ? ` · ${wcount} waiting` : ""}${gs.failing ? ` · ${gs.failing} failing` : ""}`;
      const openG = () => onGate(gate.id);
      valves.push(
        <g key={`v-${gate.id}`} className={`f-valve${kindCls}${route && !route.includes(s.id) ? " f-bypass" : ""}`} data-gate={gate.id} id={`floor-gate-${gate.id}`} tabIndex={0} role="button" style={{ cursor: "pointer" }} aria-label={`Gate ${gate.label} ${gate.name}, ${gate.kind}, ${gs.state === "off" ? "off" : `${wcount} waiting`}`} onClick={openG} onKeyDown={keyOnEnter(openG)}>
          <title>{label}</title>
          {wcount ? <circle cx={vx} cy={vy} r={13} className="f-pulse" /> : null}
          <line x1={vx} x2={vx} y1={vy - 9} y2={vy - 19} stroke="var(--ink2)" strokeWidth={1.5} />
          <line x1={vx - 6} x2={vx + 6} y1={vy - 19} y2={vy - 19} stroke="var(--ink2)" strokeWidth={2} />
          <circle cx={vx} cy={vy} r={9} />
          {wcount ? <text x={vx} y={vy + 4} textAnchor="middle" className="f-vn">{wcount}</text> : <path d={`M${vx - 4} ${vy - 3} L${vx + 4} ${vy + 3} M${vx + 4} ${vy - 3} L${vx - 4} ${vy + 3}`} stroke="var(--ink2)" strokeWidth={1.5} fill="none" />}
          {vertical ? (
            <text x={vx + 16} y={vy + 4} className={`f-vl${wcount ? " w" : ""}`}>{`${gate.label} · ${gate.name}`}</text>
          ) : (
            <>
              <text x={vx} y={vy + 25} textAnchor="middle" className={`f-vl${wcount ? " w" : ""}`}>{gShort(gate)}</text>
              <text x={vx} y={vy + 37} textAnchor="middle" className="f-vc">{gate.label}</text>
            </>
          )}
        </g>,
      );
    }
  });
  if (!vertical)
    Object.entries(rework).forEach(([k, n]) => {
      const [f, t] = k.split(">") as [string, string];
      const a = pos.find((q) => q.s?.id === f);
      const b = pos.find((q) => q.s?.id === t);
      if (!a || !b) return;
      if (a.row !== b.row) {
        cross.push([f, t, n]);
        return;
      }
      const ya = a.y - 6 - (Math.abs(a.i - b.i) % 3) * 8;
      const x1 = a.x + bw / 2;
      const x2 = b.x + bw / 2;
      reworkLines.push(
        <g key={k}>
          <path d={`M${x1} ${a.y} V${ya} H${x2} V${b.y - 2}`} className="f-rework" markerEnd="url(#arrw)" />
          <text x={(x1 + x2) / 2} y={ya - 4} textAnchor="middle" className="f-txt w">{`rework ×${n}`}</text>
        </g>,
      );
    });
  const reworkAll = Object.entries(rework);
  const shownCross = vertical ? reworkAll.map(([k, n]) => [...(k.split(">") as [string, string]), n] as [string, string, number]) : cross;

  return (
    <div className="floor-wrap" ref={holder}>
      <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} role="group" aria-label="Production line schematic">
        <defs>
          <marker id="arrw" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M1 1L9 5L1 9z" fill="var(--warn)" /></marker>
          <pattern id="hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1={0} y1={0} x2={0} y2={6} stroke="var(--bad)" strokeWidth={1.6} opacity={0.32} /></pattern>
        </defs>
        {segs.map((pts, i) => {
          const d = pathOf(pts);
          return (
            <g key={`s${i}`}>
              <path d={d} fill="none" stroke="var(--sunk)" strokeWidth={12} strokeLinejoin="round" />
              <path d={d} fill="none" stroke="var(--ink2)" strokeWidth={1.4} transform="translate(0,-6)" />
              <path d={d} fill="none" stroke="var(--ink2)" strokeWidth={1.4} transform="translate(0,6)" />
            </g>
          );
        })}
        {segs.map((pts, i) => <Chevrons key={`c${i}`} pts={pts} id={`c${i}`} />)}
        {arrows.map(([x, y2, a], i) => <path key={`a${i}`} d="M-5 -5L3 0L-5 5Z" className="f-arr" transform={`translate(${x} ${y2}) rotate(${a})`} />)}
        {!vertical && pos[0] ? <text x={12} y={cy(pos[0]) - 14} className="f-no">IN</text> : null}
        {blocks}
        {valves}
        {reworkLines}
      </svg>
      {shownCross.length ? (
        <div className="small muted fcross">
          <span className="micro">{vertical ? "Rework loops: " : "Rework between rows: "}</span>
          {shownCross.map(([f, t, n]) => <span key={`${f}${t}`} className="chip warn">{`${f} → ${t} ×${n}`}</span>)}
        </div>
      ) : null}
    </div>
  );
}
