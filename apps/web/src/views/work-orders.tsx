/**
 * Work orders (#work-orders): the project's work as a table or a board.
 * The table filters, sorts and pages on the server (GET /projects/{id}/work-orders). The tabs name the groups people ask for first: the
 * server-side ones (everything, in flight, at Intake, shipped, killed) and three that are worked out here (mine, waiting on me, incidents).
 * Those three, the Assignee filter and Group by read the work orders page by page up to a limit (CAP), and say so when the project has more.
 * Columns and saved views are kept per person in this browser (work-orders/saved.ts). The board is the floor's board (drag, "Move to", swimlanes). The classification card and class override live in
 * work-orders/intake.tsx and the New work order dialog in work-orders/New.tsx.
 */
import { qk } from "../api/keys";
import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { WO_STATES, bayDef, classesOf, flowOf, fmt, gateForWO, gatePendingName, woTotals } from "@gantry/domain";
import { useCan } from "../api/can";
import { api, get } from "../api/client";
import { useHome, useMe, useProject } from "../api/queries";
import { FloorCtx, assigneeOf, useFloorCtx, useFloorState, useProjectRepos, type FloorCtxValue } from "./floor/kit";
import { ReplayBar, useReplayBase, useReplayPlayer } from "./floor/Replay";
import { Board } from "./floor/Board";
import type { Page, WorkOrder } from "../api/types";
import { Btn, Empty, Field, FilterBar, SearchBox, Segmented, Select, Status, ViewHead, type Tone } from "../ui/primitives";
import { Async, Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { DataTable, type Col } from "../ui/SortTable";
import { Icon } from "../ui/Icon";
import { useActors } from "../ui/actors";
import { navigate } from "../lib/router";
import { pickProject } from "../lib/routes";
import { setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { useOpenTraveler } from "../shell/useTraveler";
import { classOf, useCatalog } from "./projects/kit";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";
import { columnsKey, savedViewsKey, useStored, type GroupBy, type SavedView } from "./work-orders/saved";
import { useUI } from "../ui/overlay-context";

type TabId = "all" | "mine" | "waiting" | "intake" | "open" | "done" | "incidents" | "killed";
interface Filters {
  q: string;
  cls: string;
  where: string;
  repo: string;
  prio: string;
  source: string;
  state: string;
  assignee: string;
}
const NONE: Filters = { q: "", cls: "all", where: "all", repo: "all", prio: "all", source: "all", state: "all", assignee: "all" };
type SortKey = string;
const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: "id", label: "Id" },
  { value: "title", label: "Title" },
  { value: "cls", label: "Class" },
  { value: "where", label: "Station / bay" },
  { value: "state", label: "State" },
  { value: "prio", label: "Priority" },
  { value: "age", label: "Age" },
];
const PRIOS = ["P0", "P1", "P2", "P3"];
const PAGE = 60;
const SNAPSHOT = 200;
/** The most work orders read for the views that are worked out here. Beyond it the page says the list is cut short. */
const CAP = 1000;
const GROUPS: Array<{ id: GroupBy; label: string }> = [{ id: "none", label: "No grouping" }, { id: "station", label: "Station" }, { id: "repo", label: "Repo" }, { id: "cls", label: "Class" }, { id: "assignee", label: "Assignee" }];
/** Columns a person can turn on and off. The first (work order) is always shown; the first column already carries class, state and next actor. */
const OPTIONAL_COLS: Array<[string, string]> = [["cls", "Class"], ["where", "Station / bay"], ["state", "State"], ["next", "Next actor"], ["gate", "Gate"], ["repo", "Repo"], ["prio", "Priority"], ["by", "Requested by"], ["age", "Age"], ["spend", "Spend"]];
const DEFAULT_HIDDEN = ["next", "gate", "repo", "by", "spend"];

/** The state each server-side tab asks for. The other tabs read the snapshot. */
const TAB_STATE: Partial<Record<TabId, string>> = { open: "open", done: "done", killed: "killed" };

const STATE_TONE: Record<string, Tone> = { running: "run", waiting: "wait", blocked: "block", failed: "fail", done: "done", parked: "neutral", killed: "block", queued: "neutral" };

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

const isIncident = (w: WorkOrder): boolean => w.state === "blocked" || w.state === "failed" || w.bay === "sechold" || w.bay === "person";

function WoStatus({ state }: { state: string }) {
  const def = (WO_STATES as Record<string, { label: string }>)[state];
  return <Status tone={STATE_TONE[state] ?? "neutral"}>{def?.label ?? state}</Status>;
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
  const open = useOpenTraveler();
  const newWo = useNewWorkOrder();
  const home = useHome().data;
  const [f, setF] = useState<Filters>(NONE);
  const [tab, setTab] = useState<TabId>("all");
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: "id", dir: -1 });
  const ui = useUI();
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [applied, setApplied] = useState("");
  const mode: "table" | "board" = prefs.floorView === "board" ? "board" : "table";
  const projectId = me ? pickProject(me, prefs.project) : null;
  const [hidden, setHidden] = useStored<string[]>(columnsKey(projectId ?? ""), DEFAULT_HIDDEN);
  const [saved, setSaved] = useStored<SavedView[]>(savedViewsKey(projectId ?? ""), []);
  const projectQ = useProject(projectId);
  const project = projectQ.data ?? null;
  const repos = useProjectRepos(projectId);
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});
  const q = useDebounced(f.q.trim(), 250);

  // A tab and the State filter both name a state; the tab wins when it has one.
  const state = TAB_STATE[tab] ?? (tab === "intake" ? "open" : f.state);
  const where = tab === "intake" ? "intake" : f.where;
  const serverTab = tab === "all" || tab === "open" || tab === "done" || tab === "killed" || tab === "intake";
  // Mine, Waiting on me, Incidents, Assignee and Group by are worked out here, so they read every page up to CAP.
  const clientSide = !serverTab || f.assignee !== "all" || groupBy !== "none";
  const { assignee: _assignee, ...serverFilters } = f;
  void _assignee;
  const params = { q, cls: serverFilters.cls, where, repo: serverFilters.repo, prio: serverFilters.prio, source: serverFilters.source, state, sort: sort.k, dir: sort.dir > 0 ? "asc" : "desc" };
  const list = useInfiniteQuery({
    queryKey: qk.woTable(projectId, params),
    queryFn: ({ pageParam }) => get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { ...params, limit: clientSide ? SNAPSHOT : PAGE, cursor: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next || undefined,
    enabled: !!projectId && mode === "table",
    placeholderData: keepPreviousData,
  });
  const loaded = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const waitingIds = useMemo(() => new Set((home?.approvals ?? []).filter((a) => a.project === projectId || !a.project).map((a) => a.wo).filter(Boolean)), [home, projectId]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (clientSide && hasNextPage && !isFetchingNextPage && loaded.length < CAP) void fetchNextPage();
  }, [clientSide, hasNextPage, isFetchingNextPage, loaded.length, fetchNextPage]);
  const cut = clientSide && !!hasNextPage && loaded.length >= CAP;
  const rows = useMemo(() => {
    let r = loaded;
    if (tab === "mine") r = r.filter((w) => w.requestedBy === me?.person.id);
    else if (tab === "waiting") r = r.filter((w) => waitingIds.has(w.id));
    else if (tab === "incidents") r = r.filter(isIncident);
    if (f.assignee !== "all") r = r.filter((w) => (f.assignee === "none" ? !assigneeOf(w) : assigneeOf(w) === f.assignee));
    return r;
  }, [loaded, tab, me, waitingIds, f.assignee]);
  const matched = clientSide ? rows.length : (list.data?.pages[0]?.total ?? 0);

  // unfiltered numbers for the tabs and the filter options
  const stat = useQuery({
    queryKey: qk.woStats(projectId),
    queryFn: async () => {
      const one = async (st: string, extra: Record<string, string> = {}) => (await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { state: st, ...extra, limit: 1 })).total ?? 0;
      const [all, openN, done, killed, intake] = await Promise.all([one("all"), one("open"), one("done"), one("killed"), one("open", { where: "intake" })]);
      return { all, open: openN, done, killed, intake };
    },
    enabled: !!projectId,
  });
  // Every work order up to CAP, for the counts of the tabs that are worked out here.
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
  const assignees = useMemo(() => {
    const s = new Set<string>(loaded.map(assigneeOf).filter((a): a is string => !!a));
    if (f.assignee !== "all" && f.assignee !== "none") s.add(f.assignee);
    return [...s].sort();
  }, [loaded, f.assignee]);
  const live = useQuery({
    queryKey: qk.woIntake(projectId),
    queryFn: async () => (await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { state: "open", where: "intake", limit: 200 })).items,
    enabled: !!projectId,
  });
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
  const atIntake = (live.data ?? []).filter((w) => w.station === 0 && !w.bay && w.state !== "killed" && w.gates?.G0G1 && w.gates.G0G1.status !== "passed");
  const filtered = (Object.keys(NONE) as Array<keyof Filters>).some((k) => (k === "q" ? f.q.trim() !== "" : f[k] !== "all"));
  const set = (k: keyof Filters) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const clear = () => setF(NONE);
  const block = projectSubmitBlock(me, project, repos);
  const snapItems = snap.data?.items;
  const plus = snap.data?.cut ? "+" : "";
  const tabs: Array<{ id: TabId; label: string; count: number | string | null }> = [
    { id: "all", label: "All", count: stat.data?.all ?? null },
    { id: "mine", label: "Mine", count: snapItems ? `${snapItems.filter((w) => w.requestedBy === me.person.id).length}${plus}` : null },
    { id: "waiting", label: "Waiting on me", count: snapItems ? `${snapItems.filter((w) => waitingIds.has(w.id)).length}${plus}` : null },
    { id: "intake", label: "At Intake", count: stat.data?.intake ?? null },
    { id: "open", label: "In flight", count: stat.data?.open ?? null },
    { id: "done", label: "Shipped", count: stat.data?.done ?? null },
    { id: "incidents", label: "Incidents", count: snapItems ? `${snapItems.filter(isIncident).length}${plus}` : null },
    { id: "killed", label: "Killed", count: stat.data?.killed ?? null },
  ];
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
    if (w.state === "done") return <span className="small">{`Shipped${w.pr && (w.pr as { tag?: string }).tag ? ` ${(w.pr as { tag?: string }).tag}` : ""}`}</span>;
    const st = cat.stations[w.station];
    return (
      <span>
        <span className="mono muted">{`${st?.no ?? ""} `}</span>
        {st?.name ?? "?"}
      </span>
    );
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
  const allCols: Col<WorkOrder>[] = [
    {
      key: "id",
      label: "ID",
      sort: (w) => w.id,
      render: (w) => <span className={`mono strong wo-id${w.state === "killed" ? " is-killed" : ""}`}>{w.id}</span>,
    },
    {
      key: "title",
      label: "Title",
      sort: (w) => w.title,
      render: (w) => (
        <span className={`ell wo-title${w.state === "killed" ? " is-killed" : ""}`} title={w.title}>
          {w.title}
          {w.parent ? <span className="muted small">{` · child of ${w.parent}`}</span> : null}
          {w.children?.length ? <span className="muted small">{` · ${w.children.length} children`}</span> : null}
        </span>
      ),
    },
    {
      key: "cls",
      label: "Class",
      sort: (w) => w.cls,
      render: (w) => (
        <span className="wo-cls">
          <span className="tag">{classOf(cat, project, w.cls).name}</span>
          {w.clsOverridden ? (
            <span className="wo-ovr" title={`Class overridden from ${classOf(cat, project, w.clsOverridden.from).name}`}>
              <Icon name="swap" />
            </span>
          ) : null}
        </span>
      ),
    },
    { key: "prio", label: "Pri", sort: (w) => w.priority, render: (w) => <span className={`tag pri ${w.priority.toLowerCase()}`} title={`Priority ${w.priority}`}>{w.priority}</span> },
    { key: "where", label: "Station", sort: (w) => (w.bay ? 100 : 0) + w.station, render: whereCell },
    { key: "state", label: "State", sort: (w) => w.state, render: (w) => <WoStatus state={w.state} /> },
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
    {
      key: "open",
      label: "Open",
      render: (w) => (
        <span className="wo-acts">
          <button type="button" className="icon-btn icon-btn-sm" id={`wo-rec-${w.id}`} aria-label={`Open full record for ${w.id}`} data-tip="Full record" onClick={(e) => { e.stopPropagation(); navigate("record", w.id); }}>
            <Icon name="record" />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" id={`wo-conv-${w.id}`} aria-label={`Open intake conversation for ${w.id}`} data-tip="Intake conversation" onClick={(e) => { e.stopPropagation(); setProject(w.project); updatePrefs({ openConversation: w.id }); navigate("conversations"); }}>
            <Icon name="chat" />
          </button>
        </span>
      ),
    },
  ];
  const cols = allCols.filter((c) => c.key === "id" || c.key === "title" || c.key === "open" || !hidden.includes(c.key));
  const cutNote = `Only the latest ${CAP} work orders are read for this view, so the project has more. Narrow it with the search or a filter.`;
  const showCount = clientSide ? `${rows.length} shown` : `${rows.length} of ${matched} shown`;
  const groupKey = (w: WorkOrder): string => {
    if (groupBy === "station") return w.bay ? bayDef(cat, w.bay)?.name ?? w.bay : w.state === "done" ? "Shipped" : cat.stations[w.station]?.name ?? "?";
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
    setTab(v.tab as TabId);
    setF({ ...NONE, ...v.filters });
    setSort(v.sort);
    setGroupBy(v.groupBy);
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
        setSaved([...saved, { id, name: name.trim(), tab, filters: { ...f }, sort, groupBy, hidden }]);
        setApplied(id);
      },
    });
  const dropView = () => {
    setSaved(saved.filter((x) => x.id !== applied));
    setApplied("");
  };
  const tableOf = (items: WorkOrder[], id: string, cap: string) => (
    <DataTable
      id={id}
      caption={cap}
      columns={cols}
      rows={items}
      rowKey={(w) => w.id}
      onRow={(w) => open(w.id)}
      sort={{ key: sort.k, dir: sort.dir }}
      onSort={(s) => setSort({ k: s.key, dir: s.dir })}
    />
  );
  const exportCsv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = ["id,title,repo,class,priority,state", ...rows.map((w) => [w.id, esc(w.title), w.repo, w.cls, w.priority, w.state].join(","))].join("\n");
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = "work-orders.csv";
      a.click();
    } catch { /* download is a convenience */ }
  };
  const sel = (id: string, label: string, value: string, onChange: (v: string) => void, options: Array<{ value: string; label: string }>) => (
    <Select id={id} aria-label={label} options={[{ value: "all", label: `${label}: all` }, ...options]} value={value} onChange={onChange} />
  );
  return (
    <div className="view view-wide wo-view">
      <div id="wo-head">
        <ViewHead
          kicker="Operate"
          title="Work orders"
          sub={`Every work order in ${project.name}, as a table or a board. Open a row for its traveler, or the record icon for the full lifecycle record.`}
          actions={
            <>
              <Segmented name="wo-mode" label="Table or board" items={[{ id: "table", label: "Table", icon: "list" }, { id: "board", label: "Board", icon: "board" }]} value={mode} onChange={(v) => updatePrefs({ floorView: v })} />
              <Btn label="Export CSV" icon="dl" id="wo-export" onClick={exportCsv} disabled={mode !== "table" || !rows.length} />
              <Btn label="All records" icon="record" id="wo-records" onClick={() => { updatePrefs({ record: null }); navigate("record"); }} />
              <Btn label="New work order" kind="primary" icon="plus" id="wo-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWo({ project: project.id })} />
            </>
          }
        />
      </div>
      {atIntake.length ? (
        <div className="banner wo-intake-note">
          <Icon name="chat" />
          <span className="grow">
            <b>{`${atIntake.length} at Intake`}</b>
            {" They wait for their brief to be confirmed at the first gate. Answer their questions in the work order's conversation. "}
          </span>
          {mode === "table" ? <Btn label="Show At Intake" small id="wo-to-intake" onClick={() => setTab("intake")} /> : null}
          <a href="#conversations" id="wo-to-conv">Open Conversations</a>
        </div>
      ) : null}
      {mode === "board" ? (
        <BoardMode projectId={projectId} />
      ) : (
        <div className="wo-panel">
          <div className="row spread wo-views" style={{ marginBottom: 12 }}>
            <Segmented name="wo-tab" label="Work order views" items={tabs.map((t) => ({ id: t.id, label: t.label, count: t.count }))} value={tab} onChange={(id) => setTab(id as TabId)} />
          </div>
          <FilterBar
            label="Filter work orders"
            count={`${rows.length} of ${matched}`}
            actions={filtered ? <Btn label="Clear" small kind="ghost" id="wo-clear-top" onClick={clear} /> : undefined}
          >
            <SearchBox id="wo-q" value={f.q} onChange={set("q")} placeholder="Search id or title" label="Search" />
            {sel("wo-f-cls", "Class", f.cls, set("cls"), classesOf(cat, project).map((c) => ({ value: c.id, label: c.name + (c.custom ? " (custom)" : "") })))}
            {sel("wo-f-prio", "Priority", f.prio, set("prio"), PRIOS.map((p) => ({ value: p, label: p })))}
            {sel("wo-f-where", "Station", f.where, set("where"), [...fl.stations.map((st) => ({ value: st.id, label: `${st.no} ${st.name}${st.enabled ? "" : " (off)"}` })), ...fl.bays.map((b) => ({ value: b.id, label: `Bay: ${b.name}` }))])}
            {sel("wo-f-state", "State", f.state, set("state"), Object.keys(WO_STATES).map((k) => ({ value: k, label: (WO_STATES as Record<string, { label: string }>)[k]?.label ?? k })))}
          </FilterBar>
          <details className="wo-opts">
            <summary className="btn sm" id="wo-opts-btn"><Icon name="columns" />View options</summary>
            <div className="wo-opts-body">
              <div className="filters wo-filters">
                <Field label="Repo" htmlFor="wo-f-repo">
                  <Select id="wo-f-repo" options={[{ value: "all", label: "All" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]} value={f.repo} onChange={set("repo")} />
                </Field>
                <Field label="Source" htmlFor="wo-f-source">
                  <Select id="wo-f-source" options={[{ value: "all", label: "All" }, ...sources.map((x) => ({ value: x, label: x }))]} value={f.source} onChange={set("source")} />
                </Field>
                <Field label="Assignee" htmlFor="wo-f-assignee">
                  <Select id="wo-f-assignee" options={[{ value: "all", label: "Anyone" }, { value: "none", label: "Unassigned" }, ...assignees.map((a) => ({ value: a, label: actor(a).name.replace(" (agent)", "") }))]} value={f.assignee} onChange={set("assignee")} />
                </Field>
                <Field label="Group by" htmlFor="wo-group">
                  <Select id="wo-group" options={GROUPS.map((g) => ({ value: g.id, label: g.label }))} value={groupBy} onChange={(v) => setGroupBy(v as GroupBy)} />
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
          </details>
          <div className="wo-sortm">
            <Field label="Sort by" htmlFor="wo-sort-select">
              <div className="wo-sortm-row">
                <Select id="wo-sort-select" options={SORTS} value={sort.k} onChange={(k) => setSort((x) => ({ ...x, k: k as SortKey }))} />
                <button type="button" id="wo-sort-dir" className="btn btn-sm" aria-label={sort.dir > 0 ? "Ascending, switch to descending" : "Descending, switch to ascending"} onClick={() => setSort((x) => ({ ...x, dir: x.dir === 1 ? -1 : 1 }))}>
                  {sort.dir > 0 ? "↑ Asc" : "↓ Desc"}
                </button>
              </div>
            </Field>
          </div>
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
              <div className="wo-foot pager">
                <span className="muted small" role="status">{cut ? `${showCount}. ${cutNote}` : showCount}</span>
                {!clientSide && list.hasNextPage ? <Btn label={`Show ${Math.min(PAGE, matched - rows.length)} more of ${matched - rows.length}`} small id="wo-table-more" onClick={() => void list.fetchNextPage()} /> : null}
              </div>
            </div>
          ) : (
            <Empty
              id="wo-empty"
              icon="list"
              title="No work orders match"
              text={cut ? `None of the work orders read match. ${cutNote}` : filtered || tab !== "all" ? "Clear the search or filters, or choose another tab." : "Submit the first work order to a Ready repo."}
              action={filtered ? <Btn label="Clear filters" id="wo-clear" onClick={clear} /> : undefined}
            />
          )}</Async>
        </div>
      )}
      <p className="hint wo-live">Updates live as work moves.</p>
    </div>
  );
}
