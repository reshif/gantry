/**
 * Hand-drawn SVG charts ported from legacy ui.js (sparkline, area chart, horizontal bars).
 * Geometry and class names are unchanged. Text goes through esc() before it enters the markup.
 */

export const esc = (s: unknown): string =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function Spark({ values, w = 84, h = 22, min, max, cls, label }: { values: number[]; w?: number; h?: number; min?: number; max?: number; cls?: string; label?: string }) {
  if (values.length < 2) return null;
  const pad = 2;
  let lo = min ?? Math.min(...values);
  let hi = max ?? Math.max(...values);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const pts = values.map((v, i) => [pad + (i * (w - pad * 2)) / (values.length - 1), h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2)] as const);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
  const lastPt = pts[pts.length - 1] ?? [0, 0];
  const area = `${d}L${lastPt[0].toFixed(1)} ${h - pad}L${pad} ${h - pad}Z`;
  const svg = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${area}" class="spark-area"/><path d="${d}" class="spark-line"/><circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="2.4" class="spark-dot"/></svg>`;
  return <span className={`spark${cls ? ` ${cls}` : ""}`} role="img" aria-label={label || `Trend, latest ${values[values.length - 1]}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export interface AreaChartProps {
  values: number[];
  labels?: string[];
  fmt?: (v: number) => string;
  yLabel?: string;
  min?: number;
  max?: number;
  threshold?: number;
  threshLabel?: string;
  w?: number;
  h?: number;
  compare?: number[];
  title?: string;
  legend?: string;
}

export function AreaChart(o: AreaChartProps) {
  const W = o.w ?? 520;
  const H = o.h ?? 210;
  const L = 48;
  const R = 64;
  const T = 24;
  const B = 30;
  const vals = o.values;
  if (vals.length < 2) return null;
  let all = vals.concat(o.compare ?? []);
  if (o.threshold != null) all = all.concat([o.threshold]);
  let min = o.min ?? Math.min(...all);
  let max = o.max ?? Math.max(...all);
  if (o.min == null) {
    const span = max - min || 1;
    min -= span * 0.15;
    max += span * 0.1;
  }
  const fmt = o.fmt ?? ((v: number) => String(v));
  const x = (i: number) => L + (i * (W - L - R)) / (vals.length - 1);
  const y = (v: number) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  let s = "";
  for (let g = 0; g <= 4; g++) {
    const gv = min + ((max - min) * g) / 4;
    const gy = y(gv);
    s += `<line x1="${L}" x2="${W - R}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" class="ch-grid"/>`;
    s += `<text x="${L - 6}" y="${(gy + 3.5).toFixed(1)}" class="ch-tick" text-anchor="end">${esc(fmt(gv))}</text>`;
  }
  (o.labels ?? []).forEach((lb, i) => {
    if (vals.length > 8 && i % 2 && i !== vals.length - 1) return;
    s += `<text x="${x(i).toFixed(1)}" y="${H - B + 16}" class="ch-tick" text-anchor="middle">${esc(lb)}</text>`;
  });
  if (o.threshold != null) {
    const ty = y(o.threshold);
    s += `<line x1="${L}" x2="${W - R}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="ch-thresh"/>`;
    s += `<text x="${W - R + 4}" y="${(ty + 3.5).toFixed(1)}" class="ch-tick ch-thresh-l">${esc(o.threshLabel || "threshold")}</text>`;
  }
  const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  if (o.compare) s += `<path d="${path(o.compare)}" class="ch-line-2"/>`;
  const line = path(vals);
  s += `<path d="${line}L${x(vals.length - 1).toFixed(1)} ${H - B}L${L} ${H - B}Z" class="ch-area"/>`;
  s += `<path d="${line}" class="ch-line"/>`;
  const last = vals[vals.length - 1] ?? 0;
  const lx = x(vals.length - 1);
  const ly = y(last);
  s += `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" class="ch-end"/>`;
  s += `<text x="${(lx + 8).toFixed(1)}" y="${(ly + 4).toFixed(1)}" class="ch-end-l">${esc(fmt(last))}</text>`;
  s += `<line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" class="ch-axis"/>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="ch-axis"/>`;
  if (o.yLabel) s += `<text x="4" y="11" class="ch-ylabel">${esc(o.yLabel)}</text>`;
  return (
    <figure className="chart">
      {o.title ? (
        <figcaption className="chart-title">
          {o.title}
          {o.legend ? <span className="chart-legend">{o.legend}</span> : null}
        </figcaption>
      ) : null}
      <div className="chart-svg" role="img" aria-label={`${o.title || "Chart"}. Latest ${fmt(last)}`} dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${s}</svg>` }} />
    </figure>
  );
}

export interface BarChartProps {
  title?: string;
  rows: Array<{ label: string; value: number; note?: string }>;
  min?: number;
  max?: number;
  fmt?: (v: number) => string;
  xLabel?: string;
  threshold?: number;
  threshLabel?: string;
  emphasis?: "max" | "min";
  ticks?: number;
}

export function BarChart(o: BarChartProps) {
  const rows = o.rows;
  const n = rows.length;
  if (!n) return null;
  const W = 560;
  const rowH = 24;
  const T = 10;
  const B = 34;
  const L = Math.min(210, 14 + 6.3 * Math.max(...rows.map((r) => String(r.label).length)));
  const R = 70;
  const H = T + B + n * rowH;
  const min = o.min ?? 0;
  const max = o.max ?? (Math.max(...rows.map((r) => r.value)) * 1.1 || 1);
  const fmt = o.fmt ?? ((v: number) => String(v));
  const x = (v: number) => L + ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * (W - L - R);
  const ticks = o.ticks ?? 4;
  let s = "";
  for (let g = 0; g <= ticks; g++) {
    const gv = min + ((max - min) * g) / ticks;
    const gx = x(gv);
    s += `<line x1="${gx.toFixed(1)}" x2="${gx.toFixed(1)}" y1="${T}" y2="${H - B}" class="ch-grid"/>`;
    s += `<text x="${gx.toFixed(1)}" y="${H - B + 14}" class="ch-tick" text-anchor="middle">${esc(fmt(gv))}</text>`;
  }
  const ext = rows.reduce((best, r, i) => {
    const b = rows[best];
    return best < 0 || !b || (o.emphasis === "max" ? r.value > b.value : r.value < b.value) ? i : best;
  }, -1);
  rows.forEach((r, i) => {
    const yy = T + i * rowH;
    const bw = x(r.value) - L;
    const em = i === ext && !!o.emphasis;
    s += `<text x="${L - 8}" y="${(yy + rowH / 2 + 4).toFixed(1)}" class="ch-tick bar-cat" text-anchor="end">${esc(r.label)}</text>`;
    s += `<rect x="${L}" y="${yy + 5}" width="${Math.max(1, bw).toFixed(1)}" height="${rowH - 10}" class="bar${em ? " is-em" : ""}"/>`;
    if (em) s += `<rect x="${(L + bw - 3).toFixed(1)}" y="${yy + 2}" width="6" height="${rowH - 4}" class="bar-end"/>`;
    s += `<text x="${(L + bw + 7).toFixed(1)}" y="${(yy + rowH / 2 + 4).toFixed(1)}" class="${em ? "ch-end-l" : "ch-tick bar-val"}">${esc(fmt(r.value) + (r.note ? `  ${r.note}` : ""))}</text>`;
  });
  if (o.threshold != null) {
    const tx = x(o.threshold);
    s += `<line x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${T - 4}" y2="${H - B}" class="ch-thresh"/>`;
    s += `<text x="${(tx + 4).toFixed(1)}" y="${T + 2}" class="ch-tick ch-thresh-l">${esc(o.threshLabel || "")}</text>`;
  }
  s += `<line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" class="ch-axis"/>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="ch-axis"/>`;
  if (o.xLabel) s += `<text x="${((L + W - R) / 2).toFixed(1)}" y="${H - 4}" class="ch-ylabel" text-anchor="middle">${esc(o.xLabel)}</text>`;
  return (
    <figure className="chart chart-bars">
      {o.title ? <figcaption className="chart-title">{o.title}</figcaption> : null}
      <div className="chart-svg" role="img" aria-label={`${o.title || "Bar chart"}: ${rows.map((r) => `${r.label} ${fmt(r.value)}`).join(", ")}`} dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${s}</svg>` }} />
    </figure>
  );
}

/** Horizontal bar list as the prototype's barChart draws it: a right-aligned label, a bar scaled to the largest value, the value. */
export function BarList({ items, label, labelWidth = 150 }: { items: Array<{ label: string; value: number; tone?: "warn" }>; label: string; labelWidth?: number }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="barlist" aria-label={label} style={{ ["--lw" as string]: `${labelWidth}px` }}>
      {items.map((i) => (
        <li key={i.label} className={i.tone ? `is-${i.tone}` : undefined}>
          <span className="barlist-l mono" title={i.label}>{i.label}</span>
          <span className="barlist-t"><span className="barlist-b" style={{ width: `${Math.max(i.value ? 1 : 0, (i.value / max) * 100)}%` }} /></span>
          <span className="barlist-v mono">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}
