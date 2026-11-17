/**
 * Sortable, responsive table (legacy G.dataTable): header buttons sort, a row may open something, big lists show a page at a time. Under 640px rows become
 * cards labelled by column (the `data-label` attribute). The sort can be kept by the caller across renders (`sort` and `onSort`).
 */
import { useState, type ReactNode } from "react";
import { Empty } from "./primitives";

export interface SortCol<R> {
  key: string;
  label: string;
  /** true sorts by `row[key]`; a function gives the value to sort by. */
  sort?: boolean | ((r: R) => number | string);
  align?: "end";
  hideSmall?: boolean;
  width?: string;
  render?: (r: R) => ReactNode;
}
export interface SortState {
  key: string;
  dir: 1 | -1;
}

/** The one table component; `DataTable` is the same component under its design-system name. */
export function SortTable<R>({ id, caption, columns, rows, rowKey, rowId, rowClass, onRow, sort, onSort, pageSize, empty }: {
  id?: string;
  caption?: string;
  columns: SortCol<R>[];
  rows: R[];
  rowKey: (r: R) => string;
  /** DOM id for a row, when other code or tests address rows. */
  rowId?: (r: R) => string;
  /** Extra class for a row (for example the selected one). */
  rowClass?: (r: R) => string | undefined;
  onRow?: (r: R) => void;
  sort?: SortState | undefined;
  onSort?: (s: SortState) => void;
  pageSize?: number;
  empty?: { title: string; text?: string };
}) {
  const [own, setOwn] = useState<SortState | undefined>(undefined);
  const [shown, setShown] = useState(pageSize ?? 0);
  const cur = own ?? sort;
  if (!rows.length) return <div className="dtable-wrap" id={id}><Empty title={empty?.title ?? "Nothing here"} text={empty?.text ?? "No rows match."} /></div>;
  const val = (c: SortCol<R>, r: R): number | string => (typeof c.sort === "function" ? c.sort(r) : ((r as Record<string, unknown>)[c.key] as number | string));
  let list = rows.slice();
  const col = cur ? columns.find((c) => c.key === cur.key) : undefined;
  if (cur && col) list.sort((a, b) => { const x = val(col, a); const y = val(col, b); return (x > y ? 1 : x < y ? -1 : 0) * cur.dir; });
  const visible = shown ? list.slice(0, shown) : list;
  const pick = (c: SortCol<R>): void => {
    const active = cur?.key === c.key;
    const next: SortState = { key: c.key, dir: active ? (cur!.dir === 1 ? -1 : 1) : 1 };
    setOwn(next);
    onSort?.(next);
  };
  const prefix = id ? `${id}-sort-` : null;
  list = visible;
  return (
    <div className="dtable-wrap" id={id}>
      <div className="dtable-scroll">
        <table className={`dtable${onRow ? " is-clickable" : ""}`}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((c) => {
                const active = cur?.key === c.key;
                return (
                  <th key={c.key} scope="col" className={`${c.align === "end" ? "is-end" : ""}${c.hideSmall ? " hide-sm" : ""}`.trim() || undefined} style={c.width ? { width: c.width } : undefined} aria-sort={active ? (cur!.dir > 0 ? "ascending" : "descending") : undefined}>
                    {c.sort ? (
                      <button type="button" id={prefix ? prefix + c.key : undefined} className={`th-sort${active ? " is-active" : ""}`} onClick={() => pick(c)}>
                        {c.label}<span className="th-arrow" aria-hidden="true">{active ? (cur!.dir > 0 ? "↑" : "↓") : ""}</span>
                      </button>
                    ) : c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={rowKey(r)} data-key={rowKey(r)} id={rowId?.(r)} className={rowClass?.(r)} {...(onRow ? { tabIndex: 0, onClick: (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest("button,a,input,select,textarea")) return; onRow(r); }, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" && e.target === e.currentTarget) onRow(r); } } : {})}>
                {columns.map((c) => (
                  <td key={c.key} data-label={c.label} className={`${c.align === "end" ? "is-end" : ""}${c.hideSmall ? " hide-sm" : ""}`.trim() || undefined}>
                    {c.render ? c.render(r) : ((r as Record<string, unknown>)[c.key] as ReactNode) ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown && rows.length > shown ? (
        <div className="dtable-more">
          <button type="button" className="btn btn-sm" id={`${id ?? "dt"}-more`} onClick={() => setShown(shown + (pageSize ?? 0))}>{`Show ${Math.min(pageSize ?? 0, rows.length - shown)} more of ${rows.length - shown}`}</button>
        </div>
      ) : null}
    </div>
  );
}

export { SortTable as DataTable, type SortCol as Col };
