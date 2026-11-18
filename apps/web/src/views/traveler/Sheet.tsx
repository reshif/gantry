/** The printable routing sheet, laid out like the prototype's Traveler page: title block with barcode, the facts, and a stamp for every station. */
import { WO_STATES, fmt, gateAfter, type Catalog, type Project } from "@gantry/domain";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { DataTable, type Col } from "../../ui/DataTable";
import { useActors } from "../../ui/actors";
import { classOf } from "../projects/kit";
import type { TWo } from "./model";
import { protoStation, when } from "../dossier/kit";

type Row = { key: string; station: string; agent: string; at: number | null; dur: number; state: "passed" | "now" | "skipped"; gate: string | null };

/** `page`: the sheet sits in the Traveler page, whose header has Print (no print row below the sheet). */
export function Sheet({ wo, cat, project, page }: { wo: TWo; cat: Catalog; project: Project; page?: boolean }) {
  const actor = useActors();
  const h = [...wo.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
  const bars = Array.from({ length: 46 }, (_, i) => ({ x: i * 5, w: 1 + ((h >> (i % 20)) & 3) }));
  const order = project.flow?.order?.length ? project.flow.order : cat.stations.filter((x) => !x.custom).map((x) => x.id);
  const now = Date.now();
  const rows: Row[] = order
    .map((id) => ({ s: cat.stations.find((x) => x.id === id), idx: cat.stations.findIndex((x) => x.id === id) }))
    .filter((r): r is { s: NonNullable<typeof r.s>; idx: number } => !!r.s && (wo.state === "done" || r.idx <= wo.station))
    .map(({ s, idx }) => {
      const visits = wo.history.filter((e) => e.station === s.id);
      const e = visits[visits.length - 1];
      const g = gateAfter(cat, s.id);
      const cur = idx === wo.station && wo.state !== "done";
      const skipped = !visits.length && !wo.route.includes(s.id);
      const human = g && (project.flow?.gates?.[g.id]?.mode ?? g.kind) !== "auto";
      return {
        key: s.id, station: protoStation(s), agent: actor(e?.agent ?? s.agent).name.replace(" (agent)", ""), at: e?.startedAt ?? null,
        dur: visits.reduce((t, v) => t + Math.max(0, (v.endedAt ?? now) - v.startedAt), 0),
        state: skipped ? "skipped" : cur ? "now" : "passed",
        gate: !cur && !skipped && human && wo.gates[g.id]?.status !== "waiting" && wo.gates[g.id]?.status !== "failed" ? g.label : null,
      } as Row;
    });
  const cols: Col<Row>[] = [
    { key: "station", label: "Station", render: (r) => <b>{r.station}</b> },
    { key: "agent", label: "Agent" },
    { key: "at", label: "Arrived", render: (r) => <span className="mono">{r.at ? when(r.at) : ""}</span> },
    { key: "dur", label: "Time", align: "end", render: (r) => <span className="mono">{r.dur ? fmt.dur(r.dur) : ""}</span> },
    { key: "stamp", label: "Stamp", render: (r) => (r.state === "skipped" ? <span className="dim">skipped</span> : r.state === "now" ? <span className="stamp" style={{ "--c": "var(--info)" } as React.CSSProperties}>In progress</span> : <><span className="stamp">Passed</span>{r.gate ? <>{" "}<span className="tag">{`${r.gate} signed`}</span></> : null}</>) },
  ];
  return (
    <div className="traveler trv-sheet" id="trv-sheet">
      <div className="row spread" style={{ alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div className="label">Gantry traveler</div>
          <h2 style={{ font: "700 28px/36px var(--mono)" }}>{wo.id}</h2>
          <p style={{ fontWeight: 600, marginTop: 4 }}>{wo.title}</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <svg width="230" height="34" viewBox="0 0 230 34" role="img" aria-label={`Barcode for ${wo.id}`} style={{ color: "var(--text)" }}>
            {bars.map((b) => <rect key={b.x} x={b.x} y={0} width={b.w} height={34} fill="currentColor" />)}
          </svg>
          <div className="mono dim" style={{ fontSize: 11 }}>{`${wo.id} / ${project.key}`}</div>
        </div>
      </div>
      <dl className="kv" style={{ margin: 0 }}>
        <dt>Project</dt><dd>{project.name}</dd>
        <dt>Class</dt><dd>{`${classOf(cat, project, wo.cls).name} · ${wo.priority}`}</dd>
        <dt>Requested</dt><dd>{`${actor(wo.requestedBy).name} · ${when(wo.createdAt)}`}</dd>
        <dt>Status</dt><dd><span className={`chip ${({ running: "info", waiting: "warn", blocked: "bad", failed: "bad", done: "ok", killed: "bad" } as Record<string, string>)[wo.state] ?? "idle"}`}>{wo.state === "waiting" ? "Gate" : (WO_STATES as Record<string, { label: string }>)[wo.state]?.label ?? wo.state}</span></dd>
      </dl>
      <hr />
      <div className="label" style={{ marginBottom: 8 }}>Station stamps</div>
      <DataTable id="trv-stamps" caption={`Station stamps of ${wo.id}`} columns={cols} rows={rows} rowKey={(r) => r.key} />
      {page ? null : (
        <div className="row" style={{ marginTop: 16 }}>
          <Btn label="Print" kind="primary" icon="dl" id="trv-print" onClick={() => window.print()} />
          <span className="muted small"><Icon name="page" /> The printable record that follows the work order down the line.</span>
        </div>
      )}
    </div>
  );
}
