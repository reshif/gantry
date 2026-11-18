import { Fragment } from "react";
/** Design-system page pieces that need a little data of their own, kept out of the view file. */
import { Chip, Empty, Field, Meter, Segmented, Select, Status as StatusChip, Tabs, TextInput, Toggle, Btn } from "../../ui/primitives";
import { DataTable } from "../../ui/DataTable";

export { Btn, Chip, Empty, Field, Meter, Segmented, Select, StatusChip, Tabs, TextInput, Toggle };

/** Priority pill (prototype `G.pri`). */
export const PriTag = ({ p }: { p: string }) => <span className={`tag pri ${p.toLowerCase()}`} title={`Priority ${p}`}>{p}</span>;

/** Prototype meter: a bar whose tone follows the value (ok under 65, warn to 85, bad above). */
export function ProtoMeter({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return <div className={`meter ${p > 85 ? "bad" : p > 65 ? "warn" : "ok"}`} role="meter" aria-label="Usage" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${p}%` }} /></div>;
}

const SAMPLE_STATIONS = ["Intake", "Research", "Spec", "Design", "Plan", "Build", "Verify", "Review and merge", "Release"];

/** The work-order pipeline drawn the prototype way: numbered stations, done ticks, the current one lit by state. */
export function SamplePipe({ current, state }: { current: number; state: "gate" | "blocked" | "running" }) {
  return (
    <div className="pipe" aria-label="Pipeline">
      {SAMPLE_STATIONS.map((name, i) => {
        const done = i < current;
        const cur = i === current;
        const tone = cur ? (state === "gate" ? "warn" : state === "blocked" ? "bad" : "") : "";
        return (
          <Fragment key={name}>
            {i ? <span className={`ln${done ? " done" : ""}`} /> : null}
            <span className={`st${done ? " done" : ""}${cur ? ` cur ${tone}` : ""}`}><i>{done ? "✓" : i + 1}</i>{name}</span>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Prototype donut: stroked arcs with the total in the middle. */
export function Donut({ parts, size = 96 }: { parts: Array<{ l: string; v: number; c: string }>; size?: number }) {
  const r = size / 2 - 8;
  const C = 2 * Math.PI * r;
  const tot = parts.reduce((s, p) => s + p.v, 0) || 1;
  let off = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={parts.map((p) => `${p.l} ${p.v}`).join(", ")}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth="12" />
      {parts.map((p) => {
        const len = (p.v / tot) * C;
        const el = <circle key={p.l} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`var(--${p.c})`} strokeWidth="12" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
        off += len;
        return el;
      })}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="var(--text)" fontFamily="var(--mono)" fontWeight="600" fontSize="18">{tot}</text>
    </svg>
  );
}

interface Row { id: string; title: string; state: string; age: string }
const ROWS: Row[] = [
  { id: "WO-1004", title: "Rate limit the payout API", state: "Gate G5", age: "3h 20m" },
  { id: "WO-1012", title: "Fix cart total flicker", state: "Running", age: "1h 05m" },
];

export function DataTableDemo() {
  return (
    <DataTable<Row>
      caption="Example work orders"
      rows={ROWS}
      rowKey={(r) => r.id}
      columns={[
        { key: "id", label: "ID", render: (r) => <b className="mono">{r.id}</b> },
        { key: "title", label: "Title" },
        { key: "state", label: "State", render: (r) => <Chip text={r.state} cls={r.state === "Running" ? "info" : "warn"} /> },
        { key: "age", label: "Age", align: "end", render: (r) => <span className="mono">{r.age}</span> },
      ]}
    />
  );
}
