/** The four tabs of the Workload screen: people, teams, where work waits, and human minutes per work order. */
import { fmt } from "@gantry/domain";
import { useCan } from "../../api/can";
import type { Workload, WorkloadBottleneck, WorkloadMinutes, WorkloadRow, WorkloadTeam } from "../../api/types";
import { useCatalog } from "../projects/kit";
import { useProjects } from "../../api/queries";
import { Btn, Who } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { BarChart } from "../../ui/charts";
import { SortTable, type SortCol, type SortState } from "../../ui/SortTable";
import { useOpenTraveler } from "../../shell/useTraveler";
import { dec } from "../mcp/kit";
import { Bar, MIN_N, MINUTES_NOTE, MedianCell, Rate, goConfig, mins, teamName } from "./kit";

type Sorts = Record<string, SortState>;
interface Ctx {
  m: Workload;
  sorts: Sorts;
  setSort: (id: string, s: SortState) => void;
  openPerson: (pid: string) => void;
}

export function PeopleTab({ m, sorts, setSort, openPerson }: Ctx) {
  const maxMin = Math.max(1, ...m.rows.map((r) => r.minutes));
  const cols: SortCol<WorkloadRow>[] = [
    { key: "name", label: "Person", sort: true, render: (r) => <span className="wl-who"><Who id={r.person} />{r.away ? <span className="chip chip-warn"><Icon name="swap" />away</span> : null}{r.oncall ? <span className="chip chip-accent">on call</span> : null}</span> },
    { key: "team", label: "Team", sort: (r) => teamName(m, r.team), hideSmall: true, render: (r) => teamName(m, r.team) },
    { key: "waiting", label: "Waiting", sort: true, align: "end", render: (r) => <span><span className="mono strong">{String(r.waiting)}</span>{r.glass ? <span className="wl-n mono" title="Gates a Factory Admin could decide only as break-glass">{` +${r.glass} break-glass`}</span> : null}</span> },
    { key: "medianResponseMin", label: "Median response", sort: (r) => (r.waitN >= MIN_N ? r.medianResponseMin ?? -1 : -1), align: "end", render: (r) => <MedianCell m={r.medianResponseMin} n={r.waitN} /> },
    { key: "perDay", label: "Approvals / day", sort: true, align: "end", render: (r) => <span className="wl-rate"><span className="mono">{r.perDay.toFixed(1)}</span><span className="wl-n mono">{`${r.approvals} in ${m.days}d`}</span></span> },
    { key: "answered", label: "Questions answered", sort: true, align: "end", render: (r) => <span className="mono">{String(r.answered)}</span> },
    { key: "afterHours", label: "After hours", sort: (r) => (r.n >= MIN_N ? r.afterHours / r.n : -1), align: "end", render: (r) => <Rate num={r.afterHours} den={r.n} /> },
    { key: "sole", label: "Sole approver", sort: (r) => (r.waiting ? r.sole / r.waiting : -1), align: "end", render: (r) => (r.waiting ? <span className={`wl-rate${r.sole ? " is-warn" : ""}`}>{r.sole ? <Icon name="alert" /> : null}<span className="mono">{`${r.sole} of ${r.waiting}`}</span><span className="wl-n mono">{fmt.pct(r.sole / r.waiting)}</span></span> : <span className="muted small">none waiting</span>) },
    { key: "minutes", label: "Human minutes", sort: true, align: "end", render: (r) => <span className="wl-mincell"><Bar v={r.minutes} max={maxMin} /><span className="mono">{String(r.minutes)}</span></span> },
  ];
  return <SortTable<WorkloadRow> id="wl-people" caption="Workload per person" columns={cols} rows={m.rows} rowKey={(r) => r.person} onRow={(r) => openPerson(r.person)} sort={sorts["wl-people"] ?? { key: "minutes", dir: -1 }} onSort={(s) => setSort("wl-people", s)} empty={{ title: "No human activity", text: "Nobody approved, confirmed or answered anything in this window and scope." }} />;
}

export function TeamsTab({ m, sorts, setSort }: Ctx) {
  const cols: SortCol<WorkloadTeam>[] = [
    { key: "name", label: "Team", sort: true, render: (t) => <strong>{t.name}</strong> },
    { key: "people", label: "People active", sort: true, align: "end" },
    { key: "waiting", label: "Waiting", sort: true, align: "end", render: (t) => <span className="mono strong">{String(t.waiting)}</span> },
    { key: "medianResponseMin", label: "Median response", sort: true, align: "end", render: (t) => <MedianCell m={t.medianResponseMin} n={t.waitN} /> },
    { key: "approvals", label: "Approvals / day", sort: true, align: "end", render: (t) => <span className="wl-rate"><span className="mono">{(t.approvals / m.days).toFixed(1)}</span><span className="wl-n mono">{`${t.approvals} in ${m.days}d`}</span></span> },
    { key: "answered", label: "Questions answered", sort: true, align: "end" },
    { key: "afterHours", label: "After hours", sort: (t) => (t.n >= MIN_N ? t.afterHours / t.n : -1), align: "end", render: (t) => <Rate num={t.afterHours} den={t.n} /> },
    { key: "sole", label: "Sole-approver gates", sort: true, align: "end", render: (t) => <span className={`mono${t.sole ? " wl-warn" : ""}`}>{String(t.sole)}</span> },
    { key: "minutes", label: "Human minutes", sort: true, align: "end", render: (t) => <span className="mono">{String(t.minutes)}</span> },
  ];
  return <SortTable<WorkloadTeam> id="wl-teams" caption="Workload per team" columns={cols} rows={m.teams} rowKey={(t) => t.team} sort={sorts["wl-teams"] ?? { key: "minutes", dir: -1 }} onSort={(s) => setSort("wl-teams", s)} empty={{ title: "No team activity", text: "No team members acted in this window and scope." }} />;
}

function ApproverRulesBtn({ b }: { b: WorkloadBottleneck }) {
  const perm = dec(useCan("approvers.edit", { project: b.project }));
  return <Btn label="Approver rules" small kind="ghost" id={`wl-bn-cfg-${b.project}-${b.gate}`} guard={perm} onClick={() => goConfig(b.project)} />;
}

export function WaitsTab({ m, sorts, setSort }: Ctx) {
  const cat = useCatalog();
  const projects = useProjects().data ?? [];
  const openTraveler = useOpenTraveler();
  const gate = (id: string) => cat?.gates.find((g) => g.id === id);
  const gateLabel = (id: string): string => gate(id)?.label ?? id;
  const projName = (id: string): string => projects.find((p) => p.id === id)?.name ?? id;
  const cols: SortCol<WorkloadBottleneck>[] = [
    { key: "gate", label: "Gate", sort: (b) => gateLabel(b.gate), render: (b) => { const st = b.station ? cat?.stations.find((s) => s.id === b.station) : undefined; return <span className="wl-gate"><span className="wl-dia" aria-hidden="true" /><span className="mono strong">{gateLabel(b.gate)}</span><span className="muted small">{(gate(b.gate)?.name ?? "") + (st ? ` · after ${st.name}` : "")}</span></span>; } },
    { key: "project", label: "Project", sort: (b) => projName(b.project), render: (b) => projName(b.project) },
    { key: "medianWaitMin", label: "Median wait on people", sort: (b) => (b.decisions >= MIN_N ? b.medianWaitMin ?? -1 : b.decisions ? (b.medianWaitMin ?? 0) / 1000 : -1), align: "end", render: (b) => <MedianCell m={b.medianWaitMin} n={b.decisions} /> },
    { key: "open", label: "Waiting now", sort: true, align: "end", render: (b) => (b.open ? <span className="mono strong">{String(b.open)}</span> : <span className="muted">0</span>) },
    { key: "oldestMin", label: "Oldest", sort: true, align: "end", render: (b) => (b.open ? <span className="mono">{mins(b.oldestMin)}</span> : "–") },
    { key: "minEligible", label: "Eligible approvers", sort: (b) => (b.minEligible == null ? 99 : b.minEligible), align: "end", render: (b) => (b.minEligible == null ? "–" : <span className={`mono${b.minEligible <= 1 ? " wl-warn" : ""}`}>{b.minEligible <= 1 ? `only ${b.minEligible}` : String(b.minEligible)}</span>) },
    { key: "act", label: "", render: (b) => <ApproverRulesBtn b={b} /> },
  ];
  const np = m.needsPerson;
  return (
    <div className="wl-waits">
      <p className="muted small">Human and mixed gates ranked by how long work waited for a person: decisions in the window plus gates waiting now. Automatic gates and gates passed under trust do not wait on people.</p>
      <SortTable<WorkloadBottleneck> id="wl-bottlenecks" caption="Gates ranked by wait on people" columns={cols} rows={m.bottlenecks} rowKey={(b) => `${b.project}:${b.gate}`} sort={sorts["wl-bottlenecks"] ?? { key: "medianWaitMin", dir: -1 }} onSort={(s) => setSort("wl-bottlenecks", s)} empty={{ title: "Nothing waits on people", text: "No human gate decisions or waiting gates in this scope." }} />
      <h3 className="sub-h">Waiting for an answer</h3>
      {np.length ? (
        <ul className="wl-list">{np.map((w) => <li key={w.id}><button type="button" className="linkish mono" id={`wl-np-${w.id}`} onClick={() => openTraveler(w.id)}>{w.id}</button><span className="small">{w.title}</span><span className="muted small">{projName(w.project) + (w.bayReason ? ` · ${w.bayReason}` : "")}</span></li>)}</ul>
      ) : <p className="muted small">No work order is parked in Needs a person.</p>}
    </div>
  );
}

export function MinutesTab({ m, sorts, setSort }: Ctx) {
  const cat = useCatalog();
  const projects = useProjects().data ?? [];
  const clsName = (k: string): string => cat?.classes.find((c) => c.id === k)?.name ?? k;
  const projName = (k: string): string => projects.find((p) => p.id === k)?.name ?? k;
  function Block({ title, rows, label, id }: { title: string; rows: WorkloadMinutes[]; label: (k: string) => string; id: string }) {
    if (!rows.length) return <div className="empty empty-state" id={`${id}-empty`}><div className="empty-icon" aria-hidden="true"><Icon name="workload" /></div><div className="empty-title">No human minutes</div><p>No approvals, confirmations or answers in this window and scope.</p></div>;
    const cols: SortCol<WorkloadMinutes>[] = [
      { key: "key", label: title.split(" by ")[1] ?? "Key", sort: (r) => label(r.key), render: (r) => label(r.key) },
      { key: "perWO", label: "Minutes / WO", sort: true, align: "end", render: (r) => (r.workOrders < MIN_N ? <span className="wl-insuf"><span className="mono">{r.perWO.toFixed(1)}</span><span className="wl-insuf-l">insufficient data</span></span> : <span className="mono">{r.perWO.toFixed(1)}</span>) },
      { key: "workOrders", label: "Work orders", sort: true, align: "end" },
      { key: "minutes", label: "Total minutes", sort: true, align: "end" },
    ];
    return (
      <div className="wl-minblock">
        <BarChart title={title} rows={rows.map((r) => ({ label: label(r.key), value: Math.round(r.perWO * 10) / 10, note: r.workOrders < MIN_N ? `(n=${r.workOrders}, insufficient data)` : `(n=${r.workOrders})` }))} fmt={(v) => `${Math.round(v * 10) / 10}m`} xLabel="Human minutes per work order" emphasis="max" />
        <SortTable<WorkloadMinutes> id={id} caption={title} columns={cols} rows={rows} rowKey={(r) => r.key} sort={sorts[id] ?? { key: "perWO", dir: -1 }} onSort={(s) => setSort(id, s)} />
      </div>
    );
  }
  return (
    <div className="wl-mins">
      <p className="muted small">{`Estimated from real acts: ${MINUTES_NOTE}. Classes and projects with fewer than ${MIN_N} work orders are marked.`}</p>
      <div className="wl-mins-grid">
        {Block({ title: "Human minutes by class", rows: m.byCls, label: clsName, id: "wl-min-cls" })}
        {m.ids.length > 1 ? Block({ title: "Human minutes by project", rows: m.byProject, label: projName, id: "wl-min-proj" }) : null}
      </div>
    </div>
  );
}
