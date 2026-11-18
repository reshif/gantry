/**
 * Control Room presentation kit. Every component here emits the markup and class names of the Control Room prototype
 * (gantry-designs/design-1-control-room), so the prototype's CSS (styles/cr) draws it unchanged. Components are
 * presentational: they take plain props and never read data, so views map the real hooks onto them (F-01, F-06).
 */
import type { CSSProperties, ReactNode } from "react";
import { CR_ICON_PATHS } from "./cr-icons";

export function CrIcon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <svg className={`ico ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={CR_ICON_PATHS[name] ?? CR_ICON_PATHS.info ?? ""} />
    </svg>
  );
}

export type CrTone = "ok" | "warn" | "bad" | "info" | "agent" | "idle";

/** The prototype page anatomy: eyebrow, title, one-line purpose, actions, then the body. */
export function Page({ eyebrow, title, sub, acts, children, cls = "", id }: { eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; acts?: ReactNode; children?: ReactNode; cls?: string; id?: string }) {
  return (
    <div className={`page ${cls}`} id={id}>
      <header className="ph">
        <div>
          <div className="eyebrow">{eyebrow ?? ""}</div>
          <h1>{title}</h1>
          {sub ? <p className="sub">{sub}</p> : null}
        </div>
        {acts ? <div className="acts">{acts}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, hint, acts, flush, children, id, cls = "" }: { title: ReactNode; hint?: ReactNode; acts?: ReactNode; flush?: boolean; children: ReactNode; id?: string; cls?: string }) {
  return (
    <section className={`card ${cls}`} id={id}>
      <div className="card-h">
        <div>
          <h2>{title}</h2>
          {hint ? <div className="hint">{hint}</div> : null}
        </div>
        {acts ? <div className="row">{acts}</div> : null}
      </div>
      <div className={`card-b${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

export interface StatItem {
  l: string;
  v: ReactNode;
  d?: ReactNode;
  tone?: "ok" | "warn" | "bad" | "info" | "agent";
  spark?: number[];
}

export function Stats({ items, id }: { items: StatItem[]; id?: string }) {
  return (
    <div className="stats" id={id} style={{ "--n": items.length } as CSSProperties}>
      {items.map((s) => (
        <div key={s.l} className={`stat ${s.tone ?? ""}`}>
          <span className="label">{s.l}</span>
          <span className="v">{s.v}</span>
          <span className="d">{s.d ?? " "}</span>
          {s.spark && s.spark.length > 1 ? <span className="sp"><Spark data={s.spark} w={64} h={22} tone={s.tone ?? "info"} /></span> : null}
        </div>
      ))}
    </div>
  );
}

export const Lamp = ({ tone, pulse }: { tone?: CrTone | ""; pulse?: boolean }) => <span className={`lamp ${tone ?? ""}${pulse ? " pulse" : ""}`} />;

export function Spark({ data, w = 80, h = 24, tone = "info" }: { data: number[]; w?: number; h?: number; tone?: string }) {
  const mx = Math.max(...data, 1);
  const mn = Math.min(...data);
  const pts = data.map((v, i) => `${((i / Math.max(1, data.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - mn) / (mx - mn || 1)) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={`var(--${tone})`} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Bar chart with dashed gridlines, axis labels and the latest bar in full colour. */
export function Bars({ data, w = 240, h = 96, label }: { data: number[]; w?: number; h?: number; label: string }) {
  const mx = Math.max(...data, 1);
  const top = Math.max(2, Math.ceil(mx / 2) * 2);
  const bw = w / Math.max(1, data.length);
  return (
    <div className="chart">
      <span className="ax t">{top}</span>
      <span className="ax m">{top / 2}</span>
      <span className="ax b">0</span>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height: h }} role="img" aria-label={`${label}, latest value ${data[data.length - 1] ?? 0} of ${top}`}>
        {[0, 0.5, 1].map((f) => {
          const y = (h - 1 - f * (h - 2)).toFixed(1);
          return <line key={f} x1={0} x2={w} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" {...(f ? { strokeDasharray: "3 3" } : {})} />;
        })}
        {data.map((v, i) => {
          const bh = Math.max(2, (v / top) * (h - 2));
          return <rect key={i} x={(i * bw + 2).toFixed(1)} y={(h - 1 - bh).toFixed(1)} width={(bw - 4).toFixed(1)} height={bh.toFixed(1)} rx={1.5} fill={i === data.length - 1 ? "var(--info)" : "var(--bar)"} />;
        })}
      </svg>
    </div>
  );
}

export function CrEmpty({ title, text, icon = "inbox", action }: { title: ReactNode; text?: ReactNode; icon?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ei"><CrIcon name={icon} /></div>
      <h3>{title}</h3>
      <p>{text ?? ""}</p>
      {action ?? null}
    </div>
  );
}

/** One row of a list card: lamp, two lines, trailing action. */
export function ListItem({ tone, title, sub, children, href }: { tone?: CrTone; title: ReactNode; sub?: ReactNode; children?: ReactNode; href?: string }) {
  const body = (
    <>
      <Lamp tone={tone ?? ""} />
      <div className="main1">
        <span className="t1">{title}</span>
        {sub ? <span className="t2">{sub}</span> : null}
      </div>
      {children}
    </>
  );
  if (href) return <a className="li click" href={href}>{body}</a>;
  return <div className="li">{body}</div>;
}

/* ---------- Home: belt at a glance ---------- */

export interface MiniStation { id: string; name: string; n: number; slots: number; gate: boolean; href: string }

export function MiniBeltCr({ stations }: { stations: MiniStation[] }) {
  return (
    <div className="minibelt" role="img" aria-label="Work in progress per station">
      {stations.map((s) => {
        const over = s.n > s.slots;
        const hi = s.slots + 4;
        return (
          <a key={s.id} href={s.href} className="mb-st" title={`${s.name}: ${s.n} work orders, ${s.slots} slots`}>
            <span className={`mb-n mono ${s.n >= s.slots + 2 ? "bad" : over ? "warn" : ""}`}>{s.n}</span>
            <span className="mb-bar">
              <i style={{ height: `${Math.min(100, (Math.min(s.n, s.slots) / hi) * 100)}%` }} />
              {over ? <i className="over" style={{ height: `${Math.min(100 - (s.slots / hi) * 100, ((s.n - s.slots) / hi) * 100)}%` }} /> : null}
              <b style={{ bottom: `${(s.slots / hi) * 100}%` }} title="Capacity" />
            </span>
            <span className="mb-l">{s.name.split(" ")[0]}</span>
            {s.gate ? <span className="mb-gate" title="Gate waiting" /> : null}
          </a>
        );
      })}
    </div>
  );
}

/* ---------- Floor: the conveyor ---------- */

export type TokState = "running" | "queued" | "gate" | "blocked";
export interface BeltTok { id: string; title: string; state: TokState; pri: string; cls: string; age: string; hit?: boolean; dim?: boolean }
export interface BeltStation { id: string; name: string; agent: string; slots: number; lane: BeltTok[]; queue: BeltTok[]; gateAfter: BeltGate | null; hasNext: boolean }
export interface BeltGate { label?: string; id: string; name: string; waiting: number }

const woShort = (id: string) => id.replace(/^WO-?/i, "");
const STATE_CLS: Record<TokState, string> = { running: "run", queued: "que", gate: "is-gate", blocked: "blk" };
const STATE_SIGN: Record<TokState, string> = { running: "", queued: "", gate: "⏸", blocked: "■" };

function Tok({ t, onOpen }: { t: BeltTok; onOpen: (id: string) => void }) {
  const sg = STATE_SIGN[t.state];
  return (
    <button type="button" className={`tok ${STATE_CLS[t.state]}${t.hit ? " hit" : ""}${t.dim ? " dim" : ""}`} onClick={() => onOpen(t.id)} aria-label={`${t.id}, ${t.title}, ${t.state}, here ${t.age}`} title={`${t.id} · ${t.title} · ${t.state} for ${t.age}`}>
      <span className="r1"><span className="id"><span className="wo-p">WO-</span>{woShort(t.id)}</span><span className={`pr ${t.pri === "P1" ? "p1" : ""}`}>{t.pri}</span></span>
      <span className="r2"><span className="age">{t.age}</span><span className="cl">{t.cls}</span>{sg ? <span className="sg" aria-hidden="true">{sg}</span> : null}</span>
    </button>
  );
}

function QChip({ t, onOpen }: { t: BeltTok; onOpen: (id: string) => void }) {
  return (
    <button type="button" className={`qc${t.hit ? " hit" : ""}${t.dim ? " dim" : ""}`} onClick={() => onOpen(t.id)} aria-label={`${t.id}, queued, waiting ${t.age}`} title={`${t.id} · ${t.title} · waiting ${t.age}`}>
      <span className="id"><span className="wo-p">WO-</span>{woShort(t.id)}</span>
      <span className={`pr ${t.pri === "P1" ? "p1" : ""}`}>{t.pri}</span>
    </button>
  );
}

const Chevrons = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6l8 6-8 6M12 6l8 6-8 6" /></svg>
);

export function Conveyor({ stations, released, paused, onToken, onStation, onGate, onPile }: { stations: BeltStation[]; released: number; paused?: boolean; onToken: (id: string) => void; onStation: (id: string) => void; onGate: (id: string) => void; onPile: (id: string) => void }) {
  return (
    <div className={`belt-card${paused ? " paused" : ""}`}>
      <div className="belt-scroll cue">
        <div className="belt" role="group" aria-label="Production belt, left to right">
          <div className="belt-track" aria-hidden="true" />
          <div className="cap cin"><div className="ch"><span>IN</span></div><div className="cq" /><div className="cb"><Chevrons /></div></div>
          {stations.map((s) => {
            const gtone = s.queue.length >= 4 ? "bad" : s.queue.length ? "warn" : "";
            const gw = s.gateAfter;
            return (
              <StationCols key={s.id}>
                <div className="stn" data-s={s.id}>
                  <button type="button" className="stn-h" onClick={() => onStation(s.id)} title={`${s.name} · ${s.agent} · ${s.lane.length} of ${s.slots} slots${s.queue.length ? `, ${s.queue.length} waiting` : ""}`}>
                    <span className="sn"><span className={`lamp ${s.lane.length ? "info" : ""}`} /><span className="t">{s.name.split(" ")[0]}</span></span>
                    <span className="sa">{s.agent}</span>
                    <span className="gr">
                      <span className={`gauge ${gtone}`} role="meter" aria-label={`WIP ${s.lane.length} of ${s.slots}`} aria-valuenow={s.lane.length} aria-valuemin={0} aria-valuemax={s.slots}>
                        {Array.from({ length: s.slots }, (_, k) => <i key={k} className={k < s.lane.length ? "on" : ""} />)}
                      </span>
                      <span className={`wip ${gtone}`}>{s.lane.length}/{s.slots}</span>
                    </span>
                  </button>
                  <div className={`q${s.queue.length ? "" : " e"}`}>
                    <div className="qh"><span className="lbl">Queue</span><span className={`qn mono ${gtone}`}>{s.queue.length}</span></div>
                    <div className="qd" aria-hidden="true"><i className={gtone} style={{ width: `${Math.min(100, (s.queue.length / 8) * 100)}%` }} /></div>
                    <div className="qs">
                      {s.queue.slice(0, 4).map((w) => <QChip key={w.id} t={w} onOpen={onToken} />)}
                      {s.queue.length > 4 ? <button type="button" className="qmore" onClick={() => onPile(s.id)} aria-label={`${s.queue.length - 4} more waiting at ${s.name}`}>+{s.queue.length - 4} more</button> : null}
                    </div>
                  </div>
                  <div className="lanes">
                    {Array.from({ length: s.slots }, (_, k) => (
                      <div key={k} className="bay">{s.lane[k] ? <Tok t={s.lane[k]!} onOpen={onToken} /> : k === 0 && !s.lane.length ? <span className="idle">idle</span> : null}</div>
                    ))}
                  </div>
                </div>
                {gw ? (
                  <div className={`gate ${gw.waiting ? "wait" : "clear"}`}>
                    <button type="button" className="gh" onClick={() => onGate(gw.id)} aria-label={`Gate ${gw.id} ${gw.name}, ${gw.waiting ? `${gw.waiting} waiting for a person` : "clear"}`} title={`${gw.id} · ${gw.name} · ${gw.waiting ? `${gw.waiting} waiting` : "clear"}`}>
                      <span className={`lamp ${gw.waiting ? "warn pulse" : "ok"}`} /><b>{gw.label ?? gw.id.match(/^G\d+/)?.[0] ?? gw.id}</b><span className="gname">{gw.name}</span><span className="gn">{gw.waiting || ""}</span>
                    </button>
                    <div className="gp" aria-hidden="true" />
                    <div className="gb" aria-hidden="true"><span className="arm" /></div>
                  </div>
                ) : s.hasNext ? (
                  <div className="joint" aria-hidden="true"><div className="jh" /><div className="jq" /><div className="jb" /></div>
                ) : null}
              </StationCols>
            );
          })}
          <div className="cap cout"><div className="ch"><span>OUT</span></div><div className="cq"><b className="mono">{released}</b><span>24h</span></div><div className="cb"><Chevrons /></div></div>
        </div>
      </div>
      <div className="belt-legend">
        <span><i className="lg tk-run" />Running</span>
        <span><i className="lg tk-gate" />At a gate (person needed)</span>
        <span><i className="lg tk-blk" />Blocked</span>
        <span><i className="lg tk-que" />Queued, closest to the belt is next</span>
        <span><i className="lg bay" />Open bay</span>
        <span><i className="lg gt" />Gate: amber lamp = waiting, green = clear</span>
        <span><i className="lg jn" />No gate: passes on</span>
      </div>
    </div>
  );
}

const StationCols = ({ children }: { children: ReactNode }) => <>{children}</>;

/** The throughput ticker: holds, then scrolls; pauses on hover. */
export function Ticker({ items, paused }: { items: Array<{ when: string; text: string }>; paused?: boolean }) {
  const row = items.map((e, i) => <i key={i}><b>{e.when}</b> {e.text}</i>);
  return (
    <div className={`ticker${paused ? " paused" : ""}`} aria-label="Live throughput ticker">
      <div className="tk-h"><span className="lamp ok pulse" /><span>LIVE</span></div>
      <div className="tk-w"><div className="tk">{row}{row}</div></div>
    </div>
  );
}

export function FloorKpis({ items }: { items: Array<{ l: string; v: ReactNode; tone?: "ok" | "warn" | "bad" }> }) {
  return (
    <div className="fl-kpis">
      {items.map((k) => <div key={k.l} className={`fl-kpi ${k.tone ?? ""}`}><span className="label">{k.l}</span><span className="v">{k.v}</span></div>)}
    </div>
  );
}

/* ---------- Floor: search and filters ---------- */

export interface FloorFilterDef { key: string; label: string; options: Array<[string, string]> }

export function FloorTools({ q, onQ, filters, values, onFilter, onClear, open, onToggle, extra }: { extra?: ReactNode; q: string; onQ: (v: string) => void; filters: FloorFilterDef[]; values: Record<string, string>; onFilter: (k: string, v: string) => void; onClear: () => void; open: boolean; onToggle: () => void }) {
  const nf = filters.filter((f) => values[f.key] && values[f.key] !== "all").length;
  return (
    <div className="fl-tools">
      <div className="search">
        <CrIcon name="search" />
        <input className="in" type="text" value={q} onChange={(e) => onQ(e.target.value)} placeholder="Find a work order on the belt" aria-label="Find a work order" id="floor-search" />
      </div>
      <button type="button" className="btn fl-fbtn" onClick={onToggle} aria-expanded={open}><CrIcon name="filter" />Filters{nf ? ` · ${nf}` : ""}</button>
      <div className={`fl-sel${open ? " open" : ""}`}>
        {filters.map((f) => (
          <select key={f.key} className="in" aria-label={f.label} value={values[f.key] ?? "all"} onChange={(e) => onFilter(f.key, e.target.value)}>
            <option value="all">{f.label}: all</option>
            {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ))}
        {q || nf ? <button type="button" className="btn ghost" onClick={onClear}>Clear</button> : null}
      </div>
      {extra ? <div className="fl-extra" style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{extra}</div> : null}
    </div>
  );
}

/** One station's load: slots in use, waiting, and the capacity tick. */
export function LoadBar({ name, used, slots, waiting, scale }: { name: string; used: number; slots: number; waiting: number; scale: number }) {
  const full = used >= slots;
  const tone = waiting >= 4 ? "bad" : waiting > 0 ? "warn" : "";
  return (
    <div>
      <div className="row spread nowrap">
        <span className="row nowrap" style={{ gap: 8 }}><b>{name}</b>{full && waiting ? <span className={`chip ${tone}`}>{waiting >= 4 ? "Backed up" : "Full"}</span> : null}</span>
        <span className="mono dim" style={{ fontSize: 12 }}>{used}/{slots} slots{waiting ? <> · <span className={`ld-${tone}`}>{waiting} waiting</span></> : " · nothing waiting"}</span>
      </div>
      <div className="ld" role="meter" aria-label={`${name}: ${used} of ${slots} slots in use, ${waiting} waiting`} aria-valuenow={used} aria-valuemin={0} aria-valuemax={slots}>
        <i className="u" style={{ width: `${(used / scale) * 100}%` }} />
        <i className={`w ${tone}`} style={{ width: `${(waiting / scale) * 100}%` }} />
        <b style={{ left: `${(slots / scale) * 100}%` }} title="Capacity" />
      </div>
    </div>
  );
}
