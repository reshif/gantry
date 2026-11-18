/**
 * Workload (spec 8.9, 13.5). Port of legacy/js/views/workload.js against GET /api/v1/workload: human attention as the scarce resource. Per person and team: approvals
 * waiting, median response, approvals per day, questions answered, after-hours load and the share of waiting gates where they are the only eligible approver; human minutes
 * per work order by class and project; gates ranked by time work waits on people; suggestions that deep-link to the fix. The server computes everything from the work order
 * records and scopes it to the projects the viewer sees. Counts sit beside every rate; small samples say "insufficient data".
 * Deep links: approver rules and trust open their screen on the right project (the tab and gate are not selectable from outside those screens).
 */
import { useState } from "react";
import { useCan } from "../api/can";
import { useAccessMatrix, useMe, usePeople, useProjects, useWorkload, useWorkOrdersAcross } from "../api/queries";
import type { Workload, WorkloadSuggestion } from "../api/types";
import type { Person } from "@gantry/domain";
import { Avatar, Btn, Chip, Field, FilterBar, Meter, Panel, Segmented, SearchBox, Select, Stat, StatRow, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { BarList } from "../ui/charts";
import { DataTable } from "../ui/DataTable";
import { hashFor, navigate } from "../lib/router";
import { useUI } from "../ui/overlay-context";
import { dec } from "./mcp/kit";
import { DelegateDialog } from "./workload/Delegate";
import { useCatalog, metricsOf, type PView } from "./projects/kit";
import { CountClear, PAGE_SIZE, Pager, parseSort, setQS, sortParam, useQS } from "./govern/kit";
import { goConfig, goPerson, goTrust, useDelegateGuard } from "./workload/kit";

function SuggestionItem({ s, openDelegate }: { s: WorkloadSuggestion; m: Workload; openDelegate: (pid: string) => void }) {
  const a = s.action;
  const cfg = dec(useCan("approvers.edit", a.project ? { project: a.project } : {}));
  const del = useDelegateGuard(a.person ?? "");
  const guard = a.type === "config" ? cfg : a.type === "delegate" ? del : null;
  const run = (): void => {
    if (a.type === "config" && a.project) goConfig(a.project);
    else if (a.type === "delegate" && a.person) openDelegate(a.person);
    else if (a.type === "person" && a.person) goPerson(a.person);
    else if (a.type === "trust") goTrust(a.project);
  };
  const label = s.kind === "trust" ? "Raise trust" : s.kind === "delegate" ? "Delegate" : "Add an approver";
  return (
    <li className={`wl-sg wl-sg-${s.kind}`}>
      <Chip text={label} cls={s.kind === "trust" ? "chip-ok" : "chip-accent"} />
      <p className="wl-sg-text">{s.text}</p>
      <Btn label={a.label} small id={a.id} guard={guard && !guard.allowed ? guard : null} onClick={run} />
    </li>
  );
}

interface PRow { p: Person; approver: boolean; mine: number; waiting: number; acts: number; oncall: boolean }

export default function WorkloadView() {
  const ui = useUI();
  const me = useMe();
  const [allSugg, setAllSugg] = useState(false);
  const [days, setDays] = useQS("wl.days", "7");
  const q = useWorkload("all", Number(days) || 7);
  const projects = useProjects();
  const peopleQ = usePeople();
  const matrix = useAccessMatrix().data;
  const cat = useCatalog();
  const m = q.data;
  const visible = (projects.data ?? me?.projects ?? []).filter((p) => (p as { status?: string }).status !== "archived");
  const wos = useWorkOrdersAcross(visible.map((p) => p.id));

  if (!me) return null;
  // until the snapshot arrives the page is its header and the shared loading, not-visible or failed state
  if (!m) return <div className="view view-workload"><ViewHead title="Workload" kicker="All lines" /><Async query={q} what="workload" id="wl">{() => null}</Async></div>;

  const openDelegate = (pid: string): void => {
    const row = m.rows.find((r) => r.person === pid);
    ui.open((close) => <DelegateDialog pid={pid} away={row?.away ?? null} close={close} />);
  };
  const t = m.totals;
  const sugg = m.suggestions;

  // gates and stations across every project the viewer sees (the sheet is factory-wide)
  const plist = projects.data as PView[] | undefined;
  const sumBy = (pick: (mm: ReturnType<typeof metricsOf>) => Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of plist ?? []) for (const [k, v] of Object.entries(pick(metricsOf(p)))) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const byGate = sumBy((x) => x.byGate);
  const byPos = sumBy((x) => Object.fromEntries(Object.entries(x.byPosition).map(([k, v]) => [k, v.n])));
  const gateItems = (cat?.gates ?? []).filter((g) => g.kind !== "auto").map((g) => ({ label: `${g.label} ${g.name}`, value: byGate[g.id] ?? 0, tone: "warn" as const }));
  const stationItems = (cat?.stations ?? []).filter((s) => !s.custom).map((s) => ({ label: s.name, value: byPos[s.id] ?? 0 }));
  const oldest = Math.max(0, ...m.bottlenecks.map((b) => (b.open ? b.oldestMin : 0)));

  // one row per active person: can they approve (the role matrix grants gate.approve), what they asked for, what sits at a gate, what they did
  const canApprove = (p: Person): boolean => p.roles.some((g) => !!matrix?.matrix?.[g.role]?.["gate.approve"]);
  const acts = new Map(m.rows.map((r) => [r.person, r.approvals + r.answered]));
  const oncall = new Set(m.rows.filter((r) => r.oncall).map((r) => r.person));
  const rows: PRow[] = (peopleQ.data ?? []).filter((p) => p.status === "active").map((p) => {
    const mine = wos.items.filter((w) => w.requestedBy === p.id && w.state !== "done" && w.state !== "killed");
    return { p, approver: canApprove(p), mine: mine.length, waiting: mine.filter((w) => w.state === "waiting").length, acts: acts.get(p.id) ?? 0, oncall: p.oncall || oncall.has(p.id) };
  });

  return (
    <div className="view view-workload">
      <ViewHead title="Workload" kicker="All lines" sub="Who is carrying the approvals, and where the queue is building up." />
      <StatRow id="wl-stats">
        <Stat label="Approvals waiting" value={String(t.gatesWaiting)} sub="across people" tone={t.gatesWaiting > 10 ? "wait" : undefined} />
        <Stat label="Approvers" value={String(rows.filter((r) => r.approver).length)} sub="active" />
        <Stat label="On call" value={String(rows.filter((r) => r.oncall).length)} />
        <Stat label="Oldest wait" value={oldest ? `${Math.round(oldest / 60)} h` : "\u2014"} sub="at a gate" tone={oldest ? "wait" : undefined} />
      </StatRow>
      <div className="cols wl-charts">
        <Panel title="Queue by gate"><BarList label="Approvals waiting by gate" items={gateItems} labelWidth={150} valueAtEnd /></Panel>
        <Panel title="Work by station"><BarList label="Open work by station" items={stationItems} labelWidth={110} valueAtEnd /></Panel>
      </div>
      <div style={{ height: 16 }} />
      <PeoplePanel rows={rows} days={days} setDays={setDays} failed={wos.failed} />
      {sugg.length ? (
        <Panel title="Suggestions" cls="wl-sugg" tools={sugg.length > 5 ? <Btn label={allSugg ? "Show top 5" : `Show all ${sugg.length}`} small id="wl-sugg-all" onClick={() => setAllSugg(!allSugg)} /> : undefined}>
          <ol className="wl-sugg-list">{sugg.slice(0, allSugg ? sugg.length : 5).map((s) => <SuggestionItem key={s.key} s={s} m={m} openDelegate={openDelegate} />)}</ol>
        </Panel>
      ) : null}
    </div>
  );
}

function PeoplePanel({ rows, days, setDays, failed }: { rows: PRow[]; days: string; setDays: (v: string) => void; failed: boolean }) {
  const [qv, ] = useQS("wl.q");
  const [appr] = useQS("wl.approver");
  const [sortV] = useQS("wl.sort");
  const [pageV] = useQS("wl.page", "0");
  const s = qv.trim().toLowerCase();
  const filtered = rows.filter((r) => (!s || r.p.name.toLowerCase().includes(s)) && (!appr || (appr === "yes") === r.approver));
  const sort = parseSort(sortV, { key: "mine", dir: -1 });
  const val = (r: PRow): number | string => (sort.key === "n" ? r.p.name : sort.key === "a" ? Number(r.approver) : sort.key === "w" ? r.waiting : sort.key === "ac" ? r.acts : r.mine);
  const sorted = [...filtered].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, Number(pageV) || 0), pages - 1);
  const vis = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const on = !!(qv || appr);
  const clear = () => setQS({ "wl.q": "", "wl.approver": "", "wl.page": "" });
  return (
    <Panel title="People" flush id="wl-people-panel" tools={<Segmented name="wl-days" label="Window for actions logged" value={days} onChange={setDays} items={[{ id: "1", label: "24 hours" }, { id: "7", label: "7 days" }]} />}>
      <FilterBar label="Filter people" count={<CountClear n={filtered.length} of={rows.length} noun="person" active={on} onClear={clear} />}>
        <SearchBox id="wl-q" value={qv} onChange={(v) => setQS({ "wl.q": v, "wl.page": "" })} placeholder={"Search\u2026"} label="Search person" />
        <Field label="Approver" htmlFor="wl-f-approver"><Select id="wl-f-approver" value={appr} onChange={(v) => setQS({ "wl.approver": v, "wl.page": "" })} options={[{ value: "", label: "All" }, { value: "yes", label: "Approvers" }, { value: "no", label: "Others" }]} /></Field>
      </FilterBar>
      <DataTable<PRow>
        id="wl-people"
        caption="Workload per person"
        rows={vis}
        rowKey={(r) => r.p.id}
        rowId={(r) => `wl-row-${r.p.id}`}
        onRow={(r) => goPerson(r.p.id)}
        sort={sort}
        onSort={(x) => setQS({ "wl.sort": sortParam(x), "wl.page": "" })}
        empty={rows.length
          ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" id="wl-clear" onClick={clear} /> }
          : { title: "Nothing here yet", text: "Items will appear here when they exist." }}
        columns={[
          { key: "n", label: "Person", sort: (r) => r.p.name, render: (r) => <div className="row" style={{ flexWrap: "nowrap" }}><Avatar id={r.p.id} /><a className="pri" href={hashFor("person", r.p.id)} onClick={(e) => { e.preventDefault(); navigate("person", r.p.id); }}>{r.p.name}</a></div> },
          { key: "a", label: "Can approve", sort: (r) => Number(r.approver), render: (r) => <Chip text={r.approver ? "yes" : "no"} cls={r.approver ? "ok" : "plain"} /> },
          { key: "mine", label: "Open requests", align: "end", sort: (r) => r.mine, render: (r) => <span className="num">{failed ? "n/a" : r.mine}</span> },
          { key: "w", label: "At a gate", align: "end", sort: (r) => r.waiting, render: (r) => <span className="num">{failed ? "n/a" : r.waiting}</span> },
          { key: "ac", label: "Actions logged", align: "end", sort: (r) => r.acts, render: (r) => <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}><div style={{ width: 80 }}><Meter value={Math.min(25, r.acts)} max={25} label="Actions logged" /></div><span className="num">{r.acts}</span></div> },
          { key: "o", label: "On call", render: (r) => (r.oncall ? <Chip text="on call" cls="info" /> : "\u2014") },
        ]}
      />
      <Pager id="wl-pager" page={page} total={sorted.length} onPage={(n) => setQS({ "wl.page": n ? String(n) : "" })} />
    </Panel>
  );
}
