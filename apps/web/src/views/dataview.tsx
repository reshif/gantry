/**
 * The prototype's dataView for Evals, Trust and Learning: one flat panel body with a filter bar (search, selects, a count, Clear) over a DataTable.
 * Filter state is kept per table id across tab switches, like the prototype keeps it, and reset by Clear.
 */
import { useState, type ReactNode } from "react";
import { plural } from "../lib/plural";
import { Btn, FilterBar, SearchBox, Select } from "../ui/primitives";
import { DataTable, type Col } from "../ui/DataTable";

export interface DataFilter<R> {
  k: string;
  label: string;
  opts: Array<[string, string]>;
  fn: (row: R, value: string) => boolean;
}
interface Saved { q: string; f: Record<string, string> }
const SAVED = new Map<string, Saved>();
/** Test hook: forget every remembered filter. */
export const resetDataViews = (): void => SAVED.clear();

export function DataView<R>({ id, noun, rows, text, filters = [], columns, rowKey, rowId, onRow, pageSize, search = true, empty, caption }: {
  id: string;
  noun: string;
  rows: R[];
  text?: (r: R) => string;
  filters?: Array<DataFilter<R>>;
  columns: Array<Col<R>>;
  rowKey: (r: R) => string;
  rowId?: (r: R) => string;
  onRow?: (r: R) => void;
  pageSize?: number;
  search?: boolean;
  empty?: { title: string; text?: string };
  caption?: string;
}): ReactNode {
  const [st, setSt] = useState<Saved>(() => SAVED.get(id) ?? { q: "", f: {} });
  const put = (next: Saved): void => { SAVED.set(id, next); setSt(next); };
  const q = st.q.trim().toLowerCase();
  let list = rows;
  if (q && text) list = list.filter((r) => text(r).toLowerCase().includes(q));
  for (const f of filters) { const v = st.f[f.k]; if (v) list = list.filter((r) => f.fn(r, v)); }
  const active = !!(st.q || Object.values(st.f).some(Boolean));
  const clear = (): void => put({ q: "", f: {} });
  const count = plural(list.length, noun) + (list.length !== rows.length ? ` of ${rows.length}` : "");
  const hasBar = search || filters.length > 0;
  return (
    <div className="dataview" id={id}>
      {hasBar ? (
        <FilterBar label={`Filter ${noun}s`} count={count} actions={active ? <Btn label="Clear" small kind="ghost" id={`${id}-clear`} onClick={clear} /> : undefined}>
          {search ? <SearchBox id={`${id}-q`} value={st.q} onChange={(v) => put({ ...st, q: v })} placeholder="Search…" label={`Search ${noun}s`} /> : null}
          {filters.map((f) => (
            <label key={f.k} htmlFor={`${id}-f-${f.k}`}>
              <span>{f.label}</span>
              <Select id={`${id}-f-${f.k}`} value={st.f[f.k] ?? ""} options={[{ value: "", label: "All" }, ...f.opts.map(([value, label]) => ({ value, label }))]} onChange={(v) => put({ ...st, f: { ...st.f, [f.k]: v } })} />
            </label>
          ))}
        </FilterBar>
      ) : null}
      <DataTable sortHint noSortSelect id={`${id}-table`} caption={caption ?? noun} columns={columns} rows={list} rowKey={rowKey} {...(rowId ? { rowId } : {})} {...(onRow ? { onRow } : {})} {...(pageSize ? { pageSize, paged: true } : {})}
        empty={rows.length && active
          ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" id={`${id}-clear-empty`} onClick={clear} /> }
          : (empty ?? { title: "Nothing here yet", text: "Items will appear here when they exist." })} />
      {list.length && (!pageSize || list.length <= pageSize) ? <div className="tfoot"><span>{`1–${list.length} of ${list.length}`}</span></div> : null}
    </div>
  );
}

/** The prototype's compact "2d ago": one unit, rounded. */
export function agoP(t: number | null | undefined, now = Date.now()): string {
  if (!t) return "—";
  let d = (now - t) / 1000;
  const fut = d < 0;
  d = Math.abs(d);
  const [n, u] = d < 3600 ? [Math.max(1, Math.round(d / 60)), "m"] : d < 86400 ? [Math.round(d / 3600), "h"] : [Math.round(d / 86400), "d"];
  return fut ? `in ${n}${u}` : `${n}${u} ago`;
}
