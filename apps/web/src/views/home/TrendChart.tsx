import { useLayoutEffect, useRef, useState } from "react";

/** The prototype's line chart: dotted gridlines with mono ticks, one polyline per series (the second dashed), a dot per point with a tooltip, and a legend of squares below. */
const COLORS = ["var(--accent)", "var(--warn)", "var(--ok)", "var(--bad)"];

export function TrendChart({ series, labels, min, max, fmt, label }: { series: Array<{ name: string; v: number[] }>; labels: string[]; min: number; max: number; fmt: (v: number) => string; label: string }) {
  // fluid like the prototype: drawn at the width of its box, so the text keeps its size on a phone
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => { if (el.clientWidth > 0) setW(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 190, pl = 40, pb = 24, pt = 10, pr = 10;
  const X = (i: number) => pl + (i * (W - pl - pr)) / (labels.length - 1 || 1);
  const Y = (v: number) => H - pb - ((v - min) / (max - min || 1)) * (H - pb - pt);
  const step = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((W - pl - pr) / 38))));
  return (
    <div ref={box} style={{ width: "100%", minWidth: 0, overflow: "hidden" }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
        {[0, 1, 2, 3, 4].map((i) => {
          const v = min + ((max - min) * i) / 4;
          return (
            <g key={i}>
              <line className="gl" x1={pl} x2={W - pr} y1={Y(v)} y2={Y(v)} />
              <text x={pl - 5} y={Y(v) + 4} textAnchor="end">{fmt(v)}</text>
            </g>
          );
        })}
        {labels.map((l, i) => (i % step === 0 ? <text key={l + i} x={X(i)} y={H - 7} textAnchor="middle">{l}</text> : null))}
        {series.map((s, k) => (
          <g key={s.name}>
            <polyline points={s.v.map((v, i) => `${X(i)},${Y(v)}`).join(" ")} fill="none" stroke={COLORS[k]} strokeWidth={2} {...(k ? { strokeDasharray: "5 3" } : {})} />
            {s.v.map((v, i) => <circle key={i} cx={X(i)} cy={Y(v)} r={3} fill={COLORS[k]}><title>{`${s.name} ${labels[i]}: ${fmt(v)}`}</title></circle>)}
          </g>
        ))}
      </svg>
      {series.length > 1 ? (
        <div className="legend" style={{ marginTop: 6 }}>
          {series.map((s, k) => <span key={s.name}><i style={{ background: COLORS[k] }} />{s.name}</span>)}
        </div>
      ) : null}
    </div>
  );
}
