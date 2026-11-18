/**
 * Traveler page (#/p/<project>/traveler/<WO>): the prototype's routing sheet as a page. A Route diagram (one square per station, dashed when the
 * class skips it) and a Station by station table. The drawer (views/traveler/Drawer) stays the quick view opened from lists.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { flowOf, fmt, gateAfter } from "@gantry/domain";
import { navigate, useHash } from "../../lib/router";
import { Btn, Chip, Empty, Panel, ViewHead } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/DataTable";
import { Loading } from "../../ui/async";
import { useActors } from "../../ui/actors";
import { splitQuery } from "../dossier/hashQuery";
import { fmtDate, minutes, plainName } from "../dossier/time";
import { useRecordData } from "../record/data";
import { clsName } from "./model";

interface Row { id: string; no: string; name: string; agent: string; skip: boolean; run: { startedAt: number; endedAt: number | null; cost: number; outcome: string | null } | null; gate: { label: string; status: string } | null }

/** The route diagram scrolls sideways when the stations do not fit (at least 78px each), with an edge fade and a "scroll" cue. */
function ScrollWrap({ children }: { children: (w: number) => React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(960);
  const [edge, setEdge] = useState({ ml: false, mr: false });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const upd = () => {
      setW(Math.floor(el.clientWidth) || 960);
      setEdge({ ml: el.scrollLeft > 4, mr: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
    };
    upd();
    el.addEventListener("scroll", upd, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(upd);
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", upd); ro?.disconnect(); };
  }, []);
  return (
    <div className={`scrollwrap${edge.ml ? " ml" : ""}${edge.mr ? " mr" : ""}`}>
      <div className="sf l" />
      <div className="sf r" />
      <div className="sh">scroll →</div>
      <div ref={box} className="fluid tw" role="group" aria-label="Route diagram, scrolls sideways">{children(w)}</div>
    </div>
  );
}

export default function TravelerPage() {
  const hash = useHash();
  const actor = useActors();
  const id = splitQuery(hash.param).id.toUpperCase();
  const d = useRecordData(id || null);
  if (!id || (!d.loading && (d.error || !d.wo || !d.project || !d.cat))) {
    return (
      <div className="view rec-view" id="trv-missing">
        <ViewHead plain title="Traveler" />
        <Panel><Empty title="Nothing to show" text="That work order does not exist." action={<Btn label="Work orders" id="trv-missing-wos" onClick={() => navigate("work-orders")} />} /></Panel>
      </div>
    );
  }
  if (d.loading || !d.wo || !d.project || !d.cat) return <div className="view rec-view"><Loading id="trv-page-loading" label="the traveler" /></div>;
  const { wo, project, cat } = d;
  const stations = flowOf(cat, project).stations;
  const route = (wo as { route?: string[] }).route ?? stations.map((s) => s.id);
  const cur = cat.stations[wo.station]?.id;
  const ci = Math.max(0, stations.findIndex((s) => s.id === cur));
  const rows: Row[] = stations.map((s) => {
    const run = wo.history.find((h) => h.station === s.id) ?? null;
    const g = gateAfter(cat, s.id);
    const gs = g ? wo.gates[g.id] : undefined;
    return { id: s.id, no: s.no, name: s.name, agent: s.agent, skip: !route.includes(s.id), run, gate: g ? { label: g.label, status: gs?.status ?? "n/a" } : null };
  });
  const cols: Array<Col<Row>> = [
    { key: "st", label: "Station", render: (r) => <div><b>{`${r.no} ${r.name}`}</b>{r.skip ? <span className="sub">skipped</span> : null}</div> },
    { key: "ag", label: "Agent", render: (r) => plainName(actor(r.agent).name) },
    { key: "started", label: "Started", render: (r) => (fmtDate(r.run?.startedAt)) },
    { key: "dur", label: "Duration", render: (r) => (r.run ? (r.run.endedAt ? minutes(r.run.endedAt - r.run.startedAt) : "running") : "—") },
    { key: "cost", label: "Cost", render: (r) => (r.run ? fmt.money(r.run.cost) : "—") },
    { key: "out", label: "Outcome", render: (r) => (r.run ? (r.run.outcome ? <Chip text={r.run.outcome} cls={r.run.outcome === "passed" ? "ok" : "bad"} /> : <Chip text="active" cls="info" />) : <Chip text={r.skip ? "skipped" : "not reached"} />) },
    { key: "gate", label: "Gate", render: (r) => (r.gate ? <span><span className="mono">{`${r.gate.label} `}</span><Chip text={r.gate.status} cls={r.gate.status === "passed" ? "ok" : r.gate.status === "waiting" ? "warn" : ""} /></span> : "—") },
  ];
  return (
    <div className="view rec-view trv-page">
      <ViewHead
        plain
        kicker={<span style={{ display: "inline-flex", gap: 8 }}><a href="#work-orders" onClick={(e) => { e.preventDefault(); navigate("work-orders", null, wo.project); }}>Work orders</a><span aria-hidden="true">/</span><a href={`#record/${wo.id}`} onClick={(e) => { e.preventDefault(); navigate("record", wo.id, wo.project); }}>{wo.id}</a><span aria-hidden="true">/</span><span>Traveler</span></span>}
        title={`Traveler · ${wo.id}`}
        sub={wo.title}
        actions={<><Btn label="Record" id="trv-page-record" onClick={() => navigate("record", wo.id, wo.project)} /><Btn label="Print" icon="dl" id="trv-page-print" onClick={() => window.print()} /></>}
      />
      <Panel title="Route">
        <div className="trv-route">
          <ScrollWrap>
            {(cw) => {
              const W = Math.max(cw, stations.length * 78);
              const bw = W / Math.max(1, stations.length);
              return (
                <svg className="chart" viewBox={`0 0 ${W} 90`} width={W > cw ? W : "100%"} height={90} role="img" aria-label={`Route of ${wo.id}`}>
                  <line x1={10} x2={W - 10} y1={34} y2={34} stroke="var(--ink2)" strokeWidth={3} opacity={0.4} />
                  {stations.map((s, i) => {
                    const x = i * bw + bw / 2;
                    const done = i < ci || wo.state === "done";
                    const skip = !route.includes(s.id);
                    const now = i === ci && wo.state !== "done";
                    return (
                      <g key={s.id}>
                        <rect x={x - 11} y={23} width={22} height={22} fill={done ? "var(--accent)" : now ? "var(--warn-bg)" : "var(--surface)"} stroke={now ? "var(--warn)" : "var(--ink2)"} strokeWidth={1.5} strokeDasharray={skip ? "3 2" : undefined} />
                        <text x={x} y={38} textAnchor="middle" style={done ? { fill: "var(--accent-ink)" } : undefined}>{i + 1}</text>
                        <text x={x} y={62} textAnchor="middle">{s.name.split(" ")[0]!.slice(0, 10)}</text>
                        {skip ? <text x={x} y={76} textAnchor="middle">skipped</text> : now ? <text x={x} y={76} textAnchor="middle" style={{ fill: "var(--warn)" }}>{wo.id}</text> : null}
                      </g>
                    );
                  })}
                </svg>
              );
            }}
          </ScrollWrap>
          <div className="small muted">{`Dashed squares are stations skipped for class ${clsName(cat, wo.cls)}.`}</div>
        </div>
      </Panel>
      <Panel title="Station by station" flush>
        <DataTable id="trv-page-stations" caption={`Stations of ${wo.id}`} columns={cols} rows={rows} rowKey={(r) => r.id} empty={{ title: "No stations", text: "" }} />
      </Panel>
    </div>
  );
}
