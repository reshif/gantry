/**
 * Work orders (#work-orders): sortable, filterable table of the current project, ported from legacy/js/views/workorders.js.
 * Filtering, sorting and paging run on the server (GET /projects/{id}/work-orders); the classification card and class
 * override dialog live in work-orders/intake.tsx and the New work order dialog in work-orders/New.tsx.
 */
import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { WO_STATES, bayDef, classesOf, flowOf, fmt, woTotals } from "@gantry/domain";
import { useCan } from "../api/can";
import { api, get } from "../api/client";
import { useMe, useProject } from "../api/queries";
import { useProjectRepos } from "./floor/kit";
import type { Page, WorkOrder } from "../api/types";
import { Btn, Field, Select, StateChip, ViewHead } from "../ui/primitives";
import { Icon } from "../ui/Icon";
import { useActors } from "../ui/actors";
import { navigate } from "../lib/router";
import { pickProject } from "../lib/routes";
import { setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { useOpenTraveler } from "../shell/useTraveler";
import { ClassChip, EmptyState, classOf, useCatalog } from "./projects/kit";
import { projectSubmitBlock, useNewWorkOrder } from "./work-orders/New";

type SortKey = "id" | "title" | "cls" | "where" | "state" | "prio" | "age";
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

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function WorkOrdersView() {
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const actor = useActors();
  const open = useOpenTraveler();
  const newWo = useNewWorkOrder();
  const [f, setF] = useState<Filters>(NONE);
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "id", dir: -1 });
  const projectId = me ? pickProject(me, prefs.project) : null;
  const project = useProject(projectId).data ?? null;
  const repos = useProjectRepos(projectId);
  const submit = useCan("wo.submit", projectId ? { project: projectId } : {});
  const q = useDebounced(f.q.trim(), 250);

  const params = { q, cls: f.cls, where: f.where, repo: f.repo, prio: f.prio, source: f.source, state: f.state, sort: sort.k, dir: sort.dir > 0 ? "asc" : "desc" };
  const list = useInfiniteQuery({
    queryKey: ["workOrders", "table", projectId, params],
    queryFn: ({ pageParam }) => get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { ...params, limit: PAGE, cursor: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next || undefined,
    enabled: !!projectId,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const matched = list.data?.pages[0]?.total ?? 0;

  // unfiltered numbers for the header and the filter options
  const stat = useQuery({
    queryKey: ["workOrders", "stats", projectId],
    queryFn: async () => {
      const one = async (state: string) => (await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { state, limit: 1 })).total ?? 0;
      const [all, open, done, killed] = await Promise.all([one("all"), one("open"), one("done"), one("killed")]);
      return { all, open, done, killed };
    },
    enabled: !!projectId,
  });
  const live = useQuery({
    queryKey: ["workOrders", "intake", projectId],
    queryFn: async () => (await get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { state: "open", where: "intake", limit: 200 })).items,
    enabled: !!projectId,
  });
  const sources = useMemo(() => {
    const s = new Set<string>(rows.map((w) => w.source));
    if (f.source !== "all") s.add(f.source);
    return [...s].sort();
  }, [rows, f.source]);

  if (!me || !cat) return null;
  if (!projectId || !project) {
    return (
      <div className="view">
        <EmptyState title={projectId ? "Loading" : "No project"} text={projectId ? "Loading the work orders…" : "You do not have a project to show."} />
      </div>
    );
  }
  const fl = flowOf(cat, project);
  const atIntake = (live.data ?? []).filter((w) => w.station === 0 && !w.bay && w.state !== "killed" && w.gates?.G0G1 && w.gates.G0G1.status !== "passed");
  const filtered = (Object.keys(NONE) as Array<keyof Filters>).some((k) => (k === "q" ? f.q.trim() !== "" : f[k] !== "all"));
  const set = (k: keyof Filters) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const clear = () => setF(NONE);
  const block = projectSubmitBlock(me, project, repos);
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
  const th = (k: SortKey | null, label: string, o: { end?: boolean; hide?: boolean } = {}) => {
    const active = k !== null && sort.k === k;
    return (
      <th scope="col" className={`${o.end ? "is-end" : ""}${o.hide ? " hide-sm" : ""}`.trim() || undefined} aria-sort={active ? (sort.dir > 0 ? "ascending" : "descending") : undefined}>
        {k ? (
          <button type="button" id={`wo-sort-${k}`} className={`th-sort${active ? " is-active" : ""}`} onClick={() => setSort({ k, dir: active ? (sort.dir === 1 ? -1 : 1) : 1 })}>
            {label}
            <span className="th-arrow" aria-hidden="true">{active ? (sort.dir > 0 ? "↑" : "↓") : ""}</span>
          </button>
        ) : (
          label
        )}
      </th>
    );
  };
  const stats = stat.data;
  return (
    <div className="view wo-view">
      <div id="wo-head">
        <ViewHead
          kicker={`Project · ${project.name}`}
          title="Work orders"
          sub="Everything this project has taken on. Open a row for its traveler, or the record icon for the full lifecycle record."
          meta={[
            ["In flight", String(stats?.open ?? "…")],
            ["At Intake", String(atIntake.length)],
            ["Shipped", String(stats?.done ?? "…")],
            ["Killed", String(stats?.killed ?? "…")],
            ["All time", String(stats?.all ?? "…")],
          ]}
          actions={
            <>
              <Btn label="All records" icon="record" id="wo-records" onClick={() => { updatePrefs({ record: null }); navigate("record"); }} />
              <Btn label="New work order" kind="primary" icon="plus" id="wo-new" guard={submit.pending ? null : submit} disabledReason={submit.allowed ? block : null} onClick={() => newWo({ project: project.id })} />
            </>
          }
        />
      </div>
      {atIntake.length ? (
        <div className="callout wo-intake-note">
          <Icon name="chat" />
          <div>
            <strong>{`${atIntake.length} at Intake. `}</strong>
            They wait for their brief to be confirmed at G0+G1.{" "}
            <a href="#conversations" id="wo-to-conv">Open Conversations</a>
          </div>
        </div>
      ) : null}
      <div className="toolbar wo-toolbar">
        <div className="filters wo-filters">
          <Field label="Search" htmlFor="wo-q">
            <input id="wo-q" className="input" type="search" placeholder="Id or title" value={f.q} autoComplete="off" onChange={(e) => set("q")(e.target.value)} />
          </Field>
          <Field label="Class" htmlFor="wo-f-cls">
            <Select id="wo-f-cls" options={[{ value: "all", label: "All" }, ...classesOf(cat, project).map((c) => ({ value: c.id, label: c.name + (c.custom ? " (custom)" : "") }))]} value={f.cls} onChange={set("cls")} />
          </Field>
          <Field label="Station or bay" htmlFor="wo-f-where">
            <Select id="wo-f-where" options={[{ value: "all", label: "All" }, ...fl.stations.map((s) => ({ value: s.id, label: `${s.no} ${s.name}${s.enabled ? "" : " (off)"}` })), ...fl.bays.map((b) => ({ value: b.id, label: `Bay: ${b.name}` }))]} value={f.where} onChange={set("where")} />
          </Field>
          <Field label="Repo" htmlFor="wo-f-repo">
            <Select id="wo-f-repo" options={[{ value: "all", label: "All" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]} value={f.repo} onChange={set("repo")} />
          </Field>
          <Field label="Priority" htmlFor="wo-f-prio">
            <Select id="wo-f-prio" options={[{ value: "all", label: "All" }, ...PRIOS.map((p) => ({ value: p, label: p }))]} value={f.prio} onChange={set("prio")} />
          </Field>
          <Field label="Source" htmlFor="wo-f-source">
            <Select id="wo-f-source" options={[{ value: "all", label: "All" }, ...sources.map((s) => ({ value: s, label: s }))]} value={f.source} onChange={set("source")} />
          </Field>
          <Field label="State" htmlFor="wo-f-state">
            <Select id="wo-f-state" options={[{ value: "all", label: "All" }, ...Object.keys(WO_STATES).map((k) => ({ value: k, label: (WO_STATES as Record<string, { label: string }>)[k]?.label ?? k }))]} value={f.state} onChange={set("state")} />
          </Field>
        </div>
        <div className="wo-count">
          <span className="muted small">{`${rows.length} of ${matched} shown`}</span>
          {filtered ? <Btn label="Clear filters" small kind="ghost" id="wo-clear-top" onClick={clear} /> : null}
        </div>
      </div>
      {rows.length ? (
        <div className="dtable-wrap wo-table" id="wo-table">
          <div className="dtable-scroll">
            <table className="dtable is-clickable">
              <caption className="sr-only">{`Work orders in ${project.name}`}</caption>
              <thead>
                <tr>
                  {th("id", "Work order")}
                  {th("title", "Title")}
                  {th("cls", "Class")}
                  {th("where", "Station / bay")}
                  {th("state", "State")}
                  {th(null, "Repo", { hide: true })}
                  {th("prio", "Pri")}
                  {th(null, "Requested", { hide: true })}
                  {th("age", "Age", { end: true })}
                  {th(null, "Spend", { end: true, hide: true })}
                  {th(null, "Open")}
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const killed = w.state === "killed";
                  const age = fmt.dur(Date.now() - w.createdAt);
                  const cost = woTotals(w).cost;
                  return (
                    <tr key={w.id} data-key={w.id} tabIndex={0} onClick={(e) => { if (!(e.target as HTMLElement).closest("button,a,input,select,textarea")) open(w.id); }} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(w.id); }}>
                      <td data-label="Work order"><span className={`mono strong wo-id${killed ? " is-killed" : ""}`}>{w.id}</span></td>
                      <td data-label="Title">
                        <span className={`wo-title${killed ? " is-killed" : ""}`}>
                          {w.title}
                          {w.parent ? <span className="muted small">{` · child of ${w.parent}`}</span> : null}
                          {w.children?.length ? <span className="muted small">{` · ${w.children.length} children`}</span> : null}
                        </span>
                      </td>
                      <td data-label="Class">
                        <span className="wo-cls">
                          <ClassChip cls={classOf(cat, project, w.cls)} small />
                          {w.clsOverridden ? (
                            <span className="wo-ovr" title={`Class overridden from ${classOf(cat, project, w.clsOverridden.from).name}`}>
                              <Icon name="swap" />
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td data-label="Station / bay">{whereCell(w)}</td>
                      <td data-label="State"><StateChip state={w.state} /></td>
                      <td data-label="Repo" className="hide-sm"><span className="mono small">{w.repo}</span></td>
                      <td data-label="Pri"><span className={`chip wo-prio wo-prio-${w.priority}`}>{w.priority}</span></td>
                      <td data-label="Requested" className="hide-sm">
                        <span className="small wo-by">
                          {actor(w.requestedBy).name}
                          <span className="muted">{` via ${w.source}`}</span>
                        </span>
                      </td>
                      <td data-label="Age" className="is-end"><span className="mono">{age}</span></td>
                      <td data-label="Spend" className="is-end hide-sm"><span className="mono">{fmt.money(cost)}</span></td>
                      <td data-label="Open">
                        <span className="wo-acts">
                          <button type="button" className="icon-btn icon-btn-sm" id={`wo-rec-${w.id}`} aria-label={`Open full record for ${w.id}`} data-tip="Full record" onClick={(e) => { e.stopPropagation(); navigate("record", w.id); }}>
                            <Icon name="record" />
                          </button>
                          <button type="button" className="icon-btn icon-btn-sm" id={`wo-conv-${w.id}`} aria-label={`Open intake conversation for ${w.id}`} data-tip="Intake conversation" onClick={(e) => { e.stopPropagation(); setProject(w.project); updatePrefs({ openConversation: w.id }); navigate("conversations"); }}>
                            <Icon name="chat" />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.hasNextPage ? (
            <div className="dtable-more">
              <Btn label={`Show ${Math.min(PAGE, matched - rows.length)} more of ${matched - rows.length}`} small id="wo-table-more" onClick={() => void list.fetchNextPage()} />
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState
          id="wo-empty"
          icon="list"
          title={list.isPending ? "Loading" : "No work orders match"}
          text={list.isPending ? "Loading the work orders…" : filtered ? "Clear the search or filters." : "Submit the first work order to a Ready repo."}
          action={filtered ? <Btn label="Clear filters" id="wo-clear" onClick={clear} /> : undefined}
        />
      )}
    </div>
  );
}

