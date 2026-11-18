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
import { bayDef, classesOf, flowOf, fmt, requiredFor } from "@gantry/domain";
import { useCan } from "../api/can";
import { api, get } from "../api/client";
import { useParkMany } from "../api/bulk";
import { useHome, useMe, useProject, useProjects, useWorkOrdersAcross } from "../api/queries";
import { useActors } from "../ui/actors";
import { WoActions, WoNext } from "./work-orders/WoActions";
import { costOf, lastActivity, needsOf, type Needs } from "./work-orders/needs";
import type { HomeFull } from "./home/data";
import { FloorCtx, mergeProjects, useFloorCtx, useProjectRepos, useScopedFloorState, type FloorCtxValue } from "./floor/kit";
import { ReplayBar, useReplayBase, useReplayPlayer } from "./floor/Replay";
import { Board } from "./floor/Board";
import type { Page, WorkOrder } from "../api/types";
import { Btn, Empty, Field, FilterBar, SearchBox, Segmented, Select } from "../ui/primitives";
import { Async, Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { DataTable, type Col } from "../ui/SortTable";
import { CrIcon, Page as CrPage } from "../ui/cr";
import { Icon } from "../ui/Icon";
import { navigate } from "../lib/router";
import { useScope } from "../lib/scope";
import { classOf, useCatalog } from "./projects/kit";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";
import { useUrlState } from "./work-orders/url-state";
import { useUI } from "../ui/overlay-context";

type TabId = "all" | "mine" | "gate" | "blocked";
const VIEWS: Array<{ id: TabId; label: string }> = [{ id: "all", label: "All" }, { id: "mine", label: "Requested by me" }, { id: "gate", label: "At a gate" }, { id: "blocked", label: "Blocked" }];
import { STATE_OPTIONS, WoStateChip, stateOf } from "./work-orders/state";
const URL_KEYS = ["view", "q", "st", "cls", "pri", "station", "sort", "dir", "page", "mode"] as const;
const PRIOS = ["P1", "P2", "P3"];
const PAGE_SIZE = 12;
const SNAPSHOT = 200;
/** The most work orders read for this list. Beyond it the page says the list is cut short. */
const CAP = 1000;
const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

/** The board is the floor's board; it needs the floor read, which this wrapper loads and hands down. */
function BoardMode({ projectId, projectIds }: { projectId: string | null; projectIds: string[] | null }) {
  const base = useReplayBase(projectId);
  const { value, error } = useScopedFloorState(projectIds ? { all: true, projectIds } : { all: false, projectId }, base);
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
function BoardBody({ projectId }: { projectId: string | null }) {
  const ctx = useFloorCtx();
  const rp = ctx.replay;
  const { playing, setPlaying, enter, exit } = useReplayPlayer(projectId ?? "", rp, "wo-board-mode-live");
  return (
    <div className="wo-board">
      <div className="wo-board-bar">
        {ctx.all ? null : <Segmented name="wo-board-mode" label="Live or replay" items={[{ id: "live", label: "Live" }, { id: "replay", label: "Replay" }]} value={rp ? "replay" : "live"} onChange={(v) => (v === "replay" ? enter() : exit())} />}
      </div>
      {rp ? <ReplayBar rp={rp} playing={playing} setPlaying={setPlaying} onExit={exit} /> : null}
      <Board />
    </div>
  );
}

function WorkOrdersView() {
  const me = useMe();
  const scope = useScope();
  const cat = useCatalog();
  const newWo = useNewWorkOrder();
  const ui = useUI();
  const park = useParkMany();
  const [u, setU] = useUrlState(URL_KEYS, { view: "all", sort: "needs", dir: "desc", page: "1" });
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  // The list is a table or the floor's board; the Table / Board switch in the view row writes `?mode=`.
  const mode: "table" | "board" = u.mode === "board" ? "board" : "table";
  const projectId = scope.projectId;
  const projectIds = useMemo(() => scope.projects.map((p) => p.id), [scope.projects]);
  const allProjectsQ = useProjects();
  const projectQ = useProject(projectId);
  // Under All the page is over the merged line of the visible projects; a row keeps its own project's classes.
  const inScope = useMemo(() => (allProjectsQ.data ?? []).filter((p) => projectIds.includes(p.id)), [allProjectsQ.data, projectIds]);
  const project = scope.all ? (cat && inScope.length ? mergeProjects(cat, inScope) : null) : (projectQ.data ?? null);
  const repos = useProjectRepos(projectId);
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});
  const actors = useActors();
  const home = useHome().data as HomeFull | undefined;
  /* The gate rule's vote count comes from the open approvals the server lists for this person, keyed by work order and gate. */
  const voteMap = useMemo(() => new Map((home?.sections?.waiting?.approvals ?? []).filter((a) => a.wo && a.gate && a.need).map((a) => [`${a.wo}:${a.gate}`, { have: a.have ?? 0, need: a.need ?? 0 }] as const)), [home]);
  const votes = (wo: string, gate: string) => voteMap.get(`${wo}:${gate}`);

  const tab: TabId = VIEWS.some((v) => v.id === u.view) ? (u.view as TabId) : "all";
  const sort = { k: u.sort, dir: (u.dir === "asc" ? 1 : -1) as 1 | -1 };
  const stateFilter = tab === "gate" ? "gate" : tab === "blocked" ? "blocked" : u.st || "all";
  const f = { q: u.q, cls: u.cls || "all", where: u.station || "all", prio: u.pri || "all", state: stateFilter };
  const listOne = useInfiniteQuery({
    queryKey: qk.woTable(projectId, {}),
    queryFn: ({ pageParam }) => get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { sort: "id", dir: "desc", limit: SNAPSHOT, cursor: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next || undefined,
    enabled: !!projectId && !scope.all && mode === "table",
    placeholderData: keepPreviousData,
  });
  const listAll = useWorkOrdersAcross(projectIds, { cap: CAP, pageSize: SNAPSHOT, enabled: scope.all && mode === "table" });
  const list: Pick<typeof listOne, "data" | "error" | "isPending" | "isError" | "refetch"> | typeof listAll = scope.all ? listAll : listOne;
  const loaded = useMemo(() => (scope.all ? (listAll.data?.items ?? []) : (listOne.data?.pages.flatMap((p) => p.items) ?? [])), [scope.all, listAll.data, listOne.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = listOne;
  useEffect(() => {
    if (!scope.all && hasNextPage && !isFetchingNextPage && loaded.length < CAP) void fetchNextPage();
  }, [scope.all, hasNextPage, isFetchingNextPage, loaded.length, fetchNextPage]);
  const cut = scope.all ? (listAll.data?.cut.length ?? 0) > 0 : !!hasNextPage && loaded.length >= CAP;
  const needle = f.q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      loaded.filter(
        (w) =>
          (tab !== "mine" || w.requestedBy === me?.person.id) &&
          (f.state === "all" || stateOf(w) === f.state) &&
          (f.cls === "all" || w.cls === f.cls) &&
          (f.prio === "all" || w.priority === f.prio) &&
          (f.where === "all" || (w.bay ?? cat?.stations[w.station]?.id) === f.where) &&
          (!needle || `${w.id} ${w.title} ${w.repo} ${w.project}`.toLowerCase().includes(needle)),
      ),
    [loaded, tab, me, f.state, f.cls, f.prio, f.where, needle, cat],
  );

  if (!me || !cat) return null;
  if (!scope.projects.length || !project) {
    return (
      <div className="view">
        {scope.all || projectId ? <Async<unknown> query={scope.all ? allProjectsQ : projectQ} what={scope.all ? "your projects" : "this project"} id="wo-project">{() => null}</Async> : <Empty title="No project" text="You do not have a project to show." />}
      </div>
    );
  }
  const projectFor = (id: string) => inScope.find((p) => p.id === id) ?? project;
  const fl = flowOf(cat, project);
  const projectKey = (id: string): string => me.projects.find((p) => p.id === id)?.key ?? id;
  const nameOf = (id: string): string => me.projects.find((p) => p.id === id)?.name ?? id;
  const filtered = !!(needle || f.cls !== "all" || f.where !== "all" || f.prio !== "all" || u.st || tab !== "all");
  const clearAll = () => { setU({ q: "", st: "", cls: "", pri: "", station: "", view: "", page: "" }); };
  const change = (patch: Partial<Record<(typeof URL_KEYS)[number], string>>) => { setSel(new Set()); setU({ ...patch, page: "" }); };
  const block = scope.all ? null : projectSubmitBlock(me, project, repos);
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
  const idNum = (w: WorkOrder): number => Number(w.id.replace(/\D/g, "")) || 0;
  const now = Date.now();
  const needs = (w: WorkOrder): Needs => needsOf(w, { cat, now, votes, required: (x, g) => { const r = projectFor(x.project).approvers?.[g]; return r ? requiredFor(r, x.cls) : undefined; }, agent: (id) => actors(id).name.replace(" (agent)", "") });
  const cols: Col<WorkOrder>[] = [
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
        <span className={`wo-title${w.state === "killed" ? " is-killed" : ""}`} title={w.title}>
          <span className="wo-title-t">{w.title}</span>
          {w.parent || w.children?.length ? <span className="muted small">{w.parent ? `child of ${w.parent}` : `${w.children.length} children`}</span> : null}
        </span>
      ),
    },
    ...(scope.all ? [{ key: "project", label: "Project", sort: (w: WorkOrder) => w.project, render: (w: WorkOrder) => <span className="tag">{projectKey(w.project)}</span> }] : []),
    {
      key: "cls",
      label: "Class",
      sort: (w) => w.cls,
      render: (w) => {
        const c = classOf(cat, projectFor(w.project), w.cls);
        return (
          <span className="wo-cls">
            <span className="tag">{c.custom ? c.name : cap(w.cls)}</span>
            {w.clsOverridden ? (
              <span className="wo-ovr" title={`Class overridden from ${classOf(cat, projectFor(w.project), w.clsOverridden.from).name}`}>
                <Icon name="swap" />
              </span>
            ) : null}
            <span className={`tag pri ${w.priority.toLowerCase()}`} title={`Priority ${w.priority}`}>{w.priority}</span>
          </span>
        );
      },
    },
    {
      key: "where",
      label: "Station",
      sort: (w) => (w.bay ? 100 : 0) + w.station,
      render: (w) => (
        <span className="wo-where">
          {whereCell(w)}
          <WoStateChip w={w} gates={cat.gates} />
        </span>
      ),
    },
    {
      key: "needs",
      label: "Needs",
      sort: (w) => needs(w).rank * 1e7 + idNum(w),
      render: (w) => {
        const n = needs(w);
        return (
          <span className={`wo-needs wo-needs-${n.kind}${n.me ? " is-me" : ""}`} id={`wo-needs-${w.id}`}>
            <span className="wo-needs-t">{n.text}</span>
            {n.detail ? <span className="wo-needs-d small muted" title={n.detail}>{n.detail}</span> : null}
          </span>
        );
      },
    },
    {
      key: "act",
      label: "Activity",
      sort: (w) => lastActivity(w),
      render: (w) => {
        const cost = costOf(w);
        return (
          <span className="wo-act">
            <span className="mono" title="Last activity">{fmt.ago(lastActivity(w), now)}</span>
            <span className="mono muted small" title="Cost so far">{cost ? fmt.money(cost) : "$0.00"}</span>
          </span>
        );
      },
    },
    { key: "do", label: "", align: "end", render: (w) => <WoActions wo={w} next={<WoNext w={w} cat={cat} projectName={nameOf(w.project)} />} /> },
  ];
  const cutNote = `Only the latest ${CAP} work orders are read for this view, so ${scope.all ? "a project has" : "the project has"} more. Narrow it with the search or a filter.`;
  const exportCsv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = ["id,title,project,class,priority,state", ...rows.map((w) => [w.id, esc(w.title), w.project, w.cls, w.priority, stateOf(w)].join(","))].join("\n");
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = "work-orders.csv";
      a.click();
    } catch { /* download is a convenience */ }
    ui.toast(`Exported ${rows.length} rows`, "ok");
  };
  const parkSelected = async () => {
    const ids = [...sel];
    const ok = await ui.confirm({
      title: `Park ${ids.length} work order${ids.length === 1 ? "" : "s"}?`,
      sub: "Parked work orders stop moving until someone resumes them.",
      ok: "Park",
      bare: true,
      cancelKind: "",
    });
    if (!ok) return;
    const r = await park.run(ids, "hold", "Parked from the work orders list");
    if (!r) return ui.toast("Another park is still running.", "warn");
    ui.toast(r.ok ? r.msg : r.msg, r.ok ? "ok" : "warn");
    if (r.ok) setSel(new Set());
  };
  const setPriority = () => {
    const n = sel.size;
    ui.dialog({
      title: "Set priority",
      bare: true,
      sub: `${n} work order${n === 1 ? "" : "s"}`,
      body: (
        <Field label="Priority" htmlFor="wo-bulk-prio-select">
          <Select id="wo-bulk-prio-select" options={PRIOS.map((p) => ({ value: p, label: p }))} value="P2" onChange={() => undefined} />
        </Field>
      ),
      actions: [
        { label: "Cancel", kind: "" },
        // Gantry has no endpoint that changes a work order's priority yet (backend gap): say so instead of pretending.
        { label: "Apply", kind: "primary", id: "wo-bulk-prio-apply", submit: true, onClick: (close) => { close(); ui.toast("Changing priority is not available yet: Gantry has no priority change on a work order.", "warn"); } },
      ],
    });
  };
  const sw = (id: string, label: string, value: string, onChange: (v: string) => void, options: Array<{ value: string; label: string }>) => (
    <Select id={id} aria-label={label} options={[{ value: "all", label: `${label}: all` }, ...options]} value={value} onChange={onChange} />
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
          {scope.all ? (
            <Btn label="New work order" kind="primary" icon="plus" id="wo-new" aria="New work order: choose the project first" onClick={(e) => ui.menu(e.currentTarget, "New work order in which project?", scope.projects.filter((p) => p.status !== "archived").map((p) => ({ label: p.name, icon: "projects", hint: p.key, onClick: () => newWo({ project: p.id }) })))} />
          ) : (
            <Btn label="New work order" kind="primary" icon="plus" id="wo-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWo({ project: project.id })} />
          )}
        </>
      }
    >
      <div className="row wo-views" style={{ marginBottom: 12 }}>
        {mode === "table" ? (
          <Segmented name="wo-tab" label="Work order views" items={VIEWS.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={(id) => change({ view: id === "all" ? "" : id, st: "" })} />
        ) : <span />}
        <span className="grow" />
        <Segmented name="wo-mode" label="Table or board" items={[{ id: "table", label: "Table", icon: "list" }, { id: "board", label: "Board", icon: "board" }]} value={mode} onChange={(id) => change({ mode: id === "board" ? "board" : "" })} />
      </div>
      {mode === "table" ? (
        <FilterBar
          label="Filter work orders"
          count={`${rows.length} of ${loaded.length}`}
          actions={filtered ? <Btn label="Clear" small kind="ghost" id="wo-clear-top" onClick={clearAll} /> : undefined}
        >
          <SearchBox id="wo-q" value={u.q} onChange={(v) => change({ q: v })} placeholder="Search id, title, repo" label="Search id, title, repo" />
          {sw("wo-f-state", "State", f.state, (v) => change({ st: v === "all" ? "" : v }), STATE_OPTIONS)}
          {sw("wo-f-cls", "Class", f.cls, (v) => change({ cls: v === "all" ? "" : v }), classesOf(cat, project).map((c) => ({ value: c.id, label: c.name })))}
          {sw("wo-f-prio", "Priority", f.prio, (v) => change({ pri: v === "all" ? "" : v }), PRIOS.map((p) => ({ value: p, label: p })))}
          {sw("wo-f-where", "Station", f.where, (v) => change({ station: v === "all" ? "" : v }), fl.stations.map((st) => ({ value: st.id, label: st.name })))}
        </FilterBar>
      ) : null}
      {mode === "board" ? (
        <BoardMode projectId={projectId} projectIds={scope.all ? projectIds : null} />
      ) : (
        <>
          {sel.size ? (
            <div className="banner" id="wo-bulk">
              <span className="grow"><b>{sel.size}</b> selected</span>
              <Btn label="Set priority" small id="wo-bulk-prio" onClick={setPriority} />
              <Btn label="Park" small id="wo-bulk-park" onClick={parkSelected} />
              <Btn label="Clear" small kind="ghost" id="wo-bulk-clear" onClick={() => setSel(new Set())} />
            </div>
          ) : null}
          <Async<unknown> query={list} what="work orders" id="wo-list">{() => rows.length ? (
            <div className="wo-table" id="wo-table-wrap">
              <DataTable
                id="wo-table"
                caption={`Work orders in ${scope.all ? "all projects" : project.name}`}
                columns={cols}
                rows={rows}
                rowKey={(w) => w.id}
                pageSize={PAGE_SIZE}
                pager
                sortHints
                selectable
                selected={sel}
                onSelect={setSel}
                page={Math.max(0, (Number(u.page) || 1) - 1)}
                onPage={(n) => setU({ page: String(n + 1) })}
                onRow={(w) => navigate("record", w.id, w.project)}
                sort={{ key: sort.k, dir: sort.dir }}
                onSort={(s) => setU({ sort: s.key, dir: s.dir > 0 ? "asc" : "desc", page: "" })}
              />
              {cut ? <p className="muted small" role="status">{cutNote}</p> : null}
            </div>
          ) : (
            <Empty
              id="wo-empty"
              icon="search"
              title="Nothing matches"
              text={cut ? `None of the work orders read match. ${cutNote}` : "Try clearing a filter or searching for something else."}
              action={<Btn label="Clear filters" id="wo-clear" onClick={clearAll} />}
            />
          )}</Async>
        </>
      )}
    </CrPage>
  );
}

export default WorkOrdersView;
