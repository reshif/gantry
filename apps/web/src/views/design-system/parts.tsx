/** Design-system page pieces that need a little data of their own, kept out of the view file. */
import { useEffect, useState } from "react";
import { Chip, Empty, Field, Input, Meter, Segmented, Select, Status as StatusChip, Tabs, Toggle, Btn } from "../../ui/primitives";
import { DataTable } from "../../ui/DataTable";

export { Btn, Chip, Empty, Field, Meter, Segmented, Select, StatusChip, Tabs, Toggle };

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

/** The Name field of the example dialog: validates like the prototype (required, then at least 3 characters). */
export function NameBody({ bind }: { bind: (validate: () => boolean) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    bind(() => {
      const v = name.trim();
      const msg = !v ? "Name is required." : v.length < 3 ? "Name needs at least 3 characters." : "";
      setErr(msg);
      return !msg;
    });
  }, [name, bind]);
  return (
    <Field label={<>Name <span className="dim">(required)</span></>} error={err || undefined}>
      <Input id="ds-dlg-name" name="t" value={name} onChange={(e) => setName(e.target.value)} />
    </Field>
  );
}

const STATIONS = ["Intake", "Research", "Spec", "Design", "Plan", "Build", "Verify", "Review and merge", "Release"];

/** The pipeline sample: a feature at station 5 waiting at a gate (prototype `G.pipe`). */
export function PipeSample({ current = 4 }: { current?: number }) {
  return (
    <div className="pipe" aria-label="Pipeline">
      {STATIONS.map((n, i) => {
        const done = i < current;
        const cur = i === current;
        return (
          <span key={n} style={{ display: "contents" }}>
            {i ? <span className={`ln${done ? " done" : ""}`} /> : null}
            <span className={`st${done ? " done" : ""}${cur ? " cur warn" : ""}`}><i>{done ? "✓" : i + 1}</i>{n}</span>
          </span>
        );
      })}
    </div>
  );
}

/** A ring split into toned parts, the total in the middle (prototype `G.donut`). */
export function Donut({ parts, size = 96 }: { parts: Array<{ l: string; v: number; c: string }>; size?: number }) {
  const r = size / 2 - 8;
  const C = 2 * Math.PI * r;
  const tot = parts.reduce((a, p) => a + p.v, 0) || 1;
  let off = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={parts.map((p) => `${p.l} ${p.v}`).join(", ")}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={12} />
      {parts.map((p) => {
        const len = (p.v / tot) * C;
        const o = off;
        off += len;
        return <circle key={p.l} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`var(--${p.c})`} strokeWidth={12} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-o} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
      })}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="var(--text)" fontFamily="var(--mono)" fontWeight={600} fontSize={18}>{tot}</text>
    </svg>
  );
}
