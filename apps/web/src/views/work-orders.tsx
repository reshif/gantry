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
import { bayDef, classesOf, flowOf, fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { api, get } from "../api/client";
import { useParkMany } from "../api/bulk";
import { useMe, useProject } from "../api/queries";
import { FloorCtx, useFloorCtx, useFloorState, useProjectRepos, type FloorCtxValue } from "./floor/kit";
import { ReplayBar, useReplayBase, useReplayPlayer } from "./floor/Replay";
import { Board } from "./floor/Board";
import type { Page, WorkOrder } from "../api/types";
import { Btn, Empty, Field, FilterBar, SearchBox, Segmented, Select } from "../ui/primitives";
import { Async, Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { DataTable, type Col } from "../ui/SortTable";
import { CrIcon, Page as CrPage } from "../ui/cr";
import { Icon } from "../ui/Icon";
import { navigate } from "../lib/router";
import { pickProject } from "../lib/routes";
import { usePrefs } from "../lib/prefs";
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

function WorkOrdersView() {
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const newWo = useNewWorkOrder();
  const ui = useUI();
  const park = useParkMany();
  const [u, setU] = useUrlState(URL_KEYS, { view: "all", sort: "id", dir: "desc", page: "1" });
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  // The prototype list is a table only: the board stays reachable from a link (`?mode=board`) but has no toggle on the page.
  const mode: "table" | "board" = u.mode === "board" ? "board" : "table";
  const projectId = me ? pickProject(me, prefs.project) : null;
  const projectQ = useProject(projectId);
  const project = projectQ.data ?? null;
  const repos = useProjectRepos(projectId);
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});

  const tab: TabId = VIEWS.some((v) => v.id === u.view) ? (u.view as TabId) : "all";
  const sort = { k: u.sort, dir: (u.dir === "asc" ? 1 : -1) as 1 | -1 };
  const stateFilter = tab === "gate" ? "gate" : tab === "blocked" ? "blocked" : u.st || "all";
  const f = { q: u.q, cls: u.cls || "all", where: u.station || "all", prio: u.pri || "all", state: stateFilter };
  const list = useInfiniteQuery({
    queryKey: qk.woTable(projectId, {}),
    queryFn: ({ pageParam }) => get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { sort: "id", dir: "desc", limit: SNAPSHOT, cursor: pageParam || undefined }),
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
  if (!projectId || !project) {
    return (
      <div className="view">
        {projectId ? <Async query={projectQ} what="this project" id="wo-project">{() => null}</Async> : <Empty title="No project" text="You do not have a project to show." />}
      </div>
    );
  }
  const fl = flowOf(cat, project);
  const projectKey = (id: string): string => me.projects.find((p) => p.id === id)?.key ?? id;
  const filtered = !!(needle || f.cls !== "all" || f.where !== "all" || f.prio !== "all" || u.st || tab !== "all");
  const clearAll = () => { setU({ q: "", st: "", cls: "", pri: "", station: "", view: "", page: "" }); };
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
  const idNum = (w: WorkOrder): number => Number(w.id.replace(/\D/g, "")) || 0;
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
    { key: "state", label: "State", sort: (w) => stateOf(w), render: (w) => <WoStateChip w={w} gates={cat.gates} /> },
    { key: "age", label: "Age", align: "end", sort: (w) => -w.createdAt, render: (w) => <span className="mono">{fmt.dur(Date.now() - w.createdAt)}</span> },
  ];
  const cutNote = `Only the latest ${CAP} work orders are read for this view, so the project has more. Narrow it with the search or a filter.`;
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
          <Btn label="New work order" kind="primary" icon="plus" id="wo-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWo({ project: project.id })} />
        </>
      }
    >
      <div className="row wo-views" style={{ marginBottom: 12 }}>
        {mode === "table" ? (
          <Segmented name="wo-tab" label="Work order views" items={VIEWS.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={(id) => change({ view: id === "all" ? "" : id, st: "" })} />
        ) : <span />}
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
        <BoardMode projectId={projectId} />
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
          <Async query={list} what="work orders" id="wo-list">{() => rows.length ? (
            <div className="wo-table" id="wo-table-wrap">
              <DataTable
                id="wo-table"
                caption={`Work orders in ${project.name}`}
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
