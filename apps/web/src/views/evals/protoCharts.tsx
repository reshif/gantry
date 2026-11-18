/**
 * The prototype's two charts, drawn the same way: an SVG at the real pixel width of its box (so chart text is never scaled below its size),
 * a plain line with a dot per point, and a bar list whose value sits at the end of its bar. Shared by Evals (Factory-wide) and Learning (Signals).
 */
import { useLayoutEffect, useRef, useState } from "react";

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const paint = (): void => { const n = Math.floor(el.clientWidth); if (n && Math.abs(n - w) >= 4) setW(n); };
    paint();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(paint);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return [ref, w];
}

export function LineChart({ values, labels, label, min, max, fmt, h = 190 }: { values: number[]; labels: string[]; label: string; min?: number; max?: number; fmt?: (v: number) => string; h?: number }) {
  const [ref, W] = useWidth();
  const pl = 40, pb = 24, pt = 10, pr = 10;
  const mx = max ?? Math.max(...values) * 1.1;
  const mn = min ?? 0;
  const X = (i: number): number => pl + (i * (W - pl - pr)) / (labels.length - 1 || 1);
  const Y = (v: number): number => h - pb - ((v - mn) / (mx - mn || 1)) * (h - pb - pt);
  const step = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((W - pl - pr) / 38))));
  return (
    <div className="fluid" ref={ref}>
      {W ? (
        <svg className="chart" viewBox={`0 0 ${W} ${h}`} width={W} height={h} role="img" aria-label={label}>
          {[0, 1, 2, 3, 4].map((i) => { const v = mn + ((mx - mn) * i) / 4; return <g key={i}><line className="gl" x1={pl} x2={W - pr} y1={Y(v)} y2={Y(v)} /><text x={pl - 5} y={Y(v) + 4} textAnchor="end">{fmt ? fmt(v) : +v.toFixed(2)}</text></g>; })}
          {labels.map((l, i) => (i % step === 0 ? <text key={`l${i}`} x={X(i)} y={h - 7} textAnchor="middle">{l}</text> : null))}
          <polyline points={values.map((v, i) => `${X(i)},${Y(v)}`).join(" ")} fill="none" stroke="var(--accent)" strokeWidth={2} />
          {values.map((v, i) => <circle key={`c${i}`} cx={X(i)} cy={Y(v)} r={3} fill="var(--accent)"><title>{`${labels[i]}: ${fmt ? fmt(v) : v}`}</title></circle>)}
        </svg>
      ) : null}
    </div>
  );
}

export function BarChart({ items, label, lw: lwWant = 150 }: { items: Array<{ l: string; v: number; tone?: string }>; label: string; lw?: number }) {
  const [ref, W] = useWidth();
  const rowH = 28;
  const H = items.length * rowH + 6;
  const lw = Math.min(lwWant, Math.max(90, W * 0.42));
  const mx = Math.max(...items.map((i) => i.v), 1) * 1.05;
  const vw = 36;
  const cw = Math.max(6, Math.floor((lw - 8) / 6.7));
  return (
    <div className="fluid" ref={ref}>
      {W ? (
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
          {items.map((it, i) => {
            const y = i * rowH + 3;
            const bw = Math.max(0, ((W - lw - vw) * it.v) / mx);
            return (
              <g key={it.l}>
                <text x={lw - 8} y={y + 15} textAnchor="end"><title>{it.l}</title>{it.l.length > cw ? `${it.l.slice(0, cw - 1)}…` : it.l}</text>
                <rect x={lw} y={y + 3} width={Math.max(1, bw)} height={15} fill={it.tone ? `var(--${it.tone})` : "var(--accent)"} opacity={0.85} />
                <text x={lw + bw + 6} y={y + 15}>{it.v}</text>
              </g>
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}
