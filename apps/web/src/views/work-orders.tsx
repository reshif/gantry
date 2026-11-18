/**
 * Work orders (#work-orders): the project's work as a table or a board.
 * The table filters, sorts and pages on the server (GET /projects/{id}/work-orders). The tabs name the groups people ask for first: the
 * server-side ones (everything, in flight, at Intake, shipped, killed) and three that are worked out here (mine, waiting on me, incidents).
 * Those three, the Assignee filter and Group by read the work orders page by page up to a limit (CAP), and say so when the project has more.
 * Columns and saved views are kept per person in this browser (work-orders/saved.ts). The board is the floor's board (drag, "Move to", swimlanes). The classification card and class override live in
 * work-orders/intake.tsx and the New work order dialog in work-orders/New.tsx.
 */
/**
 * Work orders (#work-orders), the Control Room prototype's list: tabs (All, Requested by me, At a gate, Blocked), a filter bar (search, State,
 * Class, Priority, Station), a selection banner (set priority, park, clear) and one table whose rows open the work order record.
 * Tabs, filters, sort and page are in the URL (`?view=gate&st=running&q=retry&sort=age&dir=asc&page=2`).
 * The list reads the project's work orders page by page up to CAP and filters, sorts and pages them here, so Export CSV writes every
 * row the filters match. View options (table or board, repo, source, assignee, group by, columns, saved views, sort) sit beside the filter bar.
 * The board is the floor's board. The classification card and class override live in work-orders/intake.tsx, the form in work-orders/New.tsx.
 */
import { qk } from "../api/keys";
import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { WO_STATES, bayDef, classesOf, flowOf, fmt, gateForWO, gatePendingName, woTotals } from "@gantry/domain";
import { useCan } from "../api/can";
import { api, get } from "../api/client";
import { useParkMany } from "../api/bulk";
import { useMe, useProject } from "../api/queries";
import { FloorCtx, assigneeOf, useFloorCtx, useFloorState, useProjectRepos, type FloorCtxValue } from "./floor/kit";
import { ReplayBar, useReplayBase, useReplayPlayer } from "./floor/Replay";
import { Board } from "./floor/Board";
import type { Page, WorkOrder } from "../api/types";
import { Btn, Empty, Field, FilterBar, SearchBox, Segmented, Select, Status, type Tone } from "../ui/primitives";
import { Async, Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { DataTable, type Col } from "../ui/SortTable";
import { CrIcon, Page as CrPage } from "../ui/cr";
import { Icon } from "../ui/Icon";
import { useActors } from "../ui/actors";
import { navigate } from "../lib/router";
import { pickProject } from "../lib/routes";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { classOf, useCatalog } from "./projects/kit";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";
import { columnsKey, savedViewsKey, useStored, type GroupBy, type SavedView } from "./work-orders/saved";
import { useUrlState } from "./work-orders/url-state";
import { useUI } from "../ui/overlay-context";

type TabId = "all" | "mine" | "gate" | "blocked";
const VIEWS: Array<{ id: TabId; label: string }> = [{ id: "all", label: "All" }, { id: "mine", label: "Requested by me" }, { id: "gate", label: "At a gate" }, { id: "blocked", label: "Blocked" }];
/** The state the tabs At a gate and Blocked ask for (the server's own state names). */
const VIEW_STATE: Partial<Record<TabId, string>> = { gate: "waiting", blocked: "blocked" };
const URL_KEYS = ["view", "q", "st", "cls", "pri", "station", "repo", "source", "assignee", "group", "sort", "dir", "page"] as const;
const PRIOS = ["P0", "P1", "P2", "P3"];
const PAGE_SIZE = 12;
const SNAPSHOT = 200;
/** The most work orders read for this list. Beyond it the page says the list is cut short. */
const CAP = 1000;
const SORTS: Array<{ value: string; label: string }> = [
  { value: "id", label: "Id" },
  { value: "title", label: "Title" },
  { value: "project", label: "Project" },
  { value: "cls", label: "Class" },
  { value: "prio", label: "Priority" },
  { value: "where", label: "Station" },
  { value: "state", label: "State" },
  { value: "age", label: "Age" },
];
const GROUPS: Array<{ id: GroupBy; label: string }> = [{ id: "none", label: "No grouping" }, { id: "station", label: "Station" }, { id: "repo", label: "Repo" }, { id: "cls", label: "Class" }, { id: "assignee", label: "Assignee" }];
/** Columns a person can turn on and off (the prototype's columns are always shown). */
const OPTIONAL_COLS: Array<[string, string]> = [["next", "Next actor"], ["gate", "Gate"], ["repo", "Repo"], ["by", "Requested by"], ["spend", "Spend"]];
const DEFAULT_HIDDEN = ["next", "gate", "repo", "by", "spend"];
const STATE_TONE: Record<string, Tone> = { running: "run", waiting: "wait", blocked: "block", failed: "fail", done: "done", parked: "neutral", killed: "block", queued: "neutral" };
const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

function WoStatus({ state, text }: { state: string; text?: string | null }) {
  const def = (WO_STATES as Record<string, { label: string }>)[state];
  return <Status tone={STATE_TONE[state] ?? "neutral"}>{text ?? def?.label ?? state}</Status>;
}

/** The board is the floor's board; it needs the floor read, which this wrapper loads and hands down. */
function BoardMode({ projectId }: { projectId: string }) {
  const base = useReplayBase(projectId);
  const { value, error } = useFloorState(projectId, base);
  if (!value) {
    const f = error ? failureOf(error) : null;
    return !f ? <Loading id="wo-board-loading" label="the board" /> : f.hidden ? <NotVisible id="wo-board-hidden" what="this board" reason={f.msg} /> : <LoadFailed id="wo-board-error" what="the board" msg={f.msg} onRetry={() => window.location.reload()} />;
  }
  return (
    <FloorCtx.Provider value={value as FloorCtxValue}>
      <BoardBody projectId={projectId} />
    </FloorCtx.Provider>
  );
}

/** The board with its Live / Replay switch; a replay shows the board as it was and locks moves. */
function BoardBody({ projectId }: { projectId: string }) {
  const ctx = useFloorCtx();
  const rp = ctx.replay;
  const { playing, setPlaying, enter, exit } = useReplayPlayer(projectId, rp, "wo-board-mode-live");
  return (
    <div className="wo-board">
      <div className="wo-board-bar">
        <Segmented name="wo-board-mode" label="Live or replay" items={[{ id: "live", label: "Live" }, { id: "replay", label: "Replay" }]} value={rp ? "replay" : "live"} onChange={(v) => (v === "replay" ? enter() : exit())} />
      </div>
      {rp ? <ReplayBar rp={rp} playing={playing} setPlaying={setPlaying} onExit={exit} /> : null}
      <Board />
    </div>
  );
}

export default function WorkOrdersView() {
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const actor = useActors();
  const newWo = useNewWorkOrder();
  const ui = useUI();
  const park = useParkMany();
  const [u, setU] = useUrlState(URL_KEYS, { view: "all", sort: "id", dir: "desc", page: "1", group: "none" });
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [opts, setOpts] = useState(false);
  const [applied, setApplied] = useState("");
  const mode: "table" | "board" = prefs.floorView === "board" ? "board" : "table";
  const projectId = me ? pickProject(me, prefs.project) : null;
  const [hidden, setHidden] = useStored<string[]>(columnsKey(projectId ?? ""), DEFAULT_HIDDEN);
  const [saved, setSaved] = useStored<SavedView[]>(savedViewsKey(projectId ?? ""), []);
  const projectQ = useProject(projectId);
  const project = projectQ.data ?? null;
  const repos = useProjectRepos(projectId);
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});

  const tab: TabId = VIEWS.some((v) => v.id === u.view) ? (u.view as TabId) : "all";
  const groupBy = (GROUPS.some((g) => g.id === u.group) ? u.group : "none") as GroupBy;
  const sort = { k: u.sort, dir: (u.dir === "asc" ? 1 : -1) as 1 | -1 };
  const state = VIEW_STATE[tab] ?? (u.st || "all");
  const f = { q: u.q, cls: u.cls || "all", where: u.station || "all", repo: u.repo || "all", prio: u.pri || "all", source: u.source || "all", state, assignee: u.assignee || "all" };
  const params = { cls: f.cls, where: f.where, repo: f.repo, prio: f.prio, source: f.source, state: f.state, sort: "id", dir: "desc" };
  const list = useInfiniteQuery({
    queryKey: qk.woTable(projectId, params),
    queryFn: ({ pageParam }) => get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { ...params, limit: SNAPSHOT, cursor: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next || undefined,
    enabled: !!projectId && mode === "table",
    placeholderData: keepPreviousData,
  });
  const loaded = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && loaded.length < CAP) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, loaded.length, fetchNextPage]);
  const cut = !!hasNextPage && loaded.length >= CAP;
  const needle = f.q.trim().toLowerCase();
  const rows = useMemo(() => {
    let r = loaded;
    if (tab === "mine") r = r.filter((w) => w.requestedBy === me?.person.id);
    if (f.assignee !== "all") r = r.filter((w) => (f.assignee === "none" ? !assigneeOf(w) : assigneeOf(w) === f.assignee));
    if (needle) r = r.filter((w) => `${w.id} ${w.title} ${w.repo} ${w.project}`.toLowerCase().includes(needle));
    return r;
  }, [loaded, tab, me, f.assignee, needle]);
  const assignees = useMemo(() => {
    const s = new Set<string>(loaded.map(assigneeOf).filter((a): a is string => !!a));
    if (f.assignee !== "all" && f.assignee !== "none") s.add(f.assignee);
    return [...s].sort();
  }, [loaded, f.assignee]);
  const sources = useMemo(() => {
    const s = new Set<string>(loaded.map((w) => w.source));
    if (f.source !== "all") s.add(f.source);
    return [...s].sort();
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
  const projectKey = (id: string): string => me.projects.find((p) => p.id === id)?.key ?? id;
  const filtered = !!(needle || f.cls !== "all" || f.where !== "all" || f.repo !== "all" || f.prio !== "all" || f.source !== "all" || u.st || f.assignee !== "all" || tab !== "all");
  const clearAll = () => { setU({ q: "", st: "", cls: "", pri: "", station: "", repo: "", source: "", assignee: "", view: "", page: "" }); };
  const change = (patch: Partial<Record<(typeof URL_KEYS)[number], string>>) => { setSel(new Set()); setU({ ...patch, page: "" }); };
  const block = projectSubmitBlock(me, project, repos);
  const stationName = (w: WorkOrder): string => cat.stations[w.station]?.name ?? "?";
  const whereCell = (w: WorkOrder) => {
    if (w.bay) {
      const b = bayDef(cat, w.bay);
      return (
        <span className={`bay-chip bay-${w.bay}`}>
          <Icon name="st-park" />
          {b ? b.name : w.bay}
        </span>
      );
    }
    return <span>{stationName(w)}</span>;
  };
  /** Who acts next: the agent working, the approvers at a gate, or a person when the work is stuck. */
  const nextActor = (w: WorkOrder): string => {
    if (w.state === "done") return "Finished";
    if (w.state === "killed") return "Stopped";
    if (w.state === "waiting") return "Approvers";
    if (w.state === "running") {
      const a = assigneeOf(w);
      return a ? actor(a).name.replace(" (agent)", "") : "An agent";
    }
    return "A person";
  };
  const gateCell = (w: WorkOrder): string => {
    if (w.state === "done") return "Shipped";
    const g = gateForWO(cat, project, w);
    // A gate's name is the outcome it waits for ("Spec approved"): while it is ahead of the work order, say what it needs instead.
    return g ? (w.state === "waiting" ? gatePendingName(g) : `Next: ${gatePendingName(g)}`) : "None next";
  };
  const gateTag = (w: WorkOrder): string | null => (w.state === "waiting" ? (gateForWO(cat, project, w)?.label ? `Gate ${gateForWO(cat, project, w)?.label}` : null) : null);
  const idNum = (w: WorkOrder): number => Number(w.id.replace(/\D/g, "")) || 0;
  const allCols: Col<WorkOrder>[] = [
    {
      key: "id",
      label: "ID",
      sort: idNum,
      render: (w) => <a className={`mono strong wo-id${w.state === "killed" ? " is-killed" : ""}`} id={`wo-id-${w.id}`} href={`#/p/${encodeURIComponent(w.project)}/record/${encodeURIComponent(w.id)}`}>{w.id}</a>,
    },
    {
      key: "title",
      label: "Title",
      sort: (w) => w.title,
      render: (w) => (
        <span className={`ell wo-title${w.state === "killed" ? " is-killed" : ""}`} style={{ maxWidth: 320 }} title={w.title}>
          {w.title}
          {w.parent ? <span className="muted small">{` · child of ${w.parent}`}</span> : null}
          {w.children?.length ? <span className="muted small">{` · ${w.children.length} children`}</span> : null}
        </span>
      ),
    },
    { key: "project", label: "Project", sort: (w) => w.project, render: (w) => <span className="tag">{projectKey(w.project)}</span> },
    {
      key: "cls",
      label: "Class",
      sort: (w) => w.cls,
      render: (w) => {
        const c = classOf(cat, project, w.cls);
        return (
          <span className="wo-cls">
            <span className="tag">{c.custom ? c.name : cap(w.cls)}</span>
            {w.clsOverridden ? (
              <span className="wo-ovr" title={`Class overridden from ${classOf(cat, project, w.clsOverridden.from).name}`}>
                <Icon name="swap" />
              </span>
            ) : null}
          </span>
        );
      },
    },
    { key: "prio", label: "Pri", sort: (w) => w.priority, render: (w) => <span className={`tag pri ${w.priority.toLowerCase()}`} title={`Priority ${w.priority}`}>{w.priority}</span> },
    { key: "where", label: "Station", sort: (w) => (w.bay ? 100 : 0) + w.station, render: whereCell },
    { key: "state", label: "State", sort: (w) => w.state, render: (w) => <WoStatus state={w.state} text={gateTag(w)} /> },
    { key: "next", label: "Next actor", hideSmall: true, render: (w) => <span className="small">{nextActor(w)}</span> },
    { key: "gate", label: "Gate", hideSmall: true, render: (w) => <span className="small muted">{gateCell(w)}</span> },
    { key: "repo", label: "Repo", hideSmall: true, render: (w) => <span className="mono small">{w.repo}</span> },
    {
      key: "by",
      label: "Requested",
      hideSmall: true,
      render: (w) => (
        <span className="small wo-by">
          {actor(w.requestedBy).name}
          <span className="muted">{` via ${w.source}`}</span>
        </span>
      ),
    },
    { key: "age", label: "Age", align: "end", sort: (w) => -w.createdAt, render: (w) => <span className="mono">{fmt.dur(Date.now() - w.createdAt)}</span> },
    { key: "spend", label: "Spend", align: "end", hideSmall: true, render: (w) => <span className="mono">{fmt.money(woTotals(w).cost)}</span> },
  ];
  const optional = new Set(OPTIONAL_COLS.map(([k]) => k));
  const cols = allCols.filter((c) => !optional.has(c.key) || !hidden.includes(c.key));
  const cutNote = `Only the latest ${CAP} work orders are read for this view, so the project has more. Narrow it with the search or a filter.`;
  const groupKey = (w: WorkOrder): string => {
    if (groupBy === "station") return w.bay ? bayDef(cat, w.bay)?.name ?? w.bay : stationName(w);
    if (groupBy === "repo") return w.repo;
    if (groupBy === "cls") return classOf(cat, project, w.cls).name;
    const a = assigneeOf(w);
    return a ? actor(a).name.replace(" (agent)", "") : "Unassigned";
  };
  const groups: Array<[string, WorkOrder[]]> = (() => {
    if (groupBy === "none") return [["", rows]];
    const m = new Map<string, WorkOrder[]>();
    for (const w of rows) {
      const k = groupKey(w);
      m.set(k, [...(m.get(k) ?? []), w]);
    }
    return [...m.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  })();
  const applyView = (id: string) => {
    const v = saved.find((x) => x.id === id);
    setApplied(id);
    if (!v) return;
    const fl2 = { ...{ q: "", cls: "all", where: "all", repo: "all", prio: "all", source: "all", state: "all", assignee: "all" }, ...v.filters } as Record<string, string>;
    const none = (x: string | undefined): string => (!x || x === "all" ? "" : x);
    const tabId = (VIEWS.some((t) => t.id === v.tab) ? v.tab : "all") as string;
    setSel(new Set());
    setU({ view: tabId === "all" ? "" : tabId, q: fl2.q ?? "", cls: none(fl2.cls), pri: none(fl2.prio), station: none(fl2.where), repo: none(fl2.repo), source: none(fl2.source), assignee: none(fl2.assignee), st: none(fl2.state), sort: v.sort.k, dir: v.sort.dir > 0 ? "asc" : "desc", group: v.groupBy, page: "" });
    setHidden(v.hidden);
  };
  const saveView = () =>
    ui.reasonDialog({
      title: "Save this view",
      kicker: "Work orders",
      sub: "Keeps the tab, filters, sort, grouping and columns you have now, for you in this browser.",
      label: "Name",
      placeholder: "For example: My P1s",
      ok: "Save view",
      min: 2,
      onOk: (name) => {
        const id = `v${Date.now().toString(36)}`;
        setSaved([...saved, { id, name: name.trim(), tab, filters: { q: f.q, cls: f.cls, where: f.where, repo: f.repo, prio: f.prio, source: f.source, state: u.st || "all", assignee: f.assignee } as SavedView["filters"], sort, groupBy, hidden }]);
        setApplied(id);
      },
    });
  const dropView = () => {
    setSaved(saved.filter((x) => x.id !== applied));
    setApplied("");
  };
  const tableOf = (items: WorkOrder[], id: string, cap0: string) => (
    <DataTable
      id={id}
      caption={cap0}
      columns={cols}
      rows={items}
      rowKey={(w) => w.id}
      pageSize={PAGE_SIZE}
      pager
      selectable
      selected={sel}
      onSelect={setSel}
      page={groupBy === "none" ? Math.max(0, (Number(u.page) || 1) - 1) : undefined}
      onPage={groupBy === "none" ? (n) => setU({ page: String(n + 1) }) : undefined}
      onRow={(w) => navigate("record", w.id, w.project)}
      sort={{ key: sort.k, dir: sort.dir }}
      onSort={(s) => setU({ sort: s.key, dir: s.dir > 0 ? "asc" : "desc", page: "" })}
    />
  );
  const exportCsv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = ["id,title,project,class,priority,state", ...rows.map((w) => [w.id, esc(w.title), w.project, w.cls, w.priority, w.state].join(","))].join("\n");
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = "work-orders.csv";
      a.click();
    } catch { /* download is a convenience */ }
    ui.toast(`Exported ${rows.length} rows`, "ok");
  };
  const parkSelected = () => {
    const ids = [...sel];
    ui.reasonDialog({
      title: `Park ${ids.length} work order${ids.length === 1 ? "" : "s"}?`,
      kicker: "Work orders",
      sub: "Parked work orders stop moving until someone resumes them.",
      label: "Reason",
      placeholder: "Why do they leave the belt?",
      ok: "Park",
      min: 3,
      onOk: async (reason) => {
        const r = await park.run(ids, "hold", reason);
        if (!r) return { ok: false, msg: "Another park is still running." };
        if (!r.ok) return { ok: false, msg: r.msg };
        ui.toast(r.msg, "ok");
        setSel(new Set());
        return undefined;
      },
    });
  };
  const sw = (id: string, label: string, value: string, onChange: (v: string) => void, options: Array<{ value: string; label: string }>, disabled?: boolean) => (
    <Select id={id} aria-label={label} disabled={disabled} options={[{ value: "all", label: `${label}: all` }, ...options]} value={value} onChange={onChange} />
  );
  return (
    <CrPage
      eyebrow="Operate"
      title="Work orders"
      sub="Every request on the line, across stations. Open one for its full record."
      cls="wo-view"
      acts={
        <>
          <Btn id="wo-export" onClick={exportCsv} disabled={mode !== "table" || !rows.length}><CrIcon name="dl" /><span>Export CSV</span></Btn>
          <Btn label="New work order" kind="primary" icon="plus" id="wo-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWo({ project: project.id })} />
        </>
      }
    >
      {mode === "table" ? (
        <div className="row spread wo-views" style={{ marginBottom: 12 }}>
          <Segmented name="wo-tab" label="Work order views" items={VIEWS.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={(id) => change({ view: id === "all" ? "" : id, st: "" })} />
        </div>
      ) : null}
      <FilterBar
        label="Filter work orders"
        count={mode === "table" ? `${rows.length} of ${loaded.length}` : undefined}
        actions={
          <>
            {filtered && mode === "table" ? <Btn label="Clear" small kind="ghost" id="wo-clear-top" onClick={clearAll} /> : null}
            <Btn label="View options" small kind="ghost" icon="columns" id="wo-opts-btn" aria={opts ? "Hide view options" : "View options"} onClick={() => setOpts(!opts)} />
          </>
        }
      >
        <SearchBox id="wo-q" value={u.q} onChange={(v) => change({ q: v })} placeholder="Search id, title, repo" label="Search" />
        {sw("wo-f-state", "State", f.state, (v) => change({ st: v === "all" ? "" : v }), Object.keys(WO_STATES).map((k) => ({ value: k, label: (WO_STATES as Record<string, { label: string }>)[k]?.label ?? k })), !!VIEW_STATE[tab])}
        {sw("wo-f-cls", "Class", f.cls, (v) => change({ cls: v === "all" ? "" : v }), classesOf(cat, project).map((c) => ({ value: c.id, label: c.name + (c.custom ? " (custom)" : "") })))}
        {sw("wo-f-prio", "Priority", f.prio, (v) => change({ pri: v === "all" ? "" : v }), PRIOS.map((p) => ({ value: p, label: p })))}
        {sw("wo-f-where", "Station", f.where, (v) => change({ station: v === "all" ? "" : v }), [...fl.stations.map((st) => ({ value: st.id, label: `${st.name}${st.enabled ? "" : " (off)"}` })), ...fl.bays.map((b) => ({ value: b.id, label: b.name }))])}
      </FilterBar>
      {opts ? (
        <section className="card wo-opts" id="wo-opts" aria-label="View options">
          <div className="card-b stack">
            <div className="grid g2 wo-filters">
              <Field label="Show as" htmlFor="wo-mode-table">
                <Segmented name="wo-mode" label="Table or board" items={[{ id: "table", label: "Table", icon: "list" }, { id: "board", label: "Board", icon: "board" }]} value={mode} onChange={(v) => updatePrefs({ floorView: v })} />
              </Field>
              <Field label="Repo" htmlFor="wo-f-repo">
                <Select id="wo-f-repo" options={[{ value: "all", label: "All" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]} value={f.repo} onChange={(v) => change({ repo: v === "all" ? "" : v })} />
              </Field>
              <Field label="Source" htmlFor="wo-f-source">
                <Select id="wo-f-source" options={[{ value: "all", label: "All" }, ...sources.map((x) => ({ value: x, label: x }))]} value={f.source} onChange={(v) => change({ source: v === "all" ? "" : v })} />
              </Field>
              <Field label="Assignee" htmlFor="wo-f-assignee">
                <Select id="wo-f-assignee" options={[{ value: "all", label: "Anyone" }, { value: "none", label: "Unassigned" }, ...assignees.map((a) => ({ value: a, label: actor(a).name.replace(" (agent)", "") }))]} value={f.assignee} onChange={(v) => change({ assignee: v === "all" ? "" : v })} />
              </Field>
              <Field label="Group by" htmlFor="wo-group">
                <Select id="wo-group" options={GROUPS.map((g) => ({ value: g.id, label: g.label }))} value={groupBy} onChange={(v) => change({ group: v })} />
              </Field>
              <Field label="Sort by" htmlFor="wo-sort-select">
                <div className="row">
                  <Select id="wo-sort-select" options={SORTS} value={sort.k} onChange={(k) => setU({ sort: k, page: "" })} />
                  <Btn small id="wo-sort-dir" aria={sort.dir > 0 ? "Ascending, switch to descending" : "Descending, switch to ascending"} label={sort.dir > 0 ? "↑ Asc" : "↓ Desc"} onClick={() => setU({ dir: sort.dir > 0 ? "desc" : "asc" })} />
                </div>
              </Field>
              {saved.length ? (
                <Field label="Saved views" htmlFor="wo-views">
                  <Select id="wo-views" options={[{ value: "", label: "Choose a view" }, ...saved.map((v) => ({ value: v.id, label: v.name }))]} value={applied} onChange={applyView} />
                </Field>
              ) : null}
            </div>
            <div className="wo-cols-pop" role="group" aria-label="Columns shown">
              {OPTIONAL_COLS.map(([k, label]) => (
                <label key={k} className="wo-cols-opt">
                  <input type="checkbox" id={`wo-col-${k}`} checked={!hidden.includes(k)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((x) => x !== k) : [...hidden, k])} />
                  {`Show ${label}`}
                </label>
              ))}
            </div>
            <div className="row">
              <Btn label="Save view" small id="wo-view-save" onClick={saveView} />
              {applied ? <Btn label="Delete view" small kind="ghost" id="wo-view-del" onClick={dropView} /> : null}
            </div>
          </div>
        </section>
      ) : null}
      {mode === "board" ? (
        <BoardMode projectId={projectId} />
      ) : (
        <>
          {sel.size ? (
            <div className="banner" id="wo-bulk">
              <span className="grow"><b>{sel.size}</b> selected</span>
              <Btn label="Set priority" small id="wo-bulk-prio" disabledReason="Gantry has no bulk priority change yet. Change a priority on the work order's record." />
              <Btn label="Park" small id="wo-bulk-park" onClick={parkSelected} />
              <Btn label="Clear" small kind="ghost" id="wo-bulk-clear" onClick={() => setSel(new Set())} />
            </div>
          ) : null}
          <Async query={list} what="work orders" id="wo-list">{() => rows.length ? (
            <div className="wo-table" id="wo-table-wrap">
              {groupBy === "none"
                ? tableOf(rows, "wo-table", `Work orders in ${project.name}`)
                : groups.map(([g, items], i) => (
                    <section key={g} className="wo-group" aria-labelledby={`wo-group-h-${i}`}>
                      <h3 className="wo-group-h" id={`wo-group-h-${i}`}>{g} <span className="muted num">{items.length}</span></h3>
                      {tableOf(items, `wo-table-${i}`, `Work orders in ${project.name}: ${g}`)}
                    </section>
                  ))}
              {cut ? <p className="muted small" role="status">{cutNote}</p> : null}
            </div>
          ) : (
            <Empty
              id="wo-empty"
              icon="search"
              title="Nothing matches"
              text={cut ? `None of the work orders read match. ${cutNote}` : filtered ? "Try a different search or clear the filters." : "Submit the first work order to a Ready repo."}
              action={filtered ? <Btn label="Clear filters" id="wo-clear" onClick={clearAll} /> : undefined}
            />
          )}</Async>
        </>
      )}
    </CrPage>
  );
}
