/**
 * The line drawing of the Floor (the chosen "precision instrument" sheet): stations as instrument blocks (agent, state, WIP gauge against its
 * limit, wait), valves for the gates between them, the rework return belt, work-order balloons with their wait, side bays as trays under the
 * station that parked them, the released bin, a legend, the revisions strip and a title block. One SVG on a fixed sheet that scales to the
 * width it is given, so it fills the page when the parts list is closed. Under 700 px the same facts are a stacked list of stations.
 * Every figure comes from the floor model (floor/model.ts), which reads the floor, work-order, gate and agent data.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFloorCtx, layoutFor, bayName } from "./kit";
import { dur, shortDur, revWord, approvalsAt, type Bal, type FloorModel, type StationModel } from "./model";

export interface LineHandlers {
  onStation: (sid: string) => void;
  onGate: (gid: string) => void;
  onBay: (sid: string, bayId: string) => void;
  onOut: () => void;
  onWo: (id: string) => void;
  hl: ReadonlySet<string>;
  /** Station ids on the pinned class route; the others recede. Null when no route is shown. */
  route: string[] | null;
  hover: (ids: string[] | null) => void;
}

const keyOn = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }
};
const trunc = (t: string, n: number): string => (t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t);

/* ---------- sheet geometry ---------- */
const W = 1008;
const ROW = 46;
const GAP = 40;
const X0 = 40;
const colsFor = (w: number): number => Math.max(1, Math.floor((w - 24) / 30));
const MAXROWS = 4;
const hBusy = (n: number, w: number): number => (n ? 176 + (Math.min(MAXROWS, Math.ceil(n / colsFor(w))) - 1) * ROW : 140);
const trayH = (n: number, w: number): number => 88 + (Math.min(MAXROWS, Math.ceil(n / colsFor(w))) - 1) * ROW;
const slot = (x: number, w: number, i: number, cols: number, top: number): { x: number; y: number } => {
  const pitch = Math.min(32, (w - 24) / cols);
  return { x: x + 12 + pitch / 2 + (i % cols) * pitch, y: top + 14 + Math.floor(i / cols) * ROW };
};

interface Box { x: number; y: number; w: number; h: number }
interface Placed { st: StationModel; box: Box; trays: Array<{ bay: StationModel["bays"][number]; box: Box }> }

function layout(model: FloorModel, order: { top: string[]; bottom: string[] }) {
  const byId = new Map(model.stations.map((s) => [s.s.id, s]));
  const row1 = order.top.map((id) => byId.get(id)).filter((s): s is StationModel => !!s);
  const row2 = order.bottom.map((id) => byId.get(id)).filter((s): s is StationModel => !!s);
  const n = Math.max(row1.length, row2.length + 1, 1);
  const sw = Math.max(104, Math.min(170, Math.floor((W - X0 - 78 - (n - 1) * GAP) / n)));
  const trays = (st: StationModel): number => st.bays.reduce((sum, b) => sum + trayH(b.items.length, sw) + 10, 0);
  const place = (row: StationModel[], y: number): { placed: Placed[]; h: number; rowH: number } => {
    const bh = Math.max(140, ...row.map((st) => hBusy(st.items.length, sw)));
    const th = Math.max(0, ...row.map(trays));
    const placed = row.map((st, i): Placed => {
      const x = X0 + i * (sw + GAP);
      let ty = y + bh + 14;
      return { st, box: { x, y, w: sw, h: bh }, trays: st.bays.map((bay) => { const h = trayH(bay.items.length, sw); const b = { bay, box: { x, y: ty, w: sw, h } }; ty += h + 10; return b; }) };
    });
    return { placed, h: bh, rowH: bh + (th ? th + 4 : 0) };
  };
  const y1 = 54;
  const r1 = place(row1, y1);
  const rm = y1 + r1.rowH + 16;
  const y2 = rm + 62;
  const r2 = place(row2, y2);
  const out: Box = { x: X0 + row2.length * (sw + GAP), y: y2, w: sw, h: r2.h };
  const bottom = y2 + Math.max(r2.rowH, r2.h);
  const ft = bottom + 14;
  const FH = 84;
  return { sw, rows: [r1.placed, r2.placed], out, y1, y2, rm, mid1: y1 + 86, mid2: y2 + 86, rx: W - 30, xl: 28, ft, FH, H: ft + FH + 18, hasRow2: row2.length > 0 };
}

/* ---------- pieces ---------- */

function Balloon({ b, x, y, rev, h }: { b: Bal; x: number; y: number; rev: boolean; h: LineHandlers }) {
  const open = () => h.onWo(b.w.id);
  const late = b.kind === "gate" && b.age !== null && b.age > 24 * 3_600_000;
  return (
    <g
      className={`fp-bal k-${b.kind}${h.hl.has(b.w.id) ? " hl" : ""}${b.needsYou ? " need" : ""}`}
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="button"
      data-wo={b.w.id}
      id={`floor-tok-${b.w.id}`}
      aria-label={`${b.w.id} ${b.w.title}, ${revWord(b, () => b.w.bay ?? "")}${b.age !== null ? `, ${dur(b.age)}` : ""}`}
      onClick={(e) => { e.stopPropagation(); open(); }}
      onKeyDown={keyOn(open)}
      onMouseEnter={() => h.hover([b.w.id])}
      onMouseLeave={() => h.hover(null)}
    >
      <title>{`${b.w.id} · ${b.w.title}`}</title>
      {b.kind === "gate" ? <circle className="halo" r={13} /> : null}
      <circle className="sel" r={16.5} />
      <circle className="b" r={12} />
      <text className="n" y={0.5}>{b.n}</text>
      <text className={`age${late ? " late" : ""}`} y={25}>{b.age === null ? "✓" : shortDur(b.age)}</text>
      {rev ? <path className="rev" d="M9.5 -15.5L15 -6H4Z" /> : null}
    </g>
  );
}

function Gauge({ x, y, w, count, limit, labels }: { x: number; y: number; w: number; count: number; limit: number; labels: boolean }) {
  const max = Math.max(limit, count, 1);
  const u = w / max;
  const cells: ReactNode[] = [];
  for (let i = 0; i < max; i++) {
    if (i < count) cells.push(<rect key={i} x={x + i * u + 1} y={y} width={Math.max(1, u - 2)} height={8} className={i < limit ? "fp-cell" : "fp-cell over"} />);
    else cells.push(<rect key={i} x={x + i * u + 1} y={y} width={Math.max(1, u - 2)} height={8} className="fp-cell empty" />);
  }
  return (
    <g aria-hidden="true">
      <line x1={x} y1={y + 9} x2={x + w} y2={y + 9} className="fp-rule" />
      {cells}
      {max <= 24 ? Array.from({ length: max + 1 }, (_, i) => <line key={`t${i}`} x1={x + i * u} y1={y + 9} x2={x + i * u} y2={y + (i === 0 || i === limit ? 15 : 12)} className={i === 0 || i === limit ? "fp-tick hi" : "fp-tick"} />) : null}
      <line x1={x + limit * u} y1={y - 5} x2={x + limit * u} y2={y + 9} className={count > limit ? "fp-limit bad" : "fp-limit"} />
      {labels ? (
        <>
          <text className="fp-t f" x={x} y={y + 26} fontSize={10}>0</text>
          <text className="fp-t m" x={Math.min(x + w - 16, x + limit * u)} y={y + 26} fontSize={10} textAnchor={limit === max ? "end" : "middle"}>{`LIMIT ${limit}`}</text>
          {count > limit ? <text className="fp-t bad b" x={x + w} y={y + 26} fontSize={10} textAnchor="end">{count}</text> : null}
        </>
      ) : null}
    </g>
  );
}

function Station({ p, h, bottleneck, revIds }: { p: Placed; h: LineHandlers; bottleneck: boolean; revIds: Set<string> }) {
  const { st, box } = p;
  const count = st.items.length;
  const hot = st.items.some((b) => b.kind === "gate");
  const calm = !count && !st.bays.length;
  const cols = colsFor(box.w);
  const cap = cols * MAXROWS;
  const shown = count > cap ? st.items.slice(0, cap - 1) : st.items;
  const extra = count - shown.length;
  const open = () => h.onStation(st.s.id);
  const maxc = Math.floor((box.w - 20) / 5.5);
  const tone = st.state.tone;
  const oldest = st.oldestWait;
  const lt = oldest !== null ? `OLDEST WAIT ${dur(oldest)}` : "NO WAIT";
  const dimY = box.y + box.h - 14;
  const cap1 = trunc(st.caption, maxc);
  return (
    <g data-station={st.s.id} className={`fp-st${h.route && !h.route.includes(st.s.id) ? " bypass" : ""}${st.over ? " over" : ""}${hot && !st.over ? " hot" : ""}${calm ? " calm" : ""}`}>
      <g
        role="button"
        tabIndex={0}
        id={`floor-st-${st.s.id}`}
        aria-label={`${st.s.name}: ${count} work order${count === 1 ? "" : "s"}, limit ${st.lim}${st.over ? ", over limit" : ""}, agent ${st.agent}, ${st.state.t.toLowerCase()}`}
        onClick={open}
        onKeyDown={keyOn(open)}
      >
        <title>{`${st.s.no} ${st.s.name} · ${st.s.purpose}`}</title>
        <rect className="fp-box" x={box.x} y={box.y} width={box.w} height={box.h} rx={2} />
        <rect className="fp-hd" x={box.x + 0.9} y={box.y + 0.9} width={box.w - 1.8} height={25} rx={1.5} />
        <text className="fp-t acc b" x={box.x + 10} y={box.y + 17} fontSize={11}>{st.s.no}</text>
        <text className="fp-t b" x={box.x + 31} y={box.y + 17} fontSize={11} letterSpacing=".03em">{trunc(st.s.name.toUpperCase(), Math.floor((box.w - 36) / 6.6))}</text>
        {tone !== "idle" ? <path className={`fp-scan ${tone}`} d={`M${box.x + 2} ${box.y + 25.6}H${box.x + box.w - 2}`} /> : null}
        <circle className={`fp-dot ${tone}`} cx={box.x + 13} cy={box.y + 40} r={3} />
        <text className="fp-t b" x={box.x + 21} y={box.y + 43.5} fontSize={10.5}>{trunc(st.agent, Math.floor((box.w - 90) / 6.2))}</text>
        <text className={`fp-t b st ${tone}`} x={box.x + box.w - 10} y={box.y + 43.5} fontSize={10} textAnchor="end">{st.state.t}</text>
        <text className={tone === "idle" ? "fp-sn" : "fp-t m"} x={box.x + 10} y={box.y + 58} fontSize={10.5}>{cap1}</text>
        <text className="fp-t m" x={box.x + 10} y={box.y + 77} fontSize={10} letterSpacing=".1em">WIP</text>
        <text className={`fp-t b${st.over ? " bad" : ""}`} x={box.x + 36} y={box.y + 77} fontSize={13}>{`${count} / ${st.lim}`}</text>
        {st.over ? (
          <text className="fp-t bad b" x={box.x + box.w - 10} y={box.y + 77} fontSize={10} textAnchor="end">{`+${st.over} OVER`}</text>
        ) : count ? (
          <text className="fp-t m" x={box.x + box.w - 10} y={box.y + 77} fontSize={10} textAnchor="end">{`${Math.round(st.ratio * 100)}% FULL`}</text>
        ) : null}
        <Gauge x={box.x + 12} y={box.y + 84} w={box.w - 24} count={count} limit={st.lim} labels />
        <line className="fp-dim" x1={box.x + 10} y1={dimY - 4} x2={box.x + 10} y2={dimY + 4} />
        <line className="fp-dim" x1={box.x + box.w - 10} y1={dimY - 4} x2={box.x + box.w - 10} y2={dimY + 4} />
        <line className="fp-dim" x1={box.x + 10} y1={dimY} x2={box.x + box.w - 10} y2={dimY} />
        <rect x={box.x + box.w / 2 - lt.length * 3.1 - 5} y={dimY - 7} width={lt.length * 6.2 + 10} height={14} className="fp-lbl" />
        <text className={`fp-t ${oldest !== null ? "warn b" : "f"}`} x={box.x + box.w / 2} y={dimY + 3.6} fontSize={10} textAnchor="middle">{lt}</text>
      </g>
      {bottleneck ? (
        <g className="fp-flag" aria-hidden="true">
          <rect className="r" x={box.x} y={box.y - 14} width={Math.min(box.w, 118)} height={14} />
          <text className="r" x={box.x + 6} y={box.y - 4}>{`BOTTLENECK ${Math.round(st.ratio * 100)}%`}</text>
        </g>
      ) : null}
      {hot ? (
        <g className="fp-flag" aria-hidden="true">
          <rect className="a" x={box.x + box.w - 82} y={box.y - (bottleneck ? 28 : 14)} width={82} height={14} />
          <text className="a" x={box.x + box.w - 76} y={box.y - (bottleneck ? 18 : 4)}>{`${st.items.filter((b) => b.kind === "gate").length} NEED YOU`}</text>
        </g>
      ) : null}
      {shown.map((b, k) => {
        const q = slot(box.x, box.w, k, cols, box.y + 114);
        return <Balloon key={b.w.id} b={b} x={q.x} y={q.y} rev={revIds.has(b.w.id)} h={h} />;
      })}
      {extra > 0
        ? (() => {
            const q = slot(box.x, box.w, shown.length, cols, box.y + 114);
            return (
              <g className="fp-more" tabIndex={0} role="button" transform={`translate(${q.x} ${q.y})`} aria-label={`${extra} more at ${st.s.name}`} onClick={open} onKeyDown={keyOn(open)}>
                <title>{`${extra} more work orders at ${st.s.name}`}</title>
                <circle r={12} className="b" />
                <text className="n" y={0.5}>{`+${extra}`}</text>
              </g>
            );
          })()
        : null}
      {p.trays.map(({ bay, box: tb }) => {
        const tcols = colsFor(tb.w);
        const tshown = bay.items.length > tcols * MAXROWS ? bay.items.slice(0, tcols * MAXROWS - 1) : bay.items;
        const textra = bay.items.length - tshown.length;
        const openBay = () => h.onBay(st.s.id, bay.bay.id);
        return (
          <g key={bay.bay.id} data-bay={bay.bay.id} className={`fp-tray${bay.needsYou ? " need" : ""}`}>
            <g
              role="button"
              tabIndex={0}
              id={`floor-bay-${st.s.id}-${bay.bay.id}`}
              aria-label={`${st.s.name}, ${bay.bay.name}: ${bay.items.length} work order${bay.items.length === 1 ? "" : "s"}`}
              onClick={openBay}
              onKeyDown={keyOn(openBay)}
              onMouseEnter={() => h.hover(bay.items.map((b) => b.w.id))}
              onMouseLeave={() => h.hover(null)}
            >
              <title>{`${bay.bay.name} · ${bay.bay.desc}`}</title>
              <line x1={tb.x + tb.w / 2} y1={tb.y - 9} x2={tb.x + tb.w / 2} y2={tb.y} className="fp-stem" />
              <rect className="tb" x={tb.x} y={tb.y} width={tb.w} height={tb.h} rx={2} />
              <text className="fp-t b tray-h" x={tb.x + 10} y={tb.y + 17.5} fontSize={10} letterSpacing=".08em">{trunc(bay.bay.name.toUpperCase(), Math.floor((tb.w - 20) / 7))}</text>
              <text className="fp-t m fp-bay-c" x={tb.x + tb.w - 10} y={tb.y + 17.5} fontSize={10} textAnchor="end">{bay.items.length}</text>
              <text className="fp-t m" x={tb.x + 10} y={tb.y + tb.h - 7} fontSize={10}>{trunc(bay.bay.desc, Math.floor((tb.w - 20) / 5.6))}</text>
            </g>
            {tshown.map((b, k) => {
              const q = slot(tb.x, tb.w, k, tcols, tb.y + 14);
              return <Balloon key={b.w.id} b={b} x={q.x} y={q.y + 8} rev={revIds.has(b.w.id)} h={h} />;
            })}
            {textra > 0 ? (
              <g className="fp-more" tabIndex={0} role="button" transform={`translate(${slot(tb.x, tb.w, tshown.length, tcols, tb.y + 14).x} ${slot(tb.x, tb.w, tshown.length, tcols, tb.y + 14).y + 8})`} aria-label={`${textra} more in ${bay.bay.name}`} onClick={openBay} onKeyDown={keyOn(openBay)}>
                <circle r={12} className="b" />
                <text className="n" y={0.5}>{`+${textra}`}</text>
              </g>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function Valve({ st, x, y, h }: { st: StationModel; x: number; y: number; h: LineHandlers }) {
  const gm = st.gate;
  if (!gm) return null;
  const { g } = gm;
  const open = () => h.onGate(g.id);
  const cls = gm.state === "off" ? " off" : gm.failing ? " bad" : gm.waiting && gm.kind !== "auto" ? " hot" : "";
  const word = gm.kind === "auto" ? "auto" : gm.kind === "mixed" ? "mixed" : "person";
  const label = `${g.label} · ${g.name} (${gm.kind === "auto" ? "automatic check" : gm.kind === "mixed" ? "check plus person" : "a person approves"})${gm.waiting ? ` · ${gm.waiting} waiting` : ""}${gm.failing ? ` · ${gm.failing} failing` : ""}${gm.state === "off" ? " · off" : ""}`;
  return (
    <g className={`fp-gate${h.route && !h.route.includes(st.s.id) ? " bypass" : ""}${gm.kind === "auto" ? " auto" : ""}${cls}`} data-gate={g.id} id={`floor-gate-${g.id}`} tabIndex={0} role="button" aria-label={`Gate ${label}`} onClick={open} onKeyDown={keyOn(open)}>
      <title>{label}</title>
      <rect className="hit" x={x - 24} y={y - 22} width={48} height={64} />
      {cls === " hot" ? <circle className="pulse" cx={x} cy={y} r={12} /> : null}
      <circle className="body" cx={x} cy={y} r={11} />
      {gm.waiting ? <text className="fp-vn" x={x} y={y + 0.5}>{gm.waiting}</text> : <path className="glyph" d={`M${x - 5} ${y - 5}L${x + 5} ${y + 5}M${x + 5} ${y - 5}L${x - 5} ${y + 5}`} />}
      <text className="fp-t b" x={x} y={y + 25} fontSize={10} textAnchor="middle">{g.label}</text>
      <text className="fp-t f" x={x} y={y + 36} fontSize={9.5} textAnchor="middle">{word}</text>
    </g>
  );
}

/* ---------- sheet furniture ---------- */

function Frame({ H, sw }: { H: number; sw: number }) {
  const q = (H - 36) / 4;
  const cols = Math.max(1, Math.floor((W - 36 - X0) / (sw + GAP)));
  return (
    <g aria-hidden="true">
      <rect className="fp-frame-o" x={2} y={2} width={W - 4} height={H - 4} />
      <rect className="fp-frame-i" x={18} y={18} width={W - 36} height={H - 36} />
      {Array.from({ length: Math.min(5, cols) }, (_, k) => {
        const bx = X0 + k * (sw + GAP) - GAP / 2;
        const c = X0 + k * (sw + GAP) + sw / 2;
        return (
          <g key={k}>
            <line className="fp-frame-t" x1={bx} y1={2} x2={bx} y2={18} />
            <line className="fp-frame-t" x1={bx} y1={H - 18} x2={bx} y2={H - 2} />
            <text className="fp-t m" x={c} y={13} fontSize={10.5} textAnchor="middle">{k + 1}</text>
            <text className="fp-t m" x={c} y={H - 7} fontSize={10.5} textAnchor="middle">{k + 1}</text>
          </g>
        );
      })}
      {Array.from({ length: 4 }, (_, k) => {
        const y = 18 + k * q;
        return (
          <g key={k}>
            {k > 0 ? <><line className="fp-frame-t" x1={2} y1={y} x2={18} y2={y} /><line className="fp-frame-t" x1={W - 18} y1={y} x2={W - 2} y2={y} /></> : null}
            <text className="fp-t m" x={10} y={y + q / 2 + 3.5} fontSize={10.5} textAnchor="middle">{"ABCD"[k]}</text>
            <text className="fp-t m" x={W - 10} y={y + q / 2 + 3.5} fontSize={10.5} textAnchor="middle">{"ABCD"[k]}</text>
          </g>
        );
      })}
    </g>
  );
}

function legendIcon(k: string, x: number, y: number): ReactNode {
  return (
    <g transform={`translate(${x},${y})`} className={`fp-li k-${k}`}>
      {k === "rework" ? <path className="fp-rw" d="M-9 0H9" /> : k === "rev" ? <path d="M0 -6L6 5H-6Z" className="fp-revmark" /> : <circle r={6} className="b" />}
      {k === "queue" ? <text className="fp-t b" y={3.3} fontSize={8.5} textAnchor="middle">1</text> : null}
    </g>
  );
}

function Legend({ x, y }: { x: number; y: number }) {
  const items: Array<[string, string]> = [["gate", "At a gate"], ["stuck", "Stuck or parked"], ["split", "Split epic"], ["done", "Released"], ["run", "Running"], ["rework", "Rework route"], ["rev", "Revised < 60 min"]];
  return (
    <g>
      <text className="fp-t f" x={x} y={y + 8} fontSize={10} letterSpacing=".12em">LEGEND</text>
      {items.map(([k, t], i) => {
        const c = i < 4 ? 0 : 1;
        const r = i < 4 ? i : i - 4;
        const ix = x + c * 140 + 9;
        const iy = y + 26 + r * 17;
        return (
          <g key={k}>
            {legendIcon(k, ix, iy)}
            <text className="fp-sn" x={ix + 16} y={iy + 3.6} fontSize={10.5}>{t}</text>
          </g>
        );
      })}
    </g>
  );
}

function Revisions({ model, x, y, w, hgt, h, bays }: { model: FloorModel; x: number; y: number; w: number; hgt: number; h: LineHandlers; bays: (id: string) => string }) {
  const rev = model.revised;
  const per = Math.max(1, Math.ceil(rev.length / 2));
  const colW = w / 2;
  const rh = (hgt - 16) / per;
  return (
    <g>
      <rect className="fp-sheet" x={x} y={y} width={w} height={hgt} />
      <rect className="fp-hd" x={x} y={y} width={w} height={16} />
      <line className="fp-rule" x1={x} y1={y + 16} x2={x + w} y2={y + 16} />
      <text className="fp-t b" x={x + 7} y={y + 11.5} fontSize={10} letterSpacing=".1em">REVISIONS</text>
      <text className="fp-t m" x={x + w - 7} y={y + 11.5} fontSize={10} textAnchor="end">{`changed in the last 60 min · ${rev.length} of ${model.all.length}`}</text>
      <line className="fp-rule" x1={x + colW} y1={y + 16} x2={x + colW} y2={y + hgt} />
      {rev.length ? null : <text className="fp-sn" x={x + 10} y={y + 36} fontSize={10.5}>No changes in the last hour</text>}
      {rev.slice(0, per * 2).map((b, k) => {
        const c = k < per ? 0 : 1;
        const r = k < per ? k : k - per;
        const rx = x + c * colW;
        const ry = y + 16 + r * rh;
        const open = () => h.onWo(b.w.id);
        return (
          <g key={b.w.id} className={`fp-revrow${h.hl.has(b.w.id) ? " hl" : ""}`} tabIndex={0} role="button" aria-label={`Revision ${b.w.id} ${revWord(b, bays)}`} onClick={open} onKeyDown={keyOn(open)} onMouseEnter={() => h.hover([b.w.id])} onMouseLeave={() => h.hover(null)}>
            <rect className="hit" x={rx + 0.5} y={ry} width={colW - 1} height={rh} />
            <path className="fp-revmark" d={`M${rx + 9} ${ry + 3}L${rx + 14.5} ${ry + rh - 4}H${rx + 3.5}Z`} />
            <text className="fp-t b" x={rx + 21} y={ry + rh / 2 + 3.6} fontSize={10}>{b.w.id}</text>
            <text className="fp-sn" x={rx + 72} y={ry + rh / 2 + 3.6} fontSize={10.5}>{trunc(revWord(b, bays), 14)}</text>
            <text className="fp-t m" x={rx + colW - 7} y={ry + rh / 2 + 3.6} fontSize={10} textAnchor="end">{shortDur(b.age ?? 0)}</text>
          </g>
        );
      })}
    </g>
  );
}

function TitleBlock({ model, x, y, w, hgt }: { model: FloorModel; x: number; y: number; w: number; hgt: number }) {
  const ctx = useFloorCtx();
  const p = ctx.project;
  const cw = [0.34, 0.36, 0.3].map((f) => f * w);
  const rh = [32, 26, 26];
  const cx = [x, x + cw[0]!, x + cw[0]! + cw[1]!];
  const first = model.groups.find((g) => g.type === "gate");
  const ap = first ? approvalsAt(ctx, first.wos, first.gid!) : null;
  const gl = first ? (model.stations.find((s) => s.gate?.g.id === first.gid)?.gate?.g.label ?? first.gid) : "";
  const agents = new Set(model.stations.map((s) => s.s.agent)).size;
  const review = model.stations.find((s) => s.s.id === "review") ?? model.stations[Math.max(0, model.stations.length - 2)];
  const cap = (cxp: number, cy: number, t: string) => <text className="fp-t f" x={cxp + 7} y={cy + 11} fontSize={10} letterSpacing=".1em">{t}</text>;
  const val = (cxp: number, cy: number, t: string, dy: number, extra = "") => <text className={`fp-t ${extra}`} x={cxp + 7} y={cy + dy} fontSize={10.5}>{trunc(t, Math.floor((cw[1]! - 10) / 6.2))}</text>;
  const r2 = y + rh[0]!;
  const r3 = r2 + rh[1]!;
  return (
    <g>
      <rect className="fp-sheet" x={x} y={y} width={w} height={hgt} />
      <line className="fp-rule" x1={x} y1={r2} x2={x + w} y2={r2} />
      <line className="fp-rule" x1={x} y1={r3} x2={x + w} y2={r3} />
      <line className="fp-rule" x1={cx[2]} y1={y} x2={cx[2]} y2={y + hgt} />
      <line className="fp-rule" x1={cx[1]} y1={r2} x2={cx[1]} y2={y + hgt} />
      {cap(cx[0]!, y, "PROJECT")}
      <text className="fp-sn b" x={cx[0]! + 7} y={y + 27} fontSize={15}>{trunc(p.name, 17)}</text>
      <text className="fp-t m" x={cx[2]! - 8} y={y + 27} fontSize={10.5} textAnchor="end">{p.key}</text>
      {cap(cx[2]!, y, "DWG")}
      {val(cx[2]!, y, `${p.key}-FLR`, 26)}
      {cap(cx[0]!, r2, "DRAWN")}
      {val(cx[0]!, r2, `${agents} agents`, 22)}
      {cap(cx[1]!, r2, "CHECKED")}
      {val(cx[1]!, r2, review?.agent ?? "", 22)}
      {cap(cx[2]!, r2, "APPROVED")}
      {val(cx[2]!, r2, ap ? `${ap.ready} of ${ap.total} at ${gl}` : "none waiting", 22, ap && ap.ready < ap.total ? "warn" : "")}
      {cap(cx[0]!, r3, "REV")}
      {val(cx[0]!, r3, `flow v${ctx.floor.flowVersion}`, 22)}
      {cap(cx[1]!, r3, "SNAPSHOT")}
      {val(cx[1]!, r3, `${new Date(ctx.now).toISOString().replace("T", " ").slice(0, 16)}Z`, 22)}
      {cap(cx[2]!, r3, "SHEET")}
      {val(cx[2]!, r3, "1 of 1", 22)}
      <rect className="fp-sheet-o" x={x} y={y} width={w} height={hgt} />
    </g>
  );
}

/* ---------- the drawing ---------- */

export function LineDrawing({ model, h }: { model: FloorModel; h: LineHandlers }) {
  const ctx = useFloorCtx();
  const order = layoutFor(ctx.cat, ctx.project);
  const L = layout(model, order);
  const revIds = new Set(model.revised.map((b) => b.w.id));
  const bays = (id: string) => bayName(ctx.cat, id);
  const [r1, r2] = L.rows as [Placed[], Placed[]];
  const stOf = (id: string) => [...r1, ...r2].find((q) => q.st.s.id === id);
  const bn = model.bottleneck?.st.s.id;
  const sid = (id: string) => ctx.cat.stations.find((s) => s.id === id)?.no ?? id;
  const path = L.hasRow2 ? `M0 ${L.mid1}H${L.rx}V${L.rm}H${L.xl}V${L.mid2}H${L.out.x + L.out.w}` : `M0 ${L.mid1}H${L.rx}`;
  const cross: string[] = [];
  const arcs = Object.entries(model.rework).map(([k, n]) => {
    const [f, t] = k.split(">") as [string, string];
    const a = stOf(f);
    const b = stOf(t);
    if (!a || !b) return null;
    if (r1.includes(a) !== r1.includes(b)) {
      cross.push(`×${n} ${sid(f)}→${sid(t)}`);
      return null;
    }
    const ya = a.box.y - 6 - (Math.abs(r1.indexOf(a) - r1.indexOf(b)) % 3) * 8 - (r1.includes(a) ? 0 : 0);
    const x1 = a.box.x + a.box.w / 2;
    const x2 = b.box.x + b.box.w / 2;
    return (
      <g key={k} aria-hidden="true">
        <path className="fp-rw" d={`M${x1} ${a.box.y} V${ya} H${x2} V${b.box.y - 2}`} markerEnd="url(#fp-arr)" />
        <text className="fp-t b" x={(x1 + x2) / 2} y={ya - 4} fontSize={10} textAnchor="middle">{`rework ×${n} ${sid(f)}→${sid(t)}`}</text>
      </g>
    );
  });
  const done = model.done;
  const outOpen = h.onOut;
  return (
    <svg className="fp-dw" viewBox={`0 0 ${W} ${L.H}`} role="group" aria-label="Production line drawing sheet">
      <defs>
        <pattern id="fp-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1={0} y1={0} x2={0} y2={6} className="fp-hatchl" /></pattern>
        <marker id="fp-arr" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto"><path d="M0 .5L7.5 4L0 7.5z" className="fp-arrow" /></marker>
      </defs>
      <Frame H={L.H} sw={L.sw} />
      <g aria-hidden="true">
        <path className="fp-belt-o" d={path} />
        <path className="fp-belt-i" d={path} />
        <path className="fp-belt-f" d={path} />
        <text className="fp-t acc b" x={X0 - 4} y={L.mid1 - 10} fontSize={11}>IN</text>
        {L.hasRow2 ? (
          <>
            <rect className="fp-lbl" x={W / 2 - 50} y={L.rm - 9} width={100} height={18} />
            <text className="fp-t b" x={W / 2} y={L.rm + 3.6} fontSize={10} textAnchor="middle" letterSpacing=".08em">◂ RETURN BELT</text>
            {cross.length ? <text className="fp-t b" x={W / 2} y={L.rm + 24} fontSize={10} textAnchor="middle">{`rework ${cross.join(" · ")}`}</text> : null}
          </>
        ) : null}
      </g>
      {arcs}
      {[...r1, ...r2].map((p) => <Station key={p.st.s.id} p={p} h={h} bottleneck={p.st.s.id === bn} revIds={revIds} />)}
      {[r1, r2].map((row, ri) => {
        const mid = ri === 0 ? L.mid1 : L.mid2;
        return row.map((p) => <Valve key={`v${p.st.s.id}`} st={p.st} x={p.box.x + p.box.w + GAP / 2} y={mid} h={h} />);
      })}
      {L.hasRow2 ? (
        <g role="button" tabIndex={0} id="floor-out" className="fp-out" aria-label={`Out: ${done.length} released work order${done.length === 1 ? "" : "s"}`} onClick={outOpen} onKeyDown={keyOn(outOpen)}>
          <title>OUT · released work orders</title>
          <rect className="fp-box out" x={L.out.x} y={L.out.y} width={L.out.w} height={L.out.h} rx={2} />
          <text className="fp-t b" x={L.out.x + 10} y={L.out.y + 17} fontSize={11} letterSpacing=".06em">OUT</text>
          <text className="fp-t b" x={L.out.x + 40} y={L.out.y + 17} fontSize={11} letterSpacing=".06em">RELEASED</text>
          <text className="fp-t ok b" x={L.out.x + 12} y={L.out.y + 66} fontSize={34}>{done.length}</text>
          <text className="fp-t m" x={L.out.x + 56} y={L.out.y + 66} fontSize={10} letterSpacing=".1em">SHIPPED</text>
          {done.slice(-colsFor(L.out.w) * 2).map((w, k) => {
            const q = slot(L.out.x, L.out.w, k, colsFor(L.out.w), L.out.y + 70);
            const b = model.byId.get(w.id)!;
            return <Balloon key={w.id} b={b} x={q.x} y={q.y} rev={false} h={h} />;
          })}
        </g>
      ) : null}
      <Legend x={34} y={L.ft} />
      <Revisions model={model} x={316} y={L.ft} w={326} hgt={L.FH} h={h} bays={bays} />
      <TitleBlock model={model} x={W - 18 - 340} y={L.ft} w={340} hgt={L.FH} />
    </svg>
  );
}

/* ---------- the stacked list under 700 px ---------- */

export function LineStack({ model, h }: { model: FloorModel; h: LineHandlers }) {
  const ctx = useFloorCtx();
  const order = layoutFor(ctx.cat, ctx.project);
  const ids = [...order.top, ...order.bottom];
  const sts = ids.map((id) => model.stations.find((s) => s.s.id === id)).filter((s): s is StationModel => !!s);
  const revIds = new Set(model.revised.map((b) => b.w.id));
  const chip = (b: Bal) => (
    <div key={b.w.id} className={`fp-chip k-${b.kind}${h.hl.has(b.w.id) ? " hl" : ""}`} role="button" tabIndex={0} data-wo={b.w.id} aria-label={`${b.w.id} ${b.w.title}`} onClick={(e) => { e.stopPropagation(); h.onWo(b.w.id); }} onKeyDown={keyOn(() => h.onWo(b.w.id))}>
      <i>{b.n}</i>
      <span>{b.age === null ? "✓" : shortDur(b.age)}</span>
      {revIds.has(b.w.id) ? <u aria-label="revised in the last hour">▲</u> : null}
    </div>
  );
  return (
    <div className="fp-stack" aria-label="Production line, station by station">
      {sts.map((st) => {
        const hot = st.items.some((b) => b.kind === "gate");
        const open = () => h.onStation(st.s.id);
        const gm = st.gate;
        return (
          <div key={st.s.id} className="fp-stk">
            <div className={`fp-stn${h.route && !h.route.includes(st.s.id) ? " bypass" : ""}${st.over ? " over" : ""}${hot && !st.over ? " hot" : ""}${!st.items.length && !st.bays.length ? " calm" : ""}`} data-station={st.s.id} role="button" tabIndex={0} id={`floor-st-${st.s.id}`} aria-label={`${st.s.name}: ${st.items.length} work orders, limit ${st.lim}${st.over ? ", over limit" : ""}, ${st.state.t.toLowerCase()}`} onClick={open} onKeyDown={keyOn(open)}>
              <div className="fp-stn-h"><b>{st.s.no}</b><span>{st.s.name}</span><em className={`st ${st.state.tone}`}>{st.state.t}</em></div>
              <div className="fp-stn-a">{st.agent}</div>
              <div className="fp-stn-c">{st.caption}</div>
              <div className="fp-stn-g"><span className="mono">{`WIP ${st.items.length} / ${st.lim}`}</span><span className="fp-bar" aria-hidden="true"><i className={st.over ? "bad" : ""} style={{ width: `${Math.min(100, Math.round(st.ratio * 100))}%` }} /></span>{st.over ? <span className="mono bad">{`+${st.over} over`}</span> : null}</div>
              <div className={`fp-stn-w${st.oldestWait !== null ? " warn" : ""}`}>{st.oldestWait !== null ? `Oldest wait ${dur(st.oldestWait)}` : "No wait"}</div>
              {st.items.length ? <div className="fp-chips">{st.items.map(chip)}</div> : null}
            </div>
            {st.bays.map((bay) => (
              <div key={bay.bay.id} className={`fp-trayl${bay.needsYou ? " need" : ""}`} data-bay={bay.bay.id} role="button" tabIndex={0} aria-label={`${st.s.name}, ${bay.bay.name}: ${bay.items.length}`} onClick={() => h.onBay(st.s.id, bay.bay.id)} onKeyDown={keyOn(() => h.onBay(st.s.id, bay.bay.id))}>
                <div className="fp-stn-h"><span>{bay.bay.name}</span><em>{bay.items.length}</em></div>
                <div className="fp-chips">{bay.items.map(chip)}</div>
              </div>
            ))}
            {gm ? (
              <div className={`fp-valvel${gm.state === "off" ? " off" : gm.failing ? " bad" : gm.waiting && gm.kind !== "auto" ? " hot" : ""}${gm.kind === "auto" ? " auto" : ""}`} data-gate={gm.g.id} id={`floor-gate-${gm.g.id}`} role="button" tabIndex={0} aria-label={`Gate ${gm.g.label} ${gm.g.name}${gm.waiting ? `, ${gm.waiting} waiting` : ""}`} onClick={() => h.onGate(gm.g.id)} onKeyDown={keyOn(() => h.onGate(gm.g.id))}>
                <i>{gm.waiting || "×"}</i>
                <span>{`${gm.g.label} · ${gm.g.name}`}</span>
                <em>{gm.kind === "auto" ? "auto" : gm.kind === "mixed" ? "mixed" : "person"}</em>
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="fp-stn out" id="floor-out" role="button" tabIndex={0} aria-label={`Out: ${model.done.length} released work orders`} onClick={h.onOut} onKeyDown={keyOn(h.onOut)}>
        <div className="fp-stn-h"><b>OUT</b><span>Released</span></div>
        <div className="fp-big">{model.done.length}<small>shipped</small></div>
      </div>
      <p className="fp-stack-note mono">balloon number = end of the work order number · time = waiting here</p>
    </div>
  );
}

/** The container width, so the drawing scales on a desktop and the stacked list takes over on a phone. */
export function useNarrow(limit = 700): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const measure = () => setNarrow((el?.clientWidth || window.innerWidth) < limit);
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" && el ? new ResizeObserver(measure) : null;
    if (el) ro?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [limit]);
  return [ref, narrow];
}
