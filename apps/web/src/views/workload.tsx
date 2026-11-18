/**
 * Workload (spec 8.9, 13.5). Port of legacy/js/views/workload.js against GET /api/v1/workload: human attention as the scarce resource. Per person and team: approvals
 * waiting, median response, approvals per day, questions answered, after-hours load and the share of waiting gates where they are the only eligible approver; human minutes
 * per work order by class and project; gates ranked by time work waits on people; suggestions that deep-link to the fix. The server computes everything from the work order
 * records and scopes it to the projects the viewer sees. Counts sit beside every rate; small samples say "insufficient data".
 * Deep links: approver rules and trust open their screen on the right project (the tab and gate are not selectable from outside those screens).
 */
import { useMemo, useState } from "react";
import { useCan } from "../api/can";
import { useAgents, useFloor, useMe, usePeople, useProjects, useWorkload } from "../api/queries";
import { pickProject } from "../lib/routes";
import { usePrefs } from "../lib/prefs";
import { useCatalog } from "./projects/kit";
import type { Workload, WorkloadSuggestion } from "../api/types";
import { Btn, Chip, Empty, FilterBar, SearchBox, Select, Tabs } from "../ui/primitives";
import { Card, Page, Stats } from "../ui/cr";
import { hashFor } from "../lib/router";
import { usePeopleLoad } from "./govern/load";
import { useTeams } from "./govern/data";
import { useUrlState, writeUrlState } from "./govern/urlState";
import { Async } from "../ui/async";
import { Icon } from "../ui/Icon";
import { fmt } from "@gantry/domain";
import { useUI } from "../ui/overlay-context";
import type { Project } from "@gantry/domain";
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

const short = (name: string): string => { const [f = "", ...r] = name.trim().split(/\s+/); return r.length ? `${f} ${r[r.length - 1]![0]}.` : f; };

/** Busy share per agent on the current project's line: work orders running at its station over the station's capacity. Null where that cannot be told. */
function useAgentUtilisation(agents: Array<{ id: string; station: string | null }>): { of: (id: string) => number | null; mean: number | null; loading: boolean } {
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const floor = useFloor(me ? pickProject(me, prefs.project) : null);
  const fd = floor.data;
  const flow = (fd?.project as { flow?: { stations?: Record<string, { wip: number }> } } | undefined)?.flow;
  const of = (id: string): number | null => {
    const a = agents.find((x) => x.id === id);
    if (!a?.station || !cat || !fd) return null;
    const idx = cat.stations.findIndex((s) => s.id === a.station);
    const cap = flow?.stations?.[a.station]?.wip ?? 0;
    if (idx < 0 || !cap) return null;
    const running = fd.workOrders.filter((w) => w.station === idx && w.state === "running").length;
    return Math.round(100 * Math.min(1, running / cap));
  };
  const vals = agents.map((a) => of(a.id)).filter((v): v is number => v !== null);
  return { of, mean: vals.length ? Math.round(vals.reduce((x, y) => x + y, 0) / vals.length) : null, loading: floor.isPending };
}

export default function WorkloadView() {
  const ui = useUI();
  const me = useMe();
  const [view] = useUrlState("wview", "overview"); // overview (the prototype screen) | detail (suggestions, teams, waits, minutes)
  const [tab, setTab] = useUrlState("wtab", "people");
  const [win, setWin] = useUrlState("win", "7");
  const days = win === "1" ? 1 : 7;
  const [project, setProject] = useUrlState("scope", "all");
  const [q, setQ] = useUrlState("q", "");
  const [team, setTeam] = useUrlState("team", "all");
  const [allSugg, setAllSugg] = useState(false);
  const [sorts, setSorts] = useState<Record<string, SortState>>({});
  const detail = view === "detail";
  const wq = useWorkload(detail ? project : "all", detail ? days : 7);
  const m = wq.data;
  const peopleQ = usePeople();
  const teamsQ = useTeams();
  const agentsQ = useAgents();
  const projects = ((useProjects().data ?? me?.projects ?? []) as Project[]).filter((p) => p.status !== "archived");
  const load = usePeopleLoad(projects);
  const cols = projects.slice(0, 6) as Array<Project & { key?: string }>;
  const people = useMemo(() => peopleQ.data ?? [], [peopleQ.data]);
  const teams = teamsQ.data ?? [];
  const agents = (agentsQ.data ?? []).slice(0, 9);
  const util = useAgentUtilisation(agents);
  const needle = q.trim().toLowerCase();
  const active = people.filter((p) => p.status === "active" && (team === "all" || (p.teams ?? []).includes(team)) && (!needle || p.name.toLowerCase().includes(needle)));
  const totalOf = (id: string): number => projects.reduce((n, pr) => n + load.requested(id, pr.id) + load.eligible(id, pr.id), 0);
  const busiest = people.filter((p) => p.status === "active").map((p) => ({ p, n: totalOf(p.id) })).sort((x, y) => y.n - x.n)[0];

  if (!me) return null;
  const sub = "Where work and approvals pile up, for people and for agents."; // the detail view (suggestions, teams, minutes) stays reachable at ?wview=detail
  // until the snapshot arrives the page is its header and the shared loading, not-visible or failed state
  if (!m) return <Page cls="view-workload" eyebrow="Govern" title="Workload" sub={sub}><Async query={wq} what="workload" id="wl">{() => null}</Async></Page>;

  const setSort = (id: string, s: SortState): void => setSorts((x) => ({ ...x, [id]: s }));
  const openPerson = (pid: string): void => ui.drawer.open(`workload:${pid}`, (close) => <PersonDrawer pid={pid} m={m} close={close} />);
  const openDelegate = (pid: string): void => {
    const row = m.rows.find((r) => r.person === pid);
    ui.open((close) => <DelegateDialog pid={pid} away={row?.away ?? null} close={close} />);
  };
  const t = m.totals;
  const body = tab === "teams" ? <TeamsTab m={m} sorts={sorts} setSort={setSort} openPerson={openPerson} />
    : tab === "waits" ? <WaitsTab m={m} sorts={sorts} setSort={setSort} openPerson={openPerson} />
    : tab === "minutes" ? <MinutesTab m={m} sorts={sorts} setSort={setSort} openPerson={openPerson} />
    : <PeopleTab m={m} sorts={sorts} setSort={setSort} openPerson={openPerson} />;
  const sugg = m.suggestions;
  const dirty = !!needle || team !== "all" || (detail && (project !== "all" || win !== "7"));
  const clear = (): void => writeUrlState({ q: null, team: null, scope: null, win: null });

  return (
    <Page cls="view-workload" eyebrow="Govern" title="Workload" sub={sub}>
      <Stats id="wl-stats" items={[
        { l: "Approvals waiting", v: String(t.gatesWaiting), tone: "warn" },
        { l: "Median wait at gates", v: t.timedN >= MIN_N ? mins(t.medianWaitMin) : "–", tone: "info" },
        { l: "Busiest person", v: busiest && busiest.n > 0 ? short(busiest.p.name) : "–", d: busiest && busiest.n > 0 ? `${busiest.n} item${busiest.n === 1 ? "" : "s"}` : load.loading ? "…" : "nobody holds any", tone: "agent" },
        { l: "Agent utilisation", v: util.mean === null ? "–" : `${util.mean}%`, ...(util.mean === null && !util.loading ? { d: "not available" } : {}), tone: "ok" },
      ]} />
      <FilterBar label="Filter workload" count={`${active.length} of ${people.length}`} actions={dirty ? <Btn label="Clear" kind="ghost" small id="wl-clear" onClick={clear} /> : undefined}>
        <SearchBox id="wl-q" value={q} onChange={setQ} placeholder="Search people" label="Find a person" />
        <Select id="wl-team" aria-label="Team" value={team} onChange={setTeam} options={[{ value: "all", label: "Team: all" }, ...teams.map((x) => ({ value: x.id, label: x.name }))]} />
        {detail ? <>
          <Select id="wl-project" aria-label="Project scope" value={project} onChange={setProject}
            options={[{ value: "all", label: m.factoryWide ? "Project: all" : `All my projects (${m.projects.length})` }, ...m.projects.map((p) => ({ value: p.id, label: p.name }))]} />
          <Select id="wl-days" aria-label="Window" value={win} onChange={setWin} options={[{ value: "1", label: "Window: 24 hours" }, { value: "7", label: "Window: 7 days" }]} />
        </> : null}
      </FilterBar>
      {detail ? (
        <>
          {t.soleGates || t.noneGates ? (
            <div className="banner warn wl-bus" role="note">
              <Icon name="alert" />
              <div className="grow"><strong>Bus factor</strong>{" "}{(t.soleGates ? `${t.soleGates} of ${t.gatesWaiting} waiting gates have exactly one eligible approver` : "") + (t.soleGates && t.noneGates ? "; " : "") + (t.noneGates ? `${t.noneGates} have nobody eligible except break-glass` : "")}. That person is the bus factor for that work.</div>
            </div>
          ) : null}
          <Card title="Suggestions" id="wl-sugg-card" acts={sugg.length > 5 ? <Btn label={allSugg ? "Show top 5" : `Show all ${sugg.length}`} small id="wl-sugg-all" onClick={() => setAllSugg(!allSugg)} /> : undefined}>
            {sugg.length ? (
              <ol className="wl-sugg-list">{sugg.slice(0, allSugg ? sugg.length : 5).map((s) => <SuggestionItem key={s.key} s={s} m={m} openDelegate={openDelegate} />)}</ol>
            ) : (
              <Empty id="wl-sugg-empty" icon="check" title="No suggestions" text="No single points of failure, long waits or pending trust proposals in this scope." />
            )}
          </Card>
          <Card title="Approvals, teams and minutes" hint={`Snapshot ${fmt.ist(m.at)} IST · ${t.acts} acts`} id="wl-detail-card">
            <Tabs idPrefix="wl-tab" active={tab} onChange={setTab} items={[{ id: "people", label: "People", count: m.rows.length }, { id: "teams", label: "Teams", count: m.teams.length }, { id: "waits", label: "Where work waits", count: m.bottlenecks.filter((b) => b.open).length }, { id: "minutes", label: "Minutes per work order" }]} />
            <div id="wl-tab-panel" role="tabpanel">{body}</div>
          </Card>
          <p className="footnote">{`Out of hours means outside Mon to Fri 09:00 to 19:00 IST. Rates with fewer than ${MIN_N} observations show the raw count and "insufficient data". Factory Admins can decide any gate as break-glass; those are counted separately and not as eligible approvers.`}</p>
        </>
      ) : (
        <div className="grid g-main2">
          <div>
            <Card title="People by project" hint="Open work orders requested plus approvals they are eligible for" flush id="wl-matrix-card">
              <div className="matrix" id="wl-matrix" data-keep-scroll="wl-matrix">
                <table>
                  <thead><tr><th>Person</th>{cols.map((p) => <th key={p.id} title={p.name}>{p.key ?? p.id}</th>)}<th>Total</th></tr></thead>
                  <tbody>
                    {active.slice(0, 12).map((p) => {
                      let tot = 0;
                      return (
                        <tr key={p.id}>
                          <td><a href={hashFor("person", p.id)} style={{ color: "var(--text)" }}>{p.name}</a></td>
                          {cols.map((pr) => {
                            const n = load.requested(p.id, pr.id) + load.eligible(p.id, pr.id);
                            tot += n;
                            return <td key={pr.id}><span className="heat" style={{ "--p": Math.min(80, n * 18), "--c": "var(--warn)", display: "grid", placeItems: "center", height: 28, borderRadius: 4 } as React.CSSProperties}>{n || ""}</span></td>;
                          })}
                          <td className="mono"><b>{tot}</b></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {load.partial ? <p className="muted small" style={{ padding: "8px 12px", margin: 0 }} role="status">Some work lists could not be read, so these counts may be low.</p> : null}
            </Card>
          </div>
          <Card title="Agent utilisation" id="wl-agents-card">
            <div className="stack" style={{ gap: 10 }}>
              {agents.map((a) => {
                const u = util.of(a.id);
                return (
                  <div key={a.id}>
                    <div className="row spread"><span>{a.name}</span><span className="mono dim" title={u === null ? "Not reported for this agent on the current project" : "Running work orders at its station over the station's capacity, on the current project"}>{u === null ? "not available" : `${u}%`}</span></div>
                    <div className={`meter ${u === null ? "" : u > 85 ? "bad" : u > 65 ? "warn" : "ok"}`} role="img" aria-label={`${a.name} utilisation, ${u === null ? "not available" : `${u}%`}`}><i style={{ width: `${u ?? 0}%` }} /></div>
                  </div>
                );
              })}
              {!agents.length ? <span className="muted small">No agents to show.</span> : null}
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
}
