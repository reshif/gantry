/**
 * Work orders (#work-orders): the project's work as the prototype's two views, a table (List) or a board (Board), in the URL (`?view=board`).
 * The table is one panel: a filter bar (search, State, Station, Class, Priority, the count and Clear), the table with numbered paging (15 a page) and a
 * footer. Every row opens the work order's record. The tabs name the groups people ask for first (everything, mine, waiting on me, at Intake, in flight,
 * shipped, incidents, killed); with Group by, the Repo, Source and Assignee filters, Columns and Saved views they sit under "More" in the filter bar.
 * Tab, filters, sort and page are in the URL (`?tab=mine&state=waiting&station=intake&page=2`). The work orders are read page by page up to a limit (CAP)
 * and filtered, sorted and paged here, so the count, the footer and the board agree; the page says so when the project has more. Columns and saved
 * views are kept per person in this browser (work-orders/saved.ts). The classification card and class override live in work-orders/intake.tsx and the
 * Submit a work order dialog in work-orders/New.tsx.
 */
import { qk } from "../api/keys";
import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { flowOf } from "@gantry/domain";
import { useCan } from "../api/can";
import { api, get } from "../api/client";
import { useHome, useMe, useProject, useProjects } from "../api/queries";
import { assigneeOf, useProjectRepos } from "./floor/kit";
import type { Page, WorkOrder } from "../api/types";
import { Btn, Chip, Empty, Field, FilterBar, Panel, SearchBox, Segmented, Select, Stat, StatRow, Tabs, Toggle, ViewHead } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { Async } from "../ui/async";
import { DataTable, type Col } from "../ui/SortTable";
import { useActors } from "../ui/actors";
import { hashFor, navigate } from "../lib/router";
import { plural } from "../lib/plural";
import { pickProject } from "../lib/routes";
import { usePrefs } from "../lib/prefs";
import { classOf, useCatalog } from "./projects/kit";
import { allClasses } from "./work-orders/classes";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";
import { useUrlState } from "./work-orders/url";
import { PrioChip, WoStateChip, agoShort } from "./work-orders/cells";
import { WoActions } from "./work/WoActions";
import { needsOf, needsRank, waitingOf, type Needs, type WoWithReview } from "./work/needs";
import type { HomeFull } from "./home/data";
import { WoBoard } from "./work-orders/Board";
import { columnsKey, savedViewsKey, useStored, type GroupBy, type SavedView } from "./work-orders/saved";
import "../styles/views/workorders.css";

type TabId = "all" | "mine" | "waiting" | "intake" | "open" | "done" | "incidents" | "killed";
interface Filters {
  q: string;
  cls: string;
  station: string;
  repo: string;
  prio: string;
  source: string;
  state: string;
  assignee: string;
}
const NONE: Filters = { q: "", cls: "all", station: "all", repo: "all", prio: "all", source: "all", state: "all", assignee: "all" };
/** Everything the URL holds for this list, with the value that is left out of the address. */
const URL_DEFAULTS = { view: "list", tab: "all", ...NONE, group: "none", sort: "needs", dir: "asc", page: "1" };
const PRIOS = ["P0", "P1", "P2", "P3"];
const PAGE = 15;
const SNAPSHOT = 200;
/** The most work orders read for the list. Beyond it the page says the list is cut short. */
const CAP = 1000;
/** The prototype's eight columns, in its order. */
const PROTO_COLS = ["id", "repo", "where", "cls", "prio", "needs", "age", "cost", "act"];
const TABS: Array<[TabId, string]> = [["all", "All"], ["mine", "Requested by me"], ["waiting", "At a gate"], ["intake", "Intake"], ["open", "Open"], ["done", "Done"], ["incidents", "Incidents"], ["killed", "Killed"]];
const GROUPS: Array<{ id: GroupBy; label: string }> = [{ id: "none", label: "No grouping" }, { id: "station", label: "Station" }, { id: "repo", label: "Repo" }, { id: "cls", label: "Class" }, { id: "assignee", label: "Assignee" }];
/** The columns a person can hide (the work order id always stays). */
const OPTIONAL_COLS: Array<[string, string]> = [["repo", "Project"], ["where", "Station"], ["cls", "Class"], ["prio", "Priority"], ["needs", "Needs"], ["age", "Last activity"], ["cost", "Cost"]];
const STATES = ["running", "waiting", "parked", "blocked", "failed", "done", "killed"];

const isIncident = (w: WorkOrder): boolean => w.state === "blocked" || w.state === "failed" || w.bay === "sechold" || w.bay === "person";
const inFlight = (w: WorkOrder): boolean => w.state !== "done" && w.state !== "killed";
const atIntakeNow = (w: WorkOrder): boolean => inFlight(w) && w.station === 0 && !w.bay && !!w.gates?.G0G1 && w.gates.G0G1.status !== "passed";

export default function WorkOrdersView() {
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const actor = useActors();
  const newWo = useNewWorkOrder();
  const home = useHome().data as HomeFull | undefined;
  const names = useProjects().data;
  const ui = useUI();
  const [u, setU] = useUrlState(URL_DEFAULTS);
  const [moreOpen, setMoreOpen] = useState(false);
  const [applied, setApplied] = useState("");
  const mode: "list" | "board" = u.view === "board" ? "board" : "list";
  const tab = u.tab as TabId;
  const sort = { k: u.sort, dir: (u.dir === "asc" ? 1 : -1) as 1 | -1 };
  const f: Filters = { q: u.q, cls: u.cls, station: cat?.stations.find((x) => x.id === u.station || x.no === u.station)?.id ?? u.station, repo: u.repo, prio: u.prio, source: u.source, state: u.state, assignee: u.assignee };
  const projectId = me ? pickProject(me, prefs.project) : null;
  const [hidden, setHidden] = useStored<string[]>(columnsKey(projectId ?? ""), []);
  const [saved, setSaved] = useStored<SavedView[]>(savedViewsKey(projectId ?? ""), []);
  const projectQ = useProject(projectId);
  const project = projectQ.data ?? null;
  const repos = useProjectRepos(projectId);
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});

  // The tabs that name a state ask the server for it; the rest of the list is read whole (up to CAP) and filtered, sorted and paged here.
  const params = { cls: f.cls, where: f.station, repo: f.repo, prio: f.prio, source: f.source, state: tab === "open" ? "open" : tab === "done" ? "done" : tab === "killed" ? "killed" : tab === "intake" ? "open" : f.state, ...(tab === "intake" ? { where: "intake" } : {}) };
  const list = useInfiniteQuery({
    queryKey: qk.woTable(projectId, params),
    queryFn: ({ pageParam }) => get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { ...params, limit: SNAPSHOT, cursor: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next || undefined,
    enabled: !!projectId && mode === "list",
    placeholderData: keepPreviousData,
  });
  const loaded = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const waiting = useMemo(() => waitingOf(home), [home]);
  const waitingIds = useMemo(() => new Set(waiting.approvals.filter((a) => a.project === projectId || !a.project).map((a) => a.wo).filter(Boolean)), [waiting, projectId]);
  const needsById = useMemo(() => (cat ? new Map(loaded.map((w) => [w.id, needsOf(w as WoWithReview, cat, waiting, (id) => actor(id).name.replace(" (agent)", ""))] as [string, Needs])) : new Map<string, Needs>()), [loaded, cat, waiting, actor]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && loaded.length < CAP) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, loaded.length, fetchNextPage]);
  const cut = !!hasNextPage && loaded.length >= CAP;

  // Every work order up to CAP, unfiltered: the counts of the tabs and the stat tiles, and the board.
  const snap = useQuery({
    queryKey: qk.woSnapshot(projectId),
    queryFn: async () => {
      const items: WorkOrder[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < CAP / SNAPSHOT; i++) {
        const pg = await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { state: "all", limit: SNAPSHOT, cursor });
        items.push(...pg.items);
        if (!pg.next) return { items, cut: false };
        cursor = pg.next;
      }
      return { items, cut: true };
    },
    enabled: !!projectId,
  });
  // The project's real totals, for when it has more than CAP work orders.
  const stat = useQuery({
    queryKey: qk.woStats(projectId),
    queryFn: async () => {
      const one = async (st: string, extra: Record<string, string> = {}) => (await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { state: st, ...extra, limit: 1 })).total ?? 0;
      const [all, openN, done, killed, intake] = await Promise.all([one("all"), one("open"), one("done"), one("killed"), one("open", { where: "intake" })]);
      return { all, open: openN, done, killed, intake };
    },
    enabled: !!projectId && !!snap.data?.cut,
  });
  const snapItems = snap.data?.items;
  const counts = useMemo(() => {
    if (snap.data?.cut) return stat.data ?? null;
    if (!snapItems) return null;
    return { all: snapItems.length, open: snapItems.filter(inFlight).length, done: snapItems.filter((w) => w.state === "done").length, killed: snapItems.filter((w) => w.state === "killed").length, intake: snapItems.filter(atIntakeNow).length };
  }, [snap.data?.cut, snapItems, stat.data]);

  const q = f.q.trim().toLowerCase();
  const rows = useMemo(() => {
    const text = (w: WorkOrder): string => [w.id, w.title, project?.name ?? "", w.repo, actor(w.requestedBy).name].join(" ").toLowerCase();
    return loaded.filter((w) => {
      if (tab === "mine" && w.requestedBy !== me?.person.id) return false;
      if (tab === "waiting" && !waitingIds.has(w.id)) return false;
      if (tab === "incidents" && !isIncident(w)) return false;
      if (tab === "open" && !inFlight(w)) return false;
      if (tab === "done" && w.state !== "done") return false;
      if (tab === "killed" && w.state !== "killed") return false;
      if (tab === "intake" && !atIntakeNow(w)) return false;
      if (f.state !== "all" && tab !== "open" && tab !== "done" && tab !== "killed" && w.state !== f.state) return false;
      if (f.station !== "all" && tab !== "intake" && (w.bay ? w.bay !== f.station : cat?.stations[w.station]?.id !== f.station)) return false;
      if (f.cls !== "all" && w.cls !== f.cls) return false;
      if (f.prio !== "all" && w.priority !== f.prio) return false;
      if (f.repo !== "all" && w.repo !== f.repo) return false;
      if (f.source !== "all" && w.source !== f.source) return false;
      if (f.assignee !== "all" && (f.assignee === "none" ? !!assigneeOf(w) : assigneeOf(w) !== f.assignee)) return false;
      if (q && !text(w).includes(q)) return false;
      return true;
    });
  }, [loaded, tab, me, waitingIds, f.state, f.station, f.cls, f.prio, f.repo, f.source, f.assignee, q, cat, project, actor]);

  const assignees = useMemo(() => {
    const a = new Set<string>(loaded.map(assigneeOf).filter((x): x is string => !!x));
    if (f.assignee !== "all" && f.assignee !== "none") a.add(f.assignee);
    return [...a].sort();
  }, [loaded, f.assignee]);
  const sources = useMemo(() => {
    const a = new Set<string>(loaded.map((w) => w.source));
    if (f.source !== "all") a.add(f.source);
    return [...a].sort();
  }, [loaded, f.source]);

  if (!me || !cat) return null;
  if (!projectId || !project) {
    return (
      <div className="view">
        {projectId ? <Async query={projectQ} what="this project" id="wo-project">{() => null}</Async> : <Empty title="No project" text="You do not have a project to show." />}
      </div>
    );
  }
  const fl = flowOf(cat, project);
  const filtered = (Object.keys(NONE) as Array<keyof Filters>).some((k) => (k === "q" ? f.q.trim() !== "" : f[k] !== "all")) || tab !== "all";
  const groupBy = (GROUPS.some((g) => g.id === u.group) ? u.group : "none") as GroupBy;
  const set = (k: keyof Filters) => (v: string) => setU({ [k]: v, page: "1" } as Partial<typeof URL_DEFAULTS>);
  // only the tab narrows the list: an empty tab says so in its own words instead of blaming filters nobody set
  const tabOnly = tab !== "all" && !(Object.keys(NONE) as Array<keyof Filters>).some((k) => (k === "q" ? f.q.trim() !== "" : f[k] !== "all"));
  const emptyTab: Record<string, string> = { mine: "You have not requested any work orders in this project.", waiting: "No work orders are waiting at a gate.", intake: "No work orders are at Intake.", open: "No work orders are open.", done: "No work orders are done yet.", incidents: "No incidents.", killed: "No killed work orders." };
  const clear = () => { setApplied(""); setU({ ...NONE, tab: "all", page: "1" }); };
  const block = projectSubmitBlock(me, project, repos);
  const spans = new Set(loaded.map((w) => w.project)).size > 1;
  const nameOfProject = (id: string): string => (id === project.id ? project.name : (names ?? []).find((x) => x.id === id)?.name ?? id);
  const needs = (w: WorkOrder): Needs => needsById.get(w.id) ?? { kind: "none", text: "", mine: false };
  const lastAt = (w: WorkOrder): number => { const e = w.history[w.history.length - 1]; return e?.endedAt ?? e?.startedAt ?? w.createdAt; };
  const costOf = (w: WorkOrder): number => w.history.reduce((n, e) => n + (e.cost || 0), 0);
  const allCols: Col<WorkOrder>[] = [
    {
      key: "id",
      label: "Work order",
      sort: (w) => w.id,
      render: (w) => (
        <div className="wo-idcell" title={`${w.parent ? `Child of ${w.parent}. ` : ""}${w.children?.length ? `${w.children.length} children. ` : ""}`.trim() || undefined}>
          <a className={`pri mono${w.state === "killed" ? " is-killed" : ""}`} id={`wo-id-${w.id}`} href={hashFor("record", w.id, w.project || projectId)}>{w.id}</a>
          <span className="sub wo-title">{w.title}</span>
        </div>
      ),
    },
    ...(spans ? [{ key: "repo", label: "Project", sort: (w: WorkOrder) => nameOfProject(w.project), render: (w: WorkOrder) => <div>{nameOfProject(w.project)}<span className="sub mono">{w.repo}</span></div> }] : []),
    { key: "where", label: "Station", sort: (w) => w.station, render: (w) => <div><span className="small">{`${cat.stations[w.station]?.no ?? ""} ${cat.stations[w.station]?.name ?? "?"}`}</span><span className="sub"><WoStateChip w={w} cat={cat} project={project} /></span></div> },
    {
      key: "cls",
      label: "Class",
      sort: (w) => w.cls,
      render: (w) => (
        <span className="wo-cls" title={w.clsOverridden ? `Class overridden from ${classOf(cat, project, w.clsOverridden.from).name}` : undefined}>{classOf(cat, project, w.cls).name}</span>
      ),
    },
    { key: "prio", label: "Prio", sort: (w) => w.priority, render: (w) => <PrioChip p={w.priority} /> },
    {
      key: "needs",
      label: "Needs",
      noCap: true,
      sort: (w) => needsRank(needs(w), lastAt(w)),
      render: (w) => { const n = needs(w); return n.kind === "none" ? <span className="muted">—</span> : <div className={`wo-needs${n.mine ? " is-mine" : ""}`} data-need={n.kind}><span className="wo-need-t">{n.text}</span>{n.askedOf ? <span className="sub"><Chip text={n.askedOf} cls="warn" /></span> : null}{n.sub ? <span className="sub">{n.sub}</span> : null}</div>; },
    },
    { key: "age", label: "Last activity", sort: (w) => lastAt(w), render: (w) => <span style={{ whiteSpace: "nowrap" }} title={`Created ${agoShort(w.createdAt)}, via ${w.source}, by ${actor(w.requestedBy).name}`}>{agoShort(lastAt(w))}</span> },
    { key: "cost", label: "Cost", sort: (w) => costOf(w), align: "end", render: (w) => <span className="num" style={{ whiteSpace: "nowrap" }}>{costOf(w) ? `$${costOf(w).toFixed(2)}` : "—"}</span> },
    { key: "act", label: "Actions", render: (w) => <WoActions wo={w.id} project={w.project || projectId} repo={w.repo} needs={needs(w)} idPrefix="wo" /> },
  ];
  const cols = allCols.filter((c) => PROTO_COLS.includes(c.key) && (c.key === "id" || !hidden.includes(c.key)));
  const cutNote = `Only the latest ${CAP} work orders are read for this view, so the project has more. Narrow it with the search or a filter.`;
  const total = snapItems?.length ?? loaded.length;
  const showCount = `${plural(rows.length, "work order")}${rows.length !== total ? ` of ${total}` : ""}`;
  const groupKey = (w: WorkOrder): string => {
    if (groupBy === "station") return w.bay ? w.bay : cat.stations[w.station]?.name ?? "?";
    if (groupBy === "repo") return w.repo;
    if (groupBy === "cls") return classOf(cat, project, w.cls).name;
    const a = assigneeOf(w);
    return a ? actor(a).name.replace(" (agent)", "") : "Unassigned";
  };
  const groups: Array<[string, WorkOrder[]]> = (() => {
    if (groupBy === "none") return [["", rows]];
    const m = new Map<string, WorkOrder[]>();
    for (const w of rows) m.set(groupKey(w), [...(m.get(groupKey(w)) ?? []), w]);
    return [...m.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  })();
  const applyView = (id: string): void => {
    const v = saved.find((x) => x.id === id);
    setApplied(id);
    if (!v) return;
    setHidden(v.hidden);
    setU({ ...NONE, ...v.filters, tab: v.tab, sort: v.sort.k, dir: v.sort.dir > 0 ? "asc" : "desc", group: v.groupBy, page: "1" });
  };
  const saveView = (): void => ui.reasonDialog({
    title: "Save this view", kicker: "Work orders", sub: "Keeps the tab, filters, sort, grouping and columns you have now, for you in this browser.",
    label: "Name", placeholder: "For example: My P1s", ok: "Save view", min: 2,
    onOk: (name) => {
      const id = `v${Date.now().toString(36)}`;
      setSaved([...saved, { id, name: name.trim(), tab, filters: { ...f }, sort, groupBy, hidden }]);
      setApplied(id);
    },
  });
  const dropView = (): void => { setSaved(saved.filter((x) => x.id !== applied)); setApplied(""); };
  const tabCount = (id: TabId): number | null => {
    if (!snapItems && !counts) return null;
    if (id === "all") return counts?.all ?? null;
    if (id === "open") return counts?.open ?? null;
    if (id === "done") return counts?.done ?? null;
    if (id === "killed") return counts?.killed ?? null;
    if (id === "intake") return counts?.intake ?? null;
    if (!snapItems) return null;
    if (id === "mine") return snapItems.filter((w) => w.requestedBy === me.person.id).length;
    if (id === "waiting") return snapItems.filter((w) => waitingIds.has(w.id)).length;
    return snapItems.filter(isIncident).length;
  };
  const moreActive = f.repo !== "all" || f.source !== "all" || f.assignee !== "all" || groupBy !== "none" || hidden.length > 0;
  const tableOf = (items: WorkOrder[], id: string, cap: string, paged: boolean) => (
    <DataTable
      id={id}
      caption={cap}
      columns={cols}
      rows={items}
      rowKey={(w) => w.id}
      onRow={(w) => navigate("record", w.id, w.project || projectId)}
      sort={{ key: sort.k, dir: sort.dir }}
      onSort={(s) => setU({ sort: s.key, dir: s.dir > 0 ? "asc" : "desc", page: "1" })}
      glyphs="blueprint"
      mobileSort={false}
      {...(paged ? { pager: { page: Math.max(0, Number(u.page) - 1 || 0), size: PAGE, onPage: (p: number) => setU({ page: String(p + 1) }) } } : {})}
    />
  );
  return (
    <div className="view view-wide wo-view">
      <div id="wo-head">
        <ViewHead
          kicker={project.key}
          title="Work orders"
          sub="The full register of requests and where each one stands."
          actions={
            <>
              <div className="wo-view-seg"><Segmented name="wo-mode" label="View" items={[{ id: "list", label: "List" }, { id: "board", label: "Board" }]} value={mode} onChange={(v) => setU({ view: v })} /></div>
              <Btn label="Submit work order" kind="primary" icon="plus" id="wo-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWo({ project: project.id })} />
            </>
          }
        />
      </div>
      <StatRow id="wo-stats">
        <Stat label="Open" value={counts ? String(counts.open) : "…"} tone="info" />
        <Stat label="At gates" value={snapItems ? String(snapItems.filter((w) => w.state === "waiting").length) : "…"} tone="wait" />
        <Stat label="Stuck" value={snapItems ? String(snapItems.filter((w) => w.state === "blocked" || w.state === "failed").length) : "…"} tone="block" />
        <Stat label="Done" value={counts ? String(counts.done) : "…"} tone="done" />
      </StatRow>
      {mode === "board" ? (
        <Async query={snap} what="the board" id="wo-board-read">{() => <WoBoard items={snapItems ?? []} cat={cat} project={project} />}</Async>
      ) : (
        <Panel title="All work orders" flush cls="wo-panel">
          <Tabs items={TABS.map(([id, label]) => ({ id, label, count: tabCount(id) }))} active={tab} onChange={(id) => setU({ tab: id, page: "1" })} idPrefix="wo-tab" />
          <div className="wo-bar">
            <FilterBar label="Filter work orders" count={showCount} actions={<>{filtered ? <Btn label="Clear" small kind="ghost" id="wo-clear-top" onClick={clear} /> : null}<Btn label="More" small icon="columns" id="wo-more" aria-expanded={moreOpen || moreActive} onClick={() => setMoreOpen(!(moreOpen || moreActive))} /></>}>
              <SearchBox id="wo-q" value={f.q} onChange={set("q")} placeholder="Search id, title, project…" label="Search work order" />
              <Field label="State" htmlFor="wo-f-state">
                <Select id="wo-f-state" options={[{ value: "all", label: "All" }, ...STATES.map((k) => ({ value: k, label: k }))]} value={f.state} onChange={set("state")} />
              </Field>
              <Field label="Station" htmlFor="wo-f-where">
                <Select id="wo-f-where" options={[{ value: "all", label: "All" }, ...fl.stations.filter((s) => s.enabled).map((s) => ({ value: s.id, label: s.name }))]} value={f.station} onChange={set("station")} />
              </Field>
              <Field label="Class" htmlFor="wo-f-cls">
                <Select id="wo-f-cls" options={[{ value: "all", label: "All" }, ...allClasses(cat, project).map((c) => ({ value: c.id, label: c.name }))]} value={f.cls} onChange={set("cls")} />
              </Field>
              <Field label="Priority" htmlFor="wo-f-prio">
                <Select id="wo-f-prio" options={[{ value: "all", label: "All" }, ...PRIOS.map((p) => ({ value: p, label: p }))]} value={f.prio} onChange={set("prio")} />
              </Field>
            </FilterBar>
            {moreOpen || moreActive ? (
              <>
              <FilterBar label="More filters, grouping, columns and saved views">
                <Field label="Group by" htmlFor="wo-group"><Select id="wo-group" options={GROUPS.map((g) => ({ value: g.id, label: g.label }))} value={groupBy} onChange={(v) => setU({ group: v, page: "1" })} /></Field>
                <Field label="Repo" htmlFor="wo-f-repo"><Select id="wo-f-repo" options={[{ value: "all", label: "All" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]} value={f.repo} onChange={set("repo")} /></Field>
                <Field label="Source" htmlFor="wo-f-source"><Select id="wo-f-source" options={[{ value: "all", label: "All" }, ...sources.map((x) => ({ value: x, label: x }))]} value={f.source} onChange={set("source")} /></Field>
                <Field label="Assignee" htmlFor="wo-f-assignee"><Select id="wo-f-assignee" options={[{ value: "all", label: "Anyone" }, { value: "none", label: "Unassigned" }, ...assignees.map((a) => ({ value: a, label: actor(a).name.replace(" (agent)", "") }))]} value={f.assignee} onChange={set("assignee")} /></Field>
                {saved.length ? <Field label="Saved views" htmlFor="wo-views"><Select id="wo-views" options={[{ value: "", label: "Choose a view" }, ...saved.map((v) => ({ value: v.id, label: v.name }))]} value={applied} onChange={applyView} /></Field> : null}
              </FilterBar>
                <div className="wo-more-acts" role="group" aria-label="Columns and saved views">
                  <span className="small muted wo-more-h" id="wo-cols-h">Columns shown</span>
                  <div className="row wo-cols" role="group" aria-labelledby="wo-cols-h">
                  {OPTIONAL_COLS.map(([k, label]) => <label key={k} className="row small" htmlFor={`wo-col-${k}`}><Toggle id={`wo-col-${k}`} variant="check" label={`Show ${label}`} checked={!hidden.includes(k)} onChange={(on) => setHidden(on ? hidden.filter((x) => x !== k) : [...hidden, k])} />{label}</label>)}
                  </div>
                  <span className="small muted wo-more-note">{sort.k === "needs" ? "Sorted by what needs attention first; click a column heading to change it. " : ""}Save view keeps the tab, filters, sort and columns for you in this browser.</span>
                  <Btn label="Save view" small id="wo-view-save" onClick={saveView} />
                  {applied ? <Btn label="Delete view" small kind="ghost" id="wo-view-del" onClick={dropView} /> : null}
                </div>
              </>
            ) : null}
          </div>
          <Async query={list} what="work orders" id="wo-list">{() => rows.length ? (
            <div className="wo-table" id="wo-table-wrap">
              {groupBy === "none" ? tableOf(rows, "wo-table", `Work orders in ${project.name}`, true) : groups.map(([g, items], i) => (
                <section key={g} className="wo-group" aria-labelledby={`wo-group-h-${i}`}>
                  <h3 className="wo-group-h" id={`wo-group-h-${i}`}>{g} <span className="muted num">{items.length}</span></h3>
                  {tableOf(items, `wo-table-${i}`, `Work orders in ${project.name}: ${g}`, false)}
                </section>
              ))}
              {cut ? <div className="wo-foot"><span className="muted small">{cutNote}</span></div> : null}
            </div>
          ) : (
            <Empty
              id="wo-empty"
              title={tabOnly && !cut ? (emptyTab[tab] ?? "Nothing here") : filtered || total ? "Nothing matches these filters" : "Nothing here yet"}
              text={cut ? `None of the work orders read match. ${cutNote}` : tabOnly ? "Switch tab to see the rest of the register." : filtered || total ? "Loosen the search or clear the filters." : "Items will appear here when they exist."}
              action={filtered ? <Btn label={tabOnly ? "Show all work orders" : "Clear filters"} id="wo-clear" onClick={clear} /> : undefined}
            />
          )}</Async>
        </Panel>
      )}
      <p className="hint wo-live">Updates live as work moves.</p>
    </div>
  );
}
