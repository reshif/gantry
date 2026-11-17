/**
 * Work orders (#work-orders): the project's work as a table or a board.
 * The table filters, sorts and pages on the server (GET /projects/{id}/work-orders). The tabs name the groups people ask for first: the
 * server-side ones (everything, in flight, at Intake, shipped, killed) and three that read the latest 200 work orders (mine, waiting on me,
 * incidents). The board is the floor's board (drag, "Move to", swimlanes). The classification card and class override live in
 * work-orders/intake.tsx and the New work order dialog in work-orders/New.tsx.
 */
import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { WO_STATES, bayDef, classesOf, flowOf, fmt, gateForWO, woTotals } from "@gantry/domain";
import { useCan } from "../api/can";
import { api, get } from "../api/client";
import { useHome, useMe, useProject } from "../api/queries";
import { FloorCtx, assigneeOf, useFloorState, useProjectRepos, type FloorCtxValue } from "./floor/kit";
import { Board } from "./floor/Board";
import type { Page, WorkOrder } from "../api/types";
import { Btn, Empty, Field, FilterBar, Panel, SearchBox, Segmented, Select, Status, Tabs, ViewHead, type Tone } from "../ui/primitives";
import { Async, Loading, LoadFailed, NotVisible, failureOf } from "../ui/async";
import { DataTable, type Col } from "../ui/SortTable";
import { Icon } from "../ui/Icon";
import { useActors } from "../ui/actors";
import { navigate } from "../lib/router";
import { pickProject } from "../lib/routes";
import { setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { useOpenTraveler } from "../shell/useTraveler";
import { ClassChip, classOf, useCatalog } from "./projects/kit";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";

type TabId = "all" | "mine" | "waiting" | "intake" | "open" | "done" | "incidents" | "killed";
interface Filters {
  q: string;
  cls: string;
  where: string;
  repo: string;
  prio: string;
  source: string;
  state: string;
}
const NONE: Filters = { q: "", cls: "all", where: "all", repo: "all", prio: "all", source: "all", state: "all" };
const PRIOS = ["P0", "P1", "P2", "P3"];
const PAGE = 60;
const SNAPSHOT = 200;

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
  const { value, error } = useFloorState(projectId, null);
  if (!value) {
    const f = error ? failureOf(error) : null;
    return !f ? <Loading id="wo-board-loading" label="the board" /> : f.hidden ? <NotVisible id="wo-board-hidden" what="this board" reason={f.msg} /> : <LoadFailed id="wo-board-error" what="the board" msg={f.msg} onRetry={() => window.location.reload()} />;
  }
  return (
    <FloorCtx.Provider value={value as FloorCtxValue}>
      <div className="wo-board">
        <Board />
      </div>
    </FloorCtx.Provider>
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
  const mode: "table" | "board" = prefs.floorView === "board" ? "board" : "table";
  const projectId = me ? pickProject(me, prefs.project) : null;
  const projectQ = useProject(projectId);
  const project = projectQ.data ?? null;
  const repos = useProjectRepos(projectId);
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});
  const q = useDebounced(f.q.trim(), 250);

  // A tab and the State filter both name a state; the tab wins when it has one.
  const state = TAB_STATE[tab] ?? (tab === "intake" ? "open" : f.state);
  const where = tab === "intake" ? "intake" : f.where;
  const serverTab = tab === "all" || tab === "open" || tab === "done" || tab === "killed" || tab === "intake";
  const params = { q, cls: f.cls, where, repo: f.repo, prio: f.prio, source: f.source, state, sort: sort.k, dir: sort.dir > 0 ? "asc" : "desc" };
  const list = useInfiniteQuery({
    queryKey: ["workOrders", "table", projectId, params],
    queryFn: ({ pageParam }) => get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { ...params, limit: serverTab ? PAGE : SNAPSHOT, cursor: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next || undefined,
    enabled: !!projectId && mode === "table",
    placeholderData: keepPreviousData,
  });
  const loaded = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const waitingIds = useMemo(() => new Set((home?.approvals ?? []).filter((a) => a.project === projectId || !a.project).map((a) => a.wo).filter(Boolean)), [home, projectId]);
  const rows = useMemo(() => {
    if (tab === "mine") return loaded.filter((w) => w.requestedBy === me?.person.id);
    if (tab === "waiting") return loaded.filter((w) => waitingIds.has(w.id));
    if (tab === "incidents") return loaded.filter(isIncident);
    return loaded;
  }, [loaded, tab, me, waitingIds]);
  const matched = serverTab ? (list.data?.pages[0]?.total ?? 0) : rows.length;

  // unfiltered numbers for the tabs and the filter options
  const stat = useQuery({
    queryKey: ["workOrders", "stats", projectId],
    queryFn: async () => {
      const one = async (st: string, extra: Record<string, string> = {}) => (await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { state: st, ...extra, limit: 1 })).total ?? 0;
      const [all, openN, done, killed, intake] = await Promise.all([one("all"), one("open"), one("done"), one("killed"), one("open", { where: "intake" })]);
      return { all, open: openN, done, killed, intake };
    },
    enabled: !!projectId,
  });
  const snap = useQuery({
    queryKey: ["workOrders", "snapshot", projectId],
    queryFn: async () => (await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { state: "all", limit: SNAPSHOT })).items,
    enabled: !!projectId,
  });
  const live = useQuery({
    queryKey: ["workOrders", "intake", projectId],
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
  const snapItems = snap.data;
  const tabs: Array<{ id: TabId; label: string; count: number | null }> = [
    { id: "all", label: "All", count: stat.data?.all ?? null },
    { id: "mine", label: "Mine", count: snapItems ? snapItems.filter((w) => w.requestedBy === me.person.id).length : null },
    { id: "waiting", label: "Waiting on me", count: snapItems ? snapItems.filter((w) => waitingIds.has(w.id)).length : null },
    { id: "intake", label: "At Intake", count: stat.data?.intake ?? null },
    { id: "open", label: "In flight", count: stat.data?.open ?? null },
    { id: "done", label: "Shipped", count: stat.data?.done ?? null },
    { id: "incidents", label: "Incidents", count: snapItems ? snapItems.filter(isIncident).length : null },
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
    return g ? g.name : "None next";
  };
  const cols: Col<WorkOrder>[] = [
    {
      key: "id",
      label: "Work order",
      sort: (w) => w.id,
      render: (w) => {
        const killed = w.state === "killed";
        return (
          <span className="wo-main">
            <span className={`mono strong wo-id${killed ? " is-killed" : ""}`}>{w.id}</span>
            <span className={`wo-title${killed ? " is-killed" : ""}`}>
              {w.title}
              {w.parent ? <span className="muted small">{` · child of ${w.parent}`}</span> : null}
              {w.children?.length ? <span className="muted small">{` · ${w.children.length} children`}</span> : null}
            </span>
          </span>
        );
      },
    },
    {
      key: "cls",
      label: "Class",
      sort: (w) => w.cls,
      render: (w) => (
        <span className="wo-cls">
          <ClassChip cls={classOf(cat, project, w.cls)} small />
          {w.clsOverridden ? (
            <span className="wo-ovr" title={`Class overridden from ${classOf(cat, project, w.clsOverridden.from).name}`}>
              <Icon name="swap" />
            </span>
          ) : null}
        </span>
      ),
    },
    { key: "where", label: "Station / bay", sort: (w) => (w.bay ? 100 : 0) + w.station, render: whereCell },
    { key: "state", label: "State", sort: (w) => w.state, render: (w) => <WoStatus state={w.state} /> },
    { key: "next", label: "Next actor", hideSmall: true, render: (w) => <span className="small">{nextActor(w)}</span> },
    { key: "gate", label: "Gate", hideSmall: true, render: (w) => <span className="small muted">{gateCell(w)}</span> },
    { key: "repo", label: "Repo", hideSmall: true, render: (w) => <span className="mono small">{w.repo}</span> },
    { key: "prio", label: "Pri", sort: (w) => w.priority, render: (w) => <span className={`chip wo-prio wo-prio-${w.priority}`}>{w.priority}</span> },
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
  const showCount = serverTab ? `${rows.length} of ${matched} shown` : `${rows.length} shown`;
  return (
    <div className="view view-wide wo-view">
      <div id="wo-head">
        <ViewHead
          title="Work orders"
          sub={`Every work order in ${project.name}, as a table or a board. Open a row for its traveler, or the record icon for the full lifecycle record.`}
          actions={
            <>
              <Segmented name="wo-mode" label="Table or board" items={[{ id: "table", label: "Table", icon: "list" }, { id: "board", label: "Board", icon: "board" }]} value={mode} onChange={(v) => updatePrefs({ floorView: v })} />
              <Btn label="All records" icon="record" id="wo-records" onClick={() => { updatePrefs({ record: null }); navigate("record"); }} />
              <Btn label="New work order" kind="primary" icon="plus" id="wo-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWo({ project: project.id })} />
            </>
          }
        />
      </div>
      {atIntake.length ? (
        <div className="callout callout-info wo-intake-note">
          <Icon name="chat" />
          <div>
            <strong>{`${atIntake.length} at Intake`}</strong>
            <span>{" They wait for their brief to be confirmed at the first gate. Answer their questions in the work order's conversation. "}</span>
            <Btn label="Show At Intake" small id="wo-to-intake" onClick={() => setTab("intake")} />{" "}
            <a href="#conversations" id="wo-to-conv">Open Conversations</a>
          </div>
        </div>
      ) : null}
      {mode === "board" ? (
        <BoardMode projectId={projectId} />
      ) : (
        <Panel flush cls="wo-panel">
          <Tabs items={tabs.map((t) => ({ id: t.id, label: t.label, count: t.count }))} active={tab} onChange={(id) => setTab(id as TabId)} idPrefix="wo-tab" />
          <div className="wo-bar">
            <FilterBar
              label="Filter work orders"
              actions={filtered ? <Btn label="Clear filters" small kind="ghost" id="wo-clear-top" onClick={clear} /> : null}
            >
              <SearchBox id="wo-q" value={f.q} onChange={set("q")} placeholder="Id or title" label="Search" />
              <div className="filters wo-filters">
                <Field label="Class" htmlFor="wo-f-cls">
                  <Select id="wo-f-cls" options={[{ value: "all", label: "All" }, ...classesOf(cat, project).map((c) => ({ value: c.id, label: c.name + (c.custom ? " (custom)" : "") }))]} value={f.cls} onChange={set("cls")} />
                </Field>
                <Field label="Repo" htmlFor="wo-f-repo">
                  <Select id="wo-f-repo" options={[{ value: "all", label: "All" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]} value={f.repo} onChange={set("repo")} />
                </Field>
                <Field label="Priority" htmlFor="wo-f-prio">
                  <Select id="wo-f-prio" options={[{ value: "all", label: "All" }, ...PRIOS.map((p) => ({ value: p, label: p }))]} value={f.prio} onChange={set("prio")} />
                </Field>
                <Field label="Station or bay" htmlFor="wo-f-where">
                  <Select id="wo-f-where" options={[{ value: "all", label: "All" }, ...fl.stations.map((s) => ({ value: s.id, label: `${s.no} ${s.name}${s.enabled ? "" : " (off)"}` })), ...fl.bays.map((b) => ({ value: b.id, label: `Bay: ${b.name}` }))]} value={f.where} onChange={set("where")} />
                </Field>
                <Field label="Source" htmlFor="wo-f-source">
                  <Select id="wo-f-source" options={[{ value: "all", label: "All" }, ...sources.map((s) => ({ value: s, label: s }))]} value={f.source} onChange={set("source")} />
                </Field>
                <Field label="State" htmlFor="wo-f-state">
                  <Select id="wo-f-state" options={[{ value: "all", label: "All" }, ...Object.keys(WO_STATES).map((k) => ({ value: k, label: (WO_STATES as Record<string, { label: string }>)[k]?.label ?? k }))]} value={f.state} onChange={set("state")} />
                </Field>
              </div>
            </FilterBar>
          </div>
          <Async query={list} what="work orders" id="wo-list">{() => rows.length ? (
            <div className="wo-table" id="wo-table-wrap">
              <DataTable
                id="wo-table"
                caption={`Work orders in ${project.name}`}
                columns={cols}
                rows={rows}
                rowKey={(w) => w.id}
                onRow={(w) => open(w.id)}
                sort={{ key: sort.k, dir: sort.dir }}
                onSort={(s) => setSort({ k: s.key, dir: s.dir })}
              />
              <div className="wo-foot">
                <span className="muted small" role="status">{showCount}</span>
                {serverTab && list.hasNextPage ? <Btn label={`Show ${Math.min(PAGE, matched - rows.length)} more of ${matched - rows.length}`} small id="wo-table-more" onClick={() => void list.fetchNextPage()} /> : null}
              </div>
            </div>
          ) : (
            <Empty
              id="wo-empty"
              icon="list"
              title="No work orders match"
              text={filtered || tab !== "all" ? "Clear the search or filters, or choose another tab." : "Submit the first work order to a Ready repo."}
              action={filtered ? <Btn label="Clear filters" id="wo-clear" onClick={clear} /> : undefined}
            />
          )}</Async>
        </Panel>
      )}
      <p className="hint wo-live">Updates live as work moves.</p>
    </div>
  );
}
