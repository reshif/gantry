/**
 * Workload (spec 8.9, 13.5). Port of legacy/js/views/workload.js against GET /api/v1/workload: human attention as the scarce resource. Per person and team: approvals
 * waiting, median response, approvals per day, questions answered, after-hours load and the share of waiting gates where they are the only eligible approver; human minutes
 * per work order by class and project; gates ranked by time work waits on people; suggestions that deep-link to the fix. The server computes everything from the work order
 * records and scopes it to the projects the viewer sees. Counts sit beside every rate; small samples say "insufficient data".
 * Deep links: approver rules and trust open their screen on the right project (the tab and gate are not selectable from outside those screens).
 */
import { useState } from "react";
import { useCan } from "../api/can";
import { useMe, useWorkload } from "../api/queries";
import type { Workload, WorkloadSuggestion } from "../api/types";
import { Btn, Empty, Field, Segmented, Select, Tabs, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { Icon } from "../ui/Icon";
import { fmt } from "@gantry/domain";
import { useUI } from "../ui/overlay-context";
import type { SortState } from "../ui/SortTable";
import { dec } from "./mcp/kit";
import { DelegateDialog } from "./workload/Delegate";
import { PersonDrawer } from "./workload/Drawer";
import { MinutesTab, PeopleTab, TeamsTab, WaitsTab } from "./workload/Tabs";
import { MIN_N, goConfig, goPerson, goTrust, mins, useDelegateGuard } from "./workload/kit";

function SuggestionItem({ s, m, openDelegate }: { s: WorkloadSuggestion; m: Workload; openDelegate: (pid: string) => void }) {
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
  return (
    <li className={`wl-sg wl-sg-${s.kind}`}>
      <span className="wl-sg-ic" aria-hidden="true"><Icon name={s.icon} /></span>
      <div className="wl-sg-main"><span className="kicker">{s.kind === "trust" ? "Raise trust" : s.kind === "delegate" ? "Delegate" : "Add an approver"}</span><p>{s.text}</p></div>
      <Btn label={a.label} small id={a.id} guard={guard && !guard.allowed ? guard : null} onClick={run} />
    </li>
  );
}

export default function WorkloadView() {
  const ui = useUI();
  const me = useMe();
  const [tab, setTab] = useState("people");
  const [days, setDays] = useState(7);
  const [project, setProject] = useState("all");
  const [allSugg, setAllSugg] = useState(false);
  const [sorts, setSorts] = useState<Record<string, SortState>>({});
  const q = useWorkload(project, days);
  const m = q.data;

  if (!me) return null;
  // until the snapshot arrives the page is its header and the shared loading, not-visible or failed state
  if (!m) return <div className="view view-workload"><ViewHead title="Workload" /><Async query={q} what="workload" id="wl">{() => null}</Async></div>;

  const setSort = (id: string, s: SortState): void => setSorts((x) => ({ ...x, [id]: s }));
  const openPerson = (pid: string): void => ui.drawer.open(`workload:${pid}`, (close) => <PersonDrawer pid={pid} m={m} close={close} />);
  const openDelegate = (pid: string): void => {
    const row = m.rows.find((r) => r.person === pid);
    ui.open((close) => <DelegateDialog pid={pid} away={row?.away ?? null} close={close} />);
  };
  const t = m.totals;
  const projSel = (
    <Select id="wl-project" aria-label="Project scope" value={project} onChange={setProject}
      options={[{ value: "all", label: m.factoryWide ? "All projects" : `All my projects (${m.projects.length})` }, ...m.projects.map((p) => ({ value: p.id, label: p.name }))]} />
  );
  const body = tab === "teams" ? <TeamsTab m={m} sorts={sorts} setSort={setSort} openPerson={openPerson} />
    : tab === "waits" ? <WaitsTab m={m} sorts={sorts} setSort={setSort} openPerson={openPerson} />
    : tab === "minutes" ? <MinutesTab m={m} sorts={sorts} setSort={setSort} openPerson={openPerson} />
    : <PeopleTab m={m} sorts={sorts} setSort={setSort} openPerson={openPerson} />;
  const sugg = m.suggestions;
  return (
    <div className="view view-workload">
      <ViewHead title="Workload"
        sub="Human attention is the scarce resource. Who waits on whom, how long, out of hours, and where one person is the only way through. Derived from approvals, brief confirmations and answers in the work order records."
        meta={[["Gates waiting", String(t.gatesWaiting)], ["Median wait", t.timedN >= MIN_N ? mins(t.medianWaitMin) : t.timedN ? `n=${t.timedN}` : "–"], ["After hours", t.acts >= MIN_N ? fmt.pct(t.afterHours / t.acts) : "–"], ["Human minutes", String(t.minutes)]]} />
      <div className="toolbar wl-tools">
        <div className="filters">
          <Field label="Projects" htmlFor="wl-project">{projSel}</Field>
          <div className="field"><div className="field-label">Window</div><Segmented name="wl-days" label="Window" value={String(days)} onChange={(v) => setDays(+v)} items={[{ id: "1", label: "24 hours" }, { id: "7", label: "7 days" }]} /></div>
        </div>
        <div className="wl-snap small muted">
          {`Snapshot ${fmt.ist(m.at)} IST · ${t.acts} acts`}
          <Btn label="Refresh" small kind="ghost" icon="swap" id="wl-refresh" onClick={() => void q.refetch()} />
        </div>
      </div>
      {t.soleGates || t.noneGates ? (
        <div className="callout callout-warn wl-bus" role="note">
          <Icon name="alert" />
          <span>{(t.soleGates ? `${t.soleGates} of ${t.gatesWaiting} waiting gates have exactly one eligible approver` : "") + (t.soleGates && t.noneGates ? "; " : "") + (t.noneGates ? `${t.noneGates} have nobody eligible except break-glass` : "")}. That person is the bus factor for that work.</span>
        </div>
      ) : null}
      <section className="panel wl-sugg" aria-label="Suggestions">
        <div className="panel-head">
          <h2 className="panel-title">Suggestions</h2>
          {sugg.length > 5 ? <Btn label={allSugg ? "Show top 5" : `Show all ${sugg.length}`} small kind="ghost" id="wl-sugg-all" onClick={() => setAllSugg(!allSugg)} /> : null}
        </div>
        <div className="panel-body">
          {sugg.length ? (
            <ol className="wl-sugg-list">{sugg.slice(0, allSugg ? sugg.length : 5).map((s) => <SuggestionItem key={s.key} s={s} m={m} openDelegate={openDelegate} />)}</ol>
          ) : (
            <Empty id="wl-sugg-empty" icon="check" title="No suggestions" text="No single points of failure, long waits or pending trust proposals in this scope." />
          )}
        </div>
      </section>
      <section className="panel wl-main" aria-label="Workload detail">
        <div className="wl-tabbar">
          <Tabs idPrefix="wl-tab" active={tab} onChange={setTab} items={[{ id: "people", label: "People", count: m.rows.length }, { id: "teams", label: "Teams", count: m.teams.length }, { id: "waits", label: "Where work waits", count: m.bottlenecks.filter((b) => b.open).length }, { id: "minutes", label: "Minutes per work order" }]} />
        </div>
        <div className="panel-body" id="wl-tab-panel" role="tabpanel">{body}</div>
      </section>
      <p className="footnote">{`Out of hours means outside Mon to Fri 09:00 to 19:00 IST. Rates with fewer than ${MIN_N} observations show the raw count and "insufficient data". Factory Admins can decide any gate as break-glass; those are counted separately and not as eligible approvers.`}</p>
    </div>
  );
}

