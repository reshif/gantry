/** The record picker: every work order the viewer may see, with search, project and stage filters (legacy record.js picker). */
import { qk } from "../../api/keys";
import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { api, get } from "../../api/client";
import { useMe, useProject } from "../../api/queries";
import type { Page, WorkOrder } from "../../api/types";
import { pickProject } from "../../lib/routes";
import { navigate } from "../../lib/router";
import { setProject, usePrefs } from "../../lib/prefs";
import { Field, Select, Segmented, StateChip, ViewHead } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { ClassChip, EmptyState, classOf, useCatalog } from "../projects/kit";
import { bayLabel, stName } from "../traveler/model";

type SortKey = "id" | "title" | "cls" | "where" | "state" | "age";
const STAGES = [{ id: "all", label: "All" }, { id: "intake", label: "Intake" }, { id: "flight", label: "In flight" }, { id: "done", label: "Shipped" }, { id: "issues", label: "Incidents" }, { id: "killed", label: "Killed" }];
const PAGE = 40;

export function Picker({ note }: { note?: string | null }) {
  const me = useMe();
  const prefs = usePrefs();
  const cat = useCatalog();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [stage, setStage] = useState("all");
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "id", dir: -1 });
  const projects = me?.projects ?? [];
  const current = me ? pickProject(me, prefs.project) : null;
  const [pid, setPid] = useState<string | null>(null);
  const projectId = pid ?? current;
  const project = useProject(projectId).data ?? null;
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const params = { q: dq, sort: sort.k, dir: sort.dir > 0 ? "asc" : "desc", ...(stage === "intake" ? { where: "intake", state: "open" } : stage === "flight" ? { state: "open" } : stage === "done" ? { state: "done" } : stage === "killed" ? { state: "killed" } : {}) };
  const list = useInfiniteQuery({
    queryKey: qk.woRecords(projectId, params),
    queryFn: ({ pageParam }) => get<Page<WorkOrder>>(api(`projects/${encodeURIComponent(projectId ?? "")}/work-orders`), { ...params, limit: PAGE, cursor: pageParam || undefined }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next || undefined,
    enabled: !!projectId,
    placeholderData: keepPreviousData,
  });
  const loaded = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const rows = stage === "issues" ? loaded.filter((w) => (w.outcomes ?? []).some((o) => o.kind === "revert" || o.kind === "incident")) : loaded;
  const total = list.data?.pages[0]?.total ?? 0;
  if (!me || !cat) return <div className="view rec-view rec-picker" />;
  const open = (w: WorkOrder) => {
    setProject(w.project);
    navigate("record", w.id);
  };
  const where = (w: WorkOrder): string => (w.state === "done" ? "Shipped" : w.state === "killed" ? "Killed" : w.bay ? `In ${bayLabel(cat, w.bay)}` : `${cat.stations[w.station]?.no ?? ""} ${stName(cat, cat.stations[w.station]?.id)}`.trim());
  const th = (k: SortKey | null, label: string, o: { end?: boolean; hide?: boolean } = {}) => {
    const active = k !== null && sort.k === k;
    return (
      <th scope="col" className={`${o.end ? "is-end" : ""}${o.hide ? " hide-sm" : ""}`.trim() || undefined} aria-sort={active ? (sort.dir > 0 ? "ascending" : "descending") : undefined}>
        {k ? (
          <button type="button" id={`rec-pick-sort-${k}`} className={`th-sort${active ? " is-active" : ""}`} onClick={() => setSort({ k, dir: active ? (sort.dir === 1 ? -1 : 1) : 1 })}>
            {label}
            <span className="th-arrow" aria-hidden="true">{active ? (sort.dir > 0 ? "↑" : "↓") : ""}</span>
          </button>
        ) : (
          label
        )}
      </th>
    );
  };
  return (
    <div className="view rec-view rec-picker">
      <ViewHead
        title="Work order records"
        sub="Everything about one work order in one place, from the request to what happened after release. Pick one to open."
        meta={[["Records", String(total)], ["Shown", String(rows.length)]]}
      />
      {note ? (
        <div className="callout callout-warn" role="status">
          <Icon name="lock" />
          <div>{note}</div>
        </div>
      ) : null}
      <div className="toolbar rec-pick-bar">
        <Field label="Search" htmlFor="rec-pick-q">
          <input id="rec-pick-q" className="input" type="search" placeholder="Id or title" value={q} autoComplete="off" onChange={(e) => setQ(e.target.value)} />
        </Field>
        <Field label="Project" htmlFor="rec-pick-project">
          <Select id="rec-pick-project" options={projects.map((p) => ({ value: p.id, label: p.name + (p.status === "archived" ? " (archived)" : "") }))} value={projectId} onChange={(v) => setPid(v)} />
        </Field>
        <div className="field">
          <span className="field-label" id="rec-pick-stage-l">Stage</span>
          <Segmented name="rec-pick-stage" label="Stage" items={STAGES} value={stage} onChange={setStage} />
        </div>
        <span className="muted small rec-pick-count">{`${rows.length} of ${total}`}</span>
      </div>
      {rows.length && project ? (
        <div className="dtable-wrap" id="rec-pick-table">
          <div className="dtable-scroll">
            <table className="dtable is-clickable">
              <caption className="sr-only">Work order records</caption>
              <thead>
                <tr>
                  {th("id", "Work order")}
                  {th("title", "Title")}
                  {th("cls", "Class")}
                  {th("where", "Where")}
                  {th("state", "State")}
                  {th("age", "Updated", { end: true, hide: true })}
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id} data-key={w.id} tabIndex={0} onClick={(e) => { if (!(e.target as HTMLElement).closest("button,a")) open(w); }} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) open(w); }}>
                    <td data-label="Work order">
                      <button type="button" className="linkish mono strong" id={`rec-pick-${w.id}`} onClick={() => open(w)}>{w.id}</button>
                    </td>
                    <td data-label="Title">{w.title}</td>
                    <td data-label="Class"><ClassChip cls={classOf(cat, project, w.cls)} small /></td>
                    <td data-label="Where"><span className="small">{where(w)}</span></td>
                    <td data-label="State"><StateChip state={w.state} /></td>
                    <td data-label="Updated" className="is-end hide-sm"><span className="mono small">{fmt.ago(lastAt(w), Date.now())}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.hasNextPage ? (
            <div className="dtable-more">
              <button type="button" className="btn btn-sm" id="rec-pick-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? "Loading…" : "Show more"}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState title="No records match" text="Clear the search or pick another project or stage." />
      )}
    </div>
  );
}
const lastAt = (w: WorkOrder): number => {
  const e = w.history[w.history.length - 1];
  return Math.max(e?.endedAt || 0, e?.startedAt || 0, w.doneAt || 0, w.createdAt);
};
