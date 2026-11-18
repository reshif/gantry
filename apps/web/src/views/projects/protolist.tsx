/**
 * The Blueprint list: filter bar (search, selects, live count, Clear), sortable table, range footer with Prev / Next.
 * Prototype `dataView`. Sorting and paging happen here, before the rows reach DataTable, so a page is always the first N of the sorted list.
 */
import { useState, type ReactNode } from "react";
import { DataTable, type Col } from "../../ui/DataTable";
import { Btn, Empty, Field, SearchBox, Select } from "../../ui/primitives";

export interface ListFilter<R> {
  k: string;
  label: string;
  opts: Array<string | [string, string]>;
  fn?: (r: R, v: string) => boolean;
}
export interface ListCol<R> extends Omit<Col<R>, "sort"> {
  sort?: (r: R) => number | string;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

export function ProtoList<R>({ id, noun, rows, rowKey, text, filters = [], cols, pageSize = 12, search = true, searchLabel, searchPlaceholder, empty }: {
  id: string;
  noun: string;
  rows: R[];
  rowKey: (r: R) => string;
  text?: (r: R) => string;
  filters?: Array<ListFilter<R>>;
  cols: Array<ListCol<R>>;
  pageSize?: number;
  search?: boolean;
  searchLabel?: string;
  searchPlaceholder?: string;
  empty?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [f, setF] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | undefined>(undefined);
  const [page, setPage] = useState(0);
  let list = rows.slice();
  if (q) list = list.filter((r) => (text ? text(r) : JSON.stringify(r)).toLowerCase().includes(q.toLowerCase()));
  for (const fl of filters) {
    const v = f[fl.k];
    if (v) list = list.filter((r) => (fl.fn ? fl.fn(r, v) : String((r as Record<string, unknown>)[fl.k]) === v));
  }
  const sc = sort ? cols.find((c) => c.key === sort.key) : undefined;
  if (sort && sc?.sort) {
    const g = sc.sort;
    list.sort((a, b) => { const x = g(a); const y = g(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
  }
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, pages - 1);
  const vis = list.slice(cur * pageSize, (cur + 1) * pageSize);
  const filtered = !!(q || Object.values(f).some(Boolean));
  const clear = () => { setQ(""); setF({}); setPage(0); };
  return (
    <div id={id}>
      {search || filters.length ? (
        <div className="fbar" style={{ "--fs": filters.length } as React.CSSProperties}>
          {search ? (
<SearchBox value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder={searchPlaceholder ?? "Search…"} label={searchLabel ?? `Search ${noun}s`} />
          ) : null}
          {filters.map((fl) => (
            <Field key={fl.k} label={fl.label}>
              <Select id={`${id}-f-${fl.k}`} aria-label={fl.label} value={f[fl.k] ?? ""} onChange={(v) => { setF({ ...f, [fl.k]: v }); setPage(0); }} options={[{ value: "", label: "All" }, ...fl.opts.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o }))]} />
            </Field>
          ))}
          <div className="tail">
            <span className="count" aria-live="polite">{plural(total, noun) + (total !== rows.length ? ` of ${rows.length}` : "")}</span>
            {filtered ? <Btn small kind="ghost" label="Clear" onClick={clear} /> : null}
          </div>
        </div>
      ) : null}
      {!total ? (
        rows.length ? <Empty title="Nothing matches these filters" text="Loosen the search or clear the filters." action={<Btn label="Clear filters" onClick={clear} />} /> : <>{empty ?? <Empty title="Nothing here yet" text="Items will appear here when they exist." />}</>
      ) : (
        <>
          <DataTable
            id={`${id}-table`}
            caption={noun}
            columns={cols.map((c) => ({ ...c, sort: c.sort }))}
            rows={vis}
            rowKey={rowKey}
            linkRows
            {...(sort ? { sort } : {})}
            onSort={(s) => { setSort(s); setPage(0); }}
          />
          <div className="tfoot">
            <span>{`${cur * pageSize + 1}–${cur * pageSize + vis.length} of ${total}`}</span>
            {pages > 1 ? (
              <div className="row">
                <Btn small label="Prev" disabled={cur === 0} onClick={() => setPage(cur - 1)} />
                <span>{`Page ${cur + 1} / ${pages}`}</span>
                <Btn small label="Next" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} />
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
