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
import { Btn, Chip, Empty, Panel, Segmented, Select, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
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
  const controls = (
    <div className="wl-controls">
      {projSel}
      <Segmented name="wl-days" label="Window" value={String(days)} onChange={(v) => setDays(+v)} items={[{ id: "1", label: "24 hours" }, { id: "7", label: "7 days" }]} />
      <span className="wl-snap small muted">{`Snapshot ${fmt.ist(m.at)} IST · ${t.acts} acts`}</span>
      <Btn label="Refresh" icon="swap" id="wl-refresh" onClick={() => void q.refetch()} />
    </div>
  );
  return (
    <div className="view view-workload">
      <ViewHead title="Workload"
        sub="Human attention is the scarce resource. Who is waited on, how fast they answer, and where one person is the only way through."
        actions={controls} />
      <StatRow id="wl-stats">
        <Stat label="Gates waiting" value={String(t.gatesWaiting)} />
        <Stat label="Median wait" value={t.timedN >= MIN_N ? mins(t.medianWaitMin) : "–"} sub={t.timedN >= MIN_N ? `n=${t.timedN}` : t.timedN ? `Needs ${MIN_N} or more observations (n=${t.timedN})` : undefined} />
        <Stat label="After hours" value={t.acts >= MIN_N ? fmt.pct(t.afterHours / t.acts) : "–"} sub={t.acts >= MIN_N ? `${t.afterHours} of ${t.acts} acts` : undefined} />
        <Stat label="Human minutes" value={String(t.minutes)} sub="this window" />
      </StatRow>
      {t.soleGates || t.noneGates ? (
        <div className="callout callout-warn wl-bus" role="note">
          <Icon name="alert" />
          <span><strong>Bus factor</strong>{" "}{(t.soleGates ? `${t.soleGates} of ${t.gatesWaiting} waiting gates have exactly one eligible approver` : "") + (t.soleGates && t.noneGates ? "; " : "") + (t.noneGates ? `${t.noneGates} have nobody eligible except break-glass` : "")}. That person is the bus factor for that work.</span>
        </div>
      ) : null}
      <Panel title="Suggestions" cls="wl-sugg" tools={sugg.length > 5 ? <Btn label={allSugg ? "Show top 5" : `Show all ${sugg.length}`} small id="wl-sugg-all" onClick={() => setAllSugg(!allSugg)} /> : undefined}>
        {sugg.length ? (
          <ol className="wl-sugg-list">{sugg.slice(0, allSugg ? sugg.length : 5).map((s) => <SuggestionItem key={s.key} s={s} m={m} openDelegate={openDelegate} />)}</ol>
        ) : (
          <Empty id="wl-sugg-empty" icon="check" title="No suggestions" text="No single points of failure, long waits or pending trust proposals in this scope." />
        )}
      </Panel>
      <Tabs idPrefix="wl-tab" active={tab} onChange={setTab} items={[{ id: "people", label: "People", count: m.rows.length }, { id: "teams", label: "Teams", count: m.teams.length }, { id: "waits", label: "Where work waits", count: m.bottlenecks.filter((b) => b.open).length }, { id: "minutes", label: "Minutes per work order" }]} />
      <section className="panel wl-main" aria-label="Workload detail">
        <div className="panel-body" id="wl-tab-panel" role="tabpanel">{body}</div>
      </section>
      <p className="footnote">{`Out of hours means outside Mon to Fri 09:00 to 19:00 IST. Rates with fewer than ${MIN_N} observations show the raw count and "insufficient data". Factory Admins can decide any gate as break-glass; those are counted separately and not as eligible approvers.`}</p>
    </div>
  );
}

